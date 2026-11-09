/**
 * Telegram Channel -> RSS  ·  Cloudflare Worker  (D1 + HTMLRewriter)
 * ---------------------------------------------------------------
 * Sources (auto-fallback):
 *   1. Bot API webhook (/hook)    -> D1   (bot must be admin of the channel)
 *   2. Public preview t.me/s/<ch> -> D1   (backfill + channels without bot access)
 *
 * Auth: feed routes need env.API_KEY via ?key= (also ?token= / ?access_token=)
 *       or "Authorization: Bearer <key>".
 *       Webhook is guarded by Telegram's X-Telegram-Bot-Api-Secret-Token header
 *       (= env.WEBHOOK_SECRET).
 *       Media URLs embedded in feeds are HMAC-signed, so the bot token never leaks.
 *
 * Routes
 *   GET  /                           help
 *   GET  /health
 *   GET  /rss/:channel               RSS 2.0         (?key=)
 *   GET  /atom/:channel              Atom 1.0        (?key=)
 *   GET  /rss?channel=  | /feed.xml?channel= | /atom?channel=   (?key=)
 *   GET  /feeds                      known channels  (?key=)
 *   GET  /media/:fileId?sig=         signed media proxy
 *   POST /admin/setup-webhook        register webhook (?key=)
 *   POST /hook                       Telegram webhook sink
 *
 * Feed params: ?limit= ?days= ?pages= ?refresh=1 ?format=atom
 *   (?refresh=1&pages=N doubles as a backfill)
 */

const DEFAULT_MAX_POSTS = 5000; // per channel, enforced by the cron cleanup
const DEFAULT_CACHE_TTL = 300; // seconds
const DEFAULT_LIMIT = 50;
const DEFAULT_PAGES = 2;
const DEFAULT_FEED_DAYS = 30; // feed window and retention
const WEBHOOK_FRESH_MS = 3600_000;

const RSS_CONTENT_TYPE = 'application/rss+xml; charset=utf-8';
const ATOM_CONTENT_TYPE = 'application/atom+xml; charset=utf-8';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      ...extraHeaders,
    },
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const escapeXml = (value) => escapeHtml(value).replace(/'/g, '&apos;');

function cdata(value) {
  return `<![CDATA[${String(value ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

function stripTags(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** &amp; is decoded last so "&amp;lt;" stays "&lt;" */
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** compares SHA-256 digests, so neither content nor length leaks */
async function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

/** short HMAC used to sign media URLs */
async function sign(env, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(env.API_KEY)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const inWindow = (post, cutoff) => {
  const ts = Date.parse(post.date);
  return !Number.isFinite(ts) || ts >= cutoff;
};

/* ------------------------------------------------------------------ */
/* authorization                                                        */
/* ------------------------------------------------------------------ */

async function isAuthorized(request, url, env) {
  const expected = String(env.API_KEY || '').trim();
  if (!expected) return false;

  const auth = request.headers.get('authorization') || '';
  const candidates = [
    /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : '',
    url.searchParams.get('key'),
    url.searchParams.get('token'),
    url.searchParams.get('access_token'),
  ].filter(Boolean);

  for (const k of candidates) if (await safeEq(k, expected)) return true;
  return false;
}

function unauthorized() {
  return json(
    {
      ok: false,
      error: 'unauthorized',
      hint: 'Provide the key via ?key=... or Authorization: Bearer <key>.',
    },
    401,
    { 'www-authenticate': 'Bearer realm="telegram-rss"' },
  );
}

/* ------------------------------------------------------------------ */
/* channel references                                                   */
/* ------------------------------------------------------------------ */

function publicId(id) {
  const s = String(id ?? '');
  return s.startsWith('-100') ? s.slice(4) : s.replace(/^-/, '');
}

/** Accepts: @name, name, t.me/name, t.me/s/name, t.me/c/12345[/678], -1001234567890, 12345 */
function normalizeChannelRef(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i, '').replace(/^\/+/, '');
  s = s.replace(/^s\//i, '').replace(/^c\//i, '').replace(/^@/, '');
  s = s.split(/[/?#]/)[0];

  if (/^-?\d+$/.test(s)) {
    const pid = publicId(s);
    return {
      kind: 'numeric',
      value: pid,
      chatIds: [`-100${pid}`, pid],
      username: '',
      link: `https://t.me/c/${pid}`,
      previewUrl: `https://t.me/s/c/${pid}`,
    };
  }

  const username = s.toLowerCase();
  return {
    kind: 'username',
    value: username,
    chatIds: [],
    username,
    link: `https://t.me/${username}`,
    previewUrl: `https://t.me/s/${username}`,
  };
}

/** canonical storage key: public username, otherwise the numeric channel id */
function channelKey(chatId, username) {
  const u = String(username || '').trim().toLowerCase();
  return u || `id:${publicId(chatId)}`;
}

/* ------------------------------------------------------------------ */
/* D1 layer                                                             */
/* ------------------------------------------------------------------ */

async function batchChunked(env, stmts) {
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

function channelStmt(env, ch, { fetchedAt = null, webhookAt = null } = {}) {
  return env.DB.prepare(
    `INSERT INTO channels (key, chat_id, username, title, description, photo, link, fetched_at, webhook_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(key) DO UPDATE SET
       chat_id     = COALESCE(NULLIF(excluded.chat_id, ''),    channels.chat_id),
       username    = COALESCE(NULLIF(excluded.username, ''),   channels.username),
       title       = COALESCE(NULLIF(excluded.title, ''),      channels.title),
       description = COALESCE(NULLIF(excluded.description, ''), channels.description),
       photo       = COALESCE(excluded.photo,                  channels.photo),
       link        = COALESCE(NULLIF(excluded.link, ''),       channels.link),
       fetched_at  = COALESCE(excluded.fetched_at,             channels.fetched_at),
       webhook_at  = COALESCE(excluded.webhook_at,             channels.webhook_at),
       updated_at  = excluded.updated_at`,
  ).bind(
    ch.key,
    ch.chat_id || '',
    ch.username || '',
    ch.title || '',
    ch.description || '',
    ch.photo || null,
    ch.link || '',
    fetchedAt,
    webhookAt,
    Date.now(),
  );
}

/** webhook rows always win; preview rows never overwrite a webhook row */
function postStmt(env, chan, p, fromWebhook) {
  return env.DB.prepare(
    `INSERT INTO posts (chan, id, chat_id, date, link, text, html, author, image, file_id, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(chan, id) DO UPDATE SET
       date    = excluded.date,
       link    = excluded.link,
       text    = excluded.text,
       html    = excluded.html,
       author  = excluded.author,
       image   = COALESCE(excluded.image,   posts.image),
       file_id = COALESCE(excluded.file_id, posts.file_id),
       source  = excluded.source
     ${fromWebhook ? '' : "WHERE posts.source <> 'webhook'"}`,
  ).bind(
    chan,
    p.id,
    p.chat_id || '',
    p.date,
    p.link || '',
    p.text || '',
    p.html || '',
    p.author || '',
    p.image || null,
    p.file_id || null,
    p.source,
  );
}

async function findChannel(env, ref) {
  const row =
    ref.kind === 'username'
      ? await env.DB.prepare('SELECT * FROM channels WHERE key = ?1').bind(ref.username).first()
      : await env.DB.prepare('SELECT * FROM channels WHERE key = ?1 OR chat_id = ?2 LIMIT 1')
          .bind(`id:${ref.value}`, ref.chatIds[0])
          .first();
  return row || null;
}

async function getPosts(env, chan, cutoff, limit) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM posts WHERE chan = ?1 AND date >= ?2 ORDER BY id DESC LIMIT ?3',
  )
    .bind(chan, new Date(cutoff).toISOString(), limit)
    .all();
  return results || [];
}

async function persistPreview(env, channel, posts) {
  await batchChunked(env, [
    channelStmt(env, channel, { fetchedAt: Date.now() }),
    ...posts.map((p) => postStmt(env, channel.key, p, false)),
  ]);
}

/** cron: drop posts outside the retention window and above the per-channel cap */
async function cleanup(env) {
  const days = num(env.FEED_DAYS, DEFAULT_FEED_DAYS);
  const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const max = num(env.MAX_POSTS, DEFAULT_MAX_POSTS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM posts WHERE date < ?1').bind(cutoffIso),
    env.DB.prepare(
      `DELETE FROM posts WHERE (chan, id) IN (
         SELECT chan, id FROM (
           SELECT chan, id, ROW_NUMBER() OVER (PARTITION BY chan ORDER BY id DESC) AS rn FROM posts
         ) WHERE rn > ?1)`,
    ).bind(max),
  ]);
}

/* ------------------------------------------------------------------ */
/* Telegram webhook payload                                             */
/* ------------------------------------------------------------------ */

function renderEntities(text, entities) {
  const source = String(text ?? '');
  if (!source) return '';
  if (!Array.isArray(entities) || entities.length === 0) return escapeHtml(source);

  const out = [];
  let pos = 0;
  const sorted = [...entities].sort((a, b) => (a.offset || 0) - (b.offset || 0));

  for (const entity of sorted) {
    const offset = entity.offset || 0;
    const length = entity.length || 0;
    if (offset < pos || length <= 0) continue; // overlapping entities are skipped
    out.push(escapeHtml(source.slice(pos, offset)));
    const frag = source.slice(offset, offset + length);
    const f = escapeHtml(frag);

    switch (entity.type) {
      case 'bold': out.push(`<b>${f}</b>`); break;
      case 'italic': out.push(`<i>${f}</i>`); break;
      case 'underline': out.push(`<u>${f}</u>`); break;
      case 'strikethrough': out.push(`<s>${f}</s>`); break;
      case 'code': out.push(`<code>${f}</code>`); break;
      case 'pre': out.push(`<pre>${f}</pre>`); break;
      case 'text_link': out.push(`<a href="${escapeHtml(entity.url || '#')}">${f}</a>`); break;
      case 'mention': out.push(`<a href="https://t.me/${escapeHtml(frag.replace(/^@/, ''))}">${f}</a>`); break;
      case 'hashtag': out.push(`<a href="https://t.me/hashtag/${escapeHtml(frag.replace(/^#/, ''))}">${f}</a>`); break;
      case 'url': out.push(`<a href="${f}">${f}</a>`); break;
      default: out.push(f);
    }
    pos = offset + length;
  }
  out.push(escapeHtml(source.slice(pos)));
  return out.join('');
}

function channelLink(chat) {
  return chat.username ? `https://t.me/${chat.username}` : `https://t.me/c/${publicId(chat.id)}`;
}

function normalizeTelegramPost(msg) {
  const chat = msg.chat || {};
  const text = msg.text || msg.caption || '';
  const photo = Array.isArray(msg.photo) && msg.photo.length
    ? msg.photo.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a))
    : null;

  return {
    id: Number(msg.message_id),
    chat_id: String(chat.id ?? ''),
    date: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    link: `${channelLink(chat)}/${msg.message_id}`,
    text,
    html: renderEntities(text, msg.entities || msg.caption_entities),
    author: chat.title || chat.username || '',
    image: null,
    file_id: photo?.file_id || null, // photos only; served via the signed /media proxy
    source: 'webhook',
  };
}

/* ------------------------------------------------------------------ */
/* preview scraping (t.me/s/<channel>) with HTMLRewriter                */
/* ------------------------------------------------------------------ */

const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins',
  'code', 'pre', 'br', 'span', 'blockquote', 'tg-emoji', 'tg-spoiler',
]);

const TEXT_ROOT = '.tgme_widget_message_text:not(.js-message_reply_text)';
const bgImage = (style) => /url\(['"]?([^'")]+)['"]?\)/i.exec(style || '')?.[1] || null;

/**
 * Streams the page once. Message body HTML is rebuilt from scratch:
 * whitelisted tags only, no attributes except a validated https? href on <a>.
 */
async function parsePreview(res, ref) {
  const posts = [];
  const raw = { title: '', description: '', username: '', photo: null };
  let cur = null;

  await new HTMLRewriter()
    .on('.tgme_widget_message[data-post]', {
      element(el) {
        const parts = (el.getAttribute('data-post') || '').split('/');
        const id = Number(parts[parts.length - 1]);
        if (!id) { cur = null; return; }
        const isPrivate = parts[0] === 'c' && parts.length >= 3;
        cur = {
          id,
          chat_id: isPrivate ? parts[1] : '',
          username: !isPrivate && parts.length === 2 ? parts[0] : '',
          date: '', link: '', html: '', image: null, textState: 0, // 0 idle, 1 open, 2 done
        };
        posts.push(cur);
      },
    })
    // permalink + timestamp
    .on('a.tgme_widget_message_date', {
      element(el) { if (cur) cur.link = el.getAttribute('href') || ''; },
    })
    .on('.tgme_widget_message_date time', {
      element(el) { if (cur) cur.date = el.getAttribute('datetime') || ''; },
    })
    // first image / video thumbnail
    .on('.tgme_widget_message_photo_wrap, .tgme_widget_message_video_thumb, .tgme_widget_message_roundvideo_thumb', {
      element(el) { if (cur && !cur.image) cur.image = bgImage(el.getAttribute('style')); },
    })
    // message text root: opens/closes capture; text chunks include nested text
    .on(TEXT_ROOT, {
      element(el) {
        const post = cur;
        if (!post || post.textState !== 0) return;
        post.textState = 1;
        el.onEndTag(() => { post.textState = 2; });
      },
      text(t) { if (cur?.textState === 1) cur.html += t.text; },
    })
    // descendants of the text root: re-emit whitelisted tags without attributes
    .on(`${TEXT_ROOT} *`, {
      element(el) {
        const post = cur;
        if (!post || post.textState !== 1) return;
        const name = el.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(name)) return;

        let open = `<${name}`;
        if (name === 'a') {
          const href = (el.getAttribute('href') || '').trim();
          if (!/^https?:\/\//i.test(href)) return; // drop internal links, keep their text
          open += ` href="${escapeHtml(decodeEntities(href))}"`;
        }
        post.html += `${open}>`;
        if (name === 'br') return; // void element
        el.onEndTag(() => { if (post.textState === 1) post.html += `</${name}>`; });
      },
    })
    // channel header
    .on('.tgme_channel_info_header_title', { text(t) { raw.title += t.text; } })
    .on('.tgme_channel_info_description', { text(t) { raw.description += t.text; } })
    .on('.tgme_channel_info_header_username a', { text(t) { raw.username += t.text; } })
    .on('.tgme_page_photo_image img', {
      element(el) { if (!raw.photo) raw.photo = el.getAttribute('src'); },
    })
    .transform(res)
    .text(); // consume the stream

  let previewUsername = '';
  const out = posts.map((p) => {
    if (p.username && !previewUsername) previewUsername = p.username;
    const fallback = p.chat_id
      ? `https://t.me/c/${p.chat_id}/${p.id}`
      : p.username
        ? `https://t.me/${p.username}/${p.id}`
        : `${ref.link}/${p.id}`;
    const ts = Date.parse(p.date);
    return {
      id: p.id,
      chat_id: p.chat_id,
      date: new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString(),
      link: /^https?:\/\/t\.me\/.+\/\d+$/.test(p.link) ? p.link : fallback,
      text: decodeEntities(stripTags(p.html)),
      html: p.html,
      author: '',
      image: p.image,
      file_id: null,
      source: 'preview',
    };
  });

  return {
    posts: out,
    meta: {
      title: decodeEntities(stripTags(raw.title)),
      description: decodeEntities(stripTags(raw.description)),
      photo: raw.photo,
      username: previewUsername || decodeEntities(stripTags(raw.username)).replace(/^@/, '').toLowerCase(),
    },
  };
}

async function fetchPreview(ref, pages, cutoff) {
  const byId = new Map();
  let meta = { title: '', description: '', photo: null, username: '' };
  let url = ref.previewUrl;

  for (let page = 0; page < pages; page++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; TelegramRssWorker/2.0; +https://workers.dev)',
          accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch {
      break;
    }
    if (!res.ok) break;

    const parsed = await parsePreview(res, ref);
    if (!parsed.posts.length) break;
    if (page === 0) meta = parsed.meta;
    for (const p of parsed.posts) byId.set(p.id, p);

    // Telegram lists oldest -> newest on a page: continue from the *smallest* id
    const oldest = parsed.posts.reduce((a, b) => (b.id < a.id ? b : a));
    if (Date.parse(oldest.date) < cutoff) break;
    url = `${ref.previewUrl}?before=${oldest.id}`;
  }

  return { posts: [...byId.values()].filter((p) => inWindow(p, cutoff)), meta };
}

function buildChannel(preview, stored, ref) {
  const username = preview.meta.username || stored?.username || ref.username;
  const chat_id = stored?.chat_id || (ref.kind === 'numeric' ? ref.chatIds[0] : '');
  return {
    key: stored?.key || channelKey(chat_id, username),
    chat_id,
    username,
    title: preview.meta.title || stored?.title || `@${ref.username || ref.value}`,
    description: preview.meta.description || stored?.description || '',
    photo: preview.meta.photo || stored?.photo || null,
    link: stored?.link || ref.link,
  };
}

/* ------------------------------------------------------------------ */
/* feed rendering                                                       */
/* ------------------------------------------------------------------ */

function itemTitle(post) {
  const text = (post.text || '').trim();
  if (!text) return `Post #${post.id}`;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function itemBody(post) {
  const img = post.image ? `<p><img src="${escapeHtml(post.image)}" alt=""></p>` : '';
  return img + (post.html || escapeHtml(post.text || ''));
}

function renderRss(channel, posts, selfUrl) {
  const title = channel.title || 'Telegram channel';
  const link = channel.link || 'https://t.me';
  const description = channel.description || `Telegram channel feed — ${title}`;
  const built = posts.length ? new Date(posts[0].date) : new Date();

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">',
    '<channel>',
    `<title>${escapeXml(title)}</title>`,
    `<link>${escapeXml(link)}</link>`,
    `<description>${escapeXml(description)}</description>`,
    `<lastBuildDate>${built.toUTCString()}</lastBuildDate>`,
    '<generator>telegram-rss-worker</generator>',
    `<atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>`,
    `<atom:link href="${escapeXml(link)}" rel="alternate" type="text/html"/>`,
  ];
  if (channel.photo) {
    parts.push(
      `<image><url>${escapeXml(channel.photo)}</url><title>${escapeXml(title)}</title><link>${escapeXml(link)}</link></image>`,
    );
  }

  for (const post of posts) {
    parts.push(
      '<item>',
      `<title>${escapeXml(itemTitle(post))}</title>`,
      `<link>${escapeXml(post.link)}</link>`,
      `<guid isPermaLink="true">${escapeXml(post.link)}</guid>`,
      `<pubDate>${new Date(post.date).toUTCString()}</pubDate>`,
      `<description>${cdata(escapeHtml(post.text || ''))}</description>`,
      `<content:encoded>${cdata(itemBody(post))}</content:encoded>`,
      `<dc:creator>${escapeXml(post.author || title)}</dc:creator>`,
    );
    if (post.image) parts.push(`<media:content url="${escapeXml(post.image)}" medium="image"/>`);
    parts.push('</item>');
  }

  parts.push('</channel>', '</rss>');
  return parts.join('\n');
}

function renderAtom(channel, posts, selfUrl) {
  const title = channel.title || 'Telegram channel';
  const link = channel.link || 'https://t.me';
  const updated = (posts.length ? new Date(posts[0].date) : new Date()).toISOString();

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<id>${escapeXml(link)}</id>`,
    `<title>${escapeXml(title)}</title>`,
    `<subtitle>${escapeXml(channel.description || '')}</subtitle>`,
    `<link href="${escapeXml(selfUrl)}" rel="self"/>`,
    `<link href="${escapeXml(link)}" rel="alternate"/>`,
    `<updated>${updated}</updated>`,
    '<generator>telegram-rss-worker</generator>',
  ];

  for (const post of posts) {
    const iso = new Date(post.date).toISOString();
    parts.push(
      '<entry>',
      `<title>${escapeXml(itemTitle(post))}</title>`,
      `<link href="${escapeXml(post.link)}"/>`,
      `<id>${escapeXml(post.link)}</id>`,
      `<updated>${iso}</updated>`,
      `<published>${iso}</published>`,
      `<author><name>${escapeXml(post.author || title)}</name></author>`,
      `<content type="html">${cdata(itemBody(post))}</content>`,
      `<summary>${cdata(post.text || '')}</summary>`,
      '</entry>',
    );
  }

  parts.push('</feed>');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* routes                                                               */
/* ------------------------------------------------------------------ */

const cacheRequest = (origin, format, value) =>
  new Request(`${origin}/__cache/${format}/${encodeURIComponent(value)}`);

async function handleFeed(env, ctx, url, route) {
  const ref = normalizeChannelRef(route.channel);
  if (!ref.value) return json({ ok: false, error: 'missing channel' }, 400);
  const format = route.format;

  const limit = Math.min(num(url.searchParams.get('limit'), DEFAULT_LIMIT), 500);
  const pages = Math.min(num(url.searchParams.get('pages'), DEFAULT_PAGES), 10);
  const force = url.searchParams.get('refresh') === '1';
  const defaultDays = num(env.FEED_DAYS, DEFAULT_FEED_DAYS);
  const days = num(url.searchParams.get('days'), defaultDays);
  const cutoff = Date.now() - days * 86_400_000;

  // only the default variant is cached so a webhook can purge it exactly
  const cacheable = !force && days === defaultDays && limit === DEFAULT_LIMIT;
  const cacheKey = cacheRequest(url.origin, format, ref.value);
  if (cacheable) {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  }

  let channel = await findChannel(env, ref);
  let posts = channel ? await getPosts(env, channel.key, cutoff, limit) : [];

  // scrape when forced, empty, or stale -- unless a webhook is keeping the channel fresh
  const now = Date.now();
  const ttlMs = num(env.CACHE_TTL, DEFAULT_CACHE_TTL) * 1000;
  const webhookFresh = channel?.webhook_at && now - channel.webhook_at < WEBHOOK_FRESH_MS;
  const scrapeStale = !channel?.fetched_at || now - channel.fetched_at > ttlMs;

  // private channels (no username) have no public preview: they only exist via the webhook
  const isPrivate = ref.kind === 'numeric' && !channel?.username;

  if (!isPrivate && (force || !posts.length || (!webhookFresh && scrapeStale))) {
    // a numeric ref to a channel with a known username scrapes via the username
    const scrapeRef = channel?.username ? normalizeChannelRef(channel.username) : ref;
    const preview = await fetchPreview(scrapeRef, pages, cutoff);
    if (preview.posts.length || preview.meta.title) {
      channel = buildChannel(preview, channel, ref);
      await persistPreview(env, channel, preview.posts);
      posts = await getPosts(env, channel.key, cutoff, limit);
    } else if (!channel) {
      return json({ ok: false, error: 'channel not found or has no public preview' }, 404);
    }
  }

  if (!channel) {
    return json(
      {
        ok: false,
        error: 'unknown private channel',
        hint: 'Add the bot as a channel admin and register the webhook; the channel appears after its first post.',
      },
      404,
    );
  }

  // sign media URLs for webhook photos (bot token never leaves the worker)
  if (env.BOT_TOKEN) {
    posts = await Promise.all(
      posts.map(async (p) =>
        p.image || !p.file_id
          ? p
          : { ...p, image: `${url.origin}/media/${encodeURIComponent(p.file_id)}?sig=${await sign(env, p.file_id)}` },
      ),
    );
  }

  // self link: never contains the key
  const self = new URL(url.origin + url.pathname);
  if (route.viaQuery) self.searchParams.set('channel', route.channel);
  if (route.formatParam) self.searchParams.set('format', route.formatParam);
  const selfUrl = self.toString();

  const body = format === 'atom' ? renderAtom(channel, posts, selfUrl) : renderRss(channel, posts, selfUrl);
  const response = new Response(body, {
    headers: {
      'content-type': format === 'atom' ? ATOM_CONTENT_TYPE : RSS_CONTENT_TYPE,
      'cache-control': `public, max-age=${Math.floor(ttlMs / 1000)}`,
      'x-robots-tag': 'noindex, nofollow',
    },
  });
  if (cacheable) ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

/** drop cached feeds for a channel so a new post shows up immediately */
async function purgeChannelCache(origin, chat) {
  const values = [chat.username && String(chat.username).toLowerCase(), publicId(chat.id)].filter(Boolean);
  await Promise.all(
    values.flatMap((v) => ['rss', 'atom'].map((f) => caches.default.delete(cacheRequest(origin, f, v)))),
  );
}

async function handleWebhook(request, env, ctx, origin) {
  const expected = String(env.WEBHOOK_SECRET || '').trim();
  if (!expected) return json({ ok: false, error: 'webhook disabled (WEBHOOK_SECRET not set)' }, 503);

  const header = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!(await safeEq(header, expected))) return json({ ok: false, error: 'bad secret' }, 403);

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }

  // channel posts only -- groups the bot happens to sit in are ignored
  const msg = update.channel_post || update.edited_channel_post;
  if (!msg?.chat) return json({ ok: true, skipped: true });

  const chat = msg.chat;
  const key = channelKey(chat.id, chat.username);
  const post = normalizeTelegramPost(msg);

  await env.DB.batch([
    channelStmt(
      env,
      {
        key,
        chat_id: String(chat.id ?? ''),
        username: chat.username || '',
        title: chat.title || '',
        link: channelLink(chat),
      },
      { webhookAt: Date.now() },
    ),
    postStmt(env, key, post, true),
  ]);

  ctx.waitUntil(purgeChannelCache(origin, chat));
  return json({ ok: true, message_id: msg.message_id });
}

async function handleMedia(env, fileId, sig) {
  if (!env.BOT_TOKEN || !env.API_KEY || !(await safeEq(sig, await sign(env, fileId)))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  const meta = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`,
  ).then((r) => r.json()).catch(() => null);
  const path = meta?.result?.file_path;
  if (!path) return json({ ok: false, error: 'file not found' }, 404);

  const upstream = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`);
  if (!upstream.ok) return json({ ok: false, error: 'upstream error' }, 502);

  const type = upstream.headers.get('content-type') || '';
  return new Response(upstream.body, {
    headers: {
      'content-type': type.startsWith('image/') ? type : 'image/jpeg',
      'cache-control': 'public, max-age=86400, immutable',
    },
  });
}

async function handleSetupWebhook(env, url) {
  if (!env.BOT_TOKEN) return json({ ok: false, error: 'BOT_TOKEN is not configured' }, 400);
  const secret = String(env.WEBHOOK_SECRET || '').trim();
  // Telegram only allows A-Z a-z 0-9 _ - (1..256 chars) in secret_token
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    return json({ ok: false, error: 'WEBHOOK_SECRET must match [A-Za-z0-9_-]{1,256}' }, 400);
  }

  const target = `${url.origin}/hook`;
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: target,
      secret_token: secret,
      allowed_updates: ['channel_post', 'edited_channel_post'],
      drop_pending_updates: true,
      max_connections: 10,
    }),
  });
  const payload = await res.json().catch(() => ({}));
  return json({ ok: res.ok && payload?.ok !== false, webhook: target, result: payload });
}

async function handleFeeds(env) {
  const { results } = await env.DB.prepare(
    'SELECT key, title, username, link, updated_at FROM channels ORDER BY updated_at DESC',
  ).all();
  return json({ ok: true, count: results.length, channels: results });
}

function parseFeedRoute(path, url) {
  const formatParam = url.searchParams.get('format') === 'atom' ? 'atom' : '';
  let m;
  if ((m = /^\/(rss|atom)\/(.+)$/.exec(path))) {
    return { format: formatParam || m[1], channel: safeDecode(m[2]), viaQuery: false, formatParam };
  }
  const channel = url.searchParams.get('channel') || url.searchParams.get('username') || '';
  if (path === '/rss' || path === '/feed.xml') {
    return { format: formatParam || 'rss', channel, viaQuery: true, formatParam };
  }
  if (path === '/atom') return { format: 'atom', channel, viaQuery: true, formatParam: '' };
  return null;
}

function helpPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Telegram &rarr; RSS Worker</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 system-ui,-apple-system,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#222}
code,pre{background:#f4f4f5;padding:2px 6px;border-radius:4px}pre{padding:12px;overflow:auto}
h1{font-size:22px}</style></head><body>
<h1>Telegram &rarr; RSS</h1>
<p>Converts a Telegram channel into an RSS/Atom feed. Every feed request must carry the key.</p>
<pre>GET /rss/&lt;channel&gt;?key=YOUR_KEY
GET /atom/&lt;channel&gt;?key=YOUR_KEY
GET /feed.xml?channel=&lt;channel&gt;&amp;key=YOUR_KEY
GET /feeds?key=YOUR_KEY

options: &amp;limit=50 &amp;days=30 &amp;pages=2 &amp;refresh=1</pre>
<p>Channel may be <code>@name</code>, <code>name</code>, <code>t.me/name</code>, <code>c/123456789</code> or the numeric chat id.
The key may also be sent as <code>Authorization: Bearer &lt;key&gt;</code>.</p>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* entrypoint                                                           */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    try {
      if (path === '/health') return json({ ok: true, ts: Date.now() });

      if (path === '/' || path === '/index.html') {
        return new Response(helpPage(), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' },
        });
      }

      if (path === '/hook') {
        if (method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
        return handleWebhook(request, env, ctx, url.origin);
      }

      if (path.startsWith('/media/')) {
        if (method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405);
        return handleMedia(env, safeDecode(path.slice('/media/'.length)), url.searchParams.get('sig') || '');
      }

      // everything below is key protected
      if (!(await isAuthorized(request, url, env))) return unauthorized();

      if (path === '/admin/setup-webhook') {
        if (method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
        return handleSetupWebhook(env, url);
      }

      if (method !== 'GET' && method !== 'HEAD') return json({ ok: false, error: 'method not allowed' }, 405);

      if (path === '/feeds') return handleFeeds(env);

      const route = parseFeedRoute(path, url);
      if (route) {
        if (!route.channel) return json({ ok: false, error: 'missing channel' }, 400);
        return handleFeed(env, ctx, url, route);
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.stack || err) }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
