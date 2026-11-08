/**
 * Telegram Channel -> RSS  ·  Cloudflare Worker
 * ---------------------------------------------------------------
 * Public Telegram channels are exposed as a standard RSS 2.0 / Atom feed.
 *
 *   Data sources (auto-fallback, no configuration needed):
 *     1. Telegram Bot API webhook -> updates land in Workers KV
 *        (requires the bot to be an admin of the channel)
 *     2. Public channel preview   -> https://t.me/s/<username> scraping,
 *        used to backfill history and to serve channels with no bot access
 *
 *   Protection:
 *     Every feed route requires the predefined key (env.API_KEY), passed as
 *     ?key=..., X-API-Key header, or Authorization: Bearer <key>.
 *     The webhook route is guarded by env.WEBHOOK_SECRET (path segment plus
 *     Telegram's X-Telegram-Bot-Api-Secret-Token header).
 *
 *   Endpoints
 *     GET  /                      help page
 *     GET  /health                health probe
 *     GET  /rss/:channel          RSS 2.0 feed          (?key=)
 *     GET  /atom/:channel         Atom 1.0 feed          (?key=)
 *     GET  /feed.xml?channel=...  RSS alias              (?key=)
 *     GET  /feeds                 known channels         (?key=)
 *     POST /admin/backfill        backfill a channel     (?key=, JSON body)
 *     POST /admin/setup-webhook   register the webhook   (?key=)
 *     POST /hook/:secret          Telegram webhook sink
 */

const DEFAULT_MAX_POSTS = 5000;
const DEFAULT_CACHE_TTL = 300; // seconds
const DEFAULT_POST_TTL_DAYS = 30;
const DEFAULT_LIMIT = 50;
const DEFAULT_PAGES = 2;
const DEFAULT_FEED_DAYS = 30;

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

function escapeXml(value) {
  return escapeHtml(value).replace(/'/g, '&apos;');
}

function escapeAttr(value) {
  return escapeXml(value);
}

function cdata(value) {
  return `<![CDATA[${String(value ?? '').replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

function stripTags(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'");
}

/** constant-time-ish comparison, no early exit on content */
function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* ------------------------------------------------------------------ */
/* authorization                                                        */
/* ------------------------------------------------------------------ */

function candidateKeys(request, url) {
  const headerKey = request.headers.get('x-api-key') || request.headers.get('x-feed-key');
  const auth = request.headers.get('authorization') || '';
  const bearer = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : '';
  const queryKey =
    url.searchParams.get('key') ||
    url.searchParams.get('token') ||
    url.searchParams.get('access_token') ||
    '';
  return [headerKey, bearer, queryKey].filter(Boolean);
}

/** true when the request carries the predefined feed key */
function isAuthorized(request, url, env) {
  const expected = String(env.API_KEY || '').trim();
  if (!expected) return false;
  return candidateKeys(request, url).some((k) => secretEquals(k, expected));
}

function unauthorized() {
  return json(
    {
      ok: false,
      error: 'unauthorized',
      hint: 'Provide the predefined key via ?key=..., X-API-Key header or Authorization: Bearer <key>.',
    },
    401,
    { 'www-authenticate': 'Bearer realm="telegram-rss"' },
  );
}

/* ------------------------------------------------------------------ */
/* channel reference parsing                                           */
/* ------------------------------------------------------------------ */

/**
 * Accepts: @name, name, t.me/name, t.me/s/name, t.me/c/12345, -1001234567890, 12345
 */
function normalizeChannelRef(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^https?:\/\/(?:t|telegram)\.me\//i, '');
  s = s.replace(/^\/+/, '');
  s = s.replace(/^s\//i, '');
  s = s.replace(/^c\//i, '');
  s = s.replace(/^@/, '');
  s = s.replace(/\/+$/, '');

  if (/^-?\d+$/.test(s)) {
    const chatId = s.startsWith('-100') ? s : `-100${s}`;
    const publicId = s.startsWith('-100') ? s.slice(4) : s.replace(/^-/, '');
    return {
      kind: 'numeric',
      value: s,
      chatIds: [chatId, publicId],
      username: '',
      link: `https://t.me/c/${publicId}`,
      previewUrl: `https://t.me/s/c/${publicId}`,
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

/* ------------------------------------------------------------------ */
/* KV helpers                                                          */
/* ------------------------------------------------------------------ */

/** canonical storage key: the public username, otherwise the chat id */
function channelKey(chatId, username) {
  const u = String(username || '').trim().toLowerCase();
  if (u) return u;
  return `id:${chatId}`;
}

function postKey(key, messageId) {
  return `post:${key}:${String(messageId).padStart(12, '0')}`;
}

function kvOptions(env) {
  const days = num(env.POST_TTL_DAYS, DEFAULT_POST_TTL_DAYS);
  const ttl = Math.floor(days * 86400);
  return ttl >= 60 ? { expirationTtl: ttl } : {};
}

async function kvGetJson(env, key) {
  try {
    const raw = await env.CHANNEL_KV.get(key, 'json');
    return raw ?? null;
  } catch {
    return null;
  }
}

async function kvPutJson(env, key, value) {
  await env.CHANNEL_KV.put(key, JSON.stringify(value), kvOptions(env));
}

/** resolve a channel reference to a stored channel record (if any) */
async function findStoredChannel(env, ref) {
  const keys = [];

  if (ref.kind === 'username') {
    keys.push(ref.username);
  } else {
    for (const chatId of ref.chatIds) {
      const alias = await kvGetJson(env, `alias:i:${chatId}`);
      if (typeof alias === 'string' && alias) keys.push(alias);
      keys.push(`id:${chatId}`);
    }
  }

  for (const key of keys) {
    const meta = await kvGetJson(env, `chan:${key}`);
    if (meta) return { ...meta, key };
  }
  return null;
}

async function getStoredPosts(env, key, limit) {
  const ids = await kvGetJson(env, `idx:${key}`);
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const slice = ids.slice(-limit);
  const posts = await Promise.all(slice.map((id) => kvGetJson(env, postKey(key, id))));
  return posts.filter(Boolean).sort((a, b) => b.id - a.id);
}

async function listChannels(env) {
  const out = [];
  try {
    let cursor;
    do {
      const page = await env.CHANNEL_KV.list({ prefix: 'chan:', limit: 1000, cursor });
      for (const key of page.keys) {
        const meta = await kvGetJson(env, key.name);
        if (meta) out.push(meta);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch {
    /* listing is best-effort */
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/* ------------------------------------------------------------------ */
/* Telegram payload normalization                                       */
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
    if (offset < pos || length <= 0) continue;
    out.push(escapeHtml(source.slice(pos, offset)));
    const frag = source.slice(offset, offset + length);

    switch (entity.type) {
      case 'bold':
        out.push(`<b>${escapeHtml(frag)}</b>`);
        break;
      case 'italic':
        out.push(`<i>${escapeHtml(frag)}</i>`);
        break;
      case 'underline':
        out.push(`<u>${escapeHtml(frag)}</u>`);
        break;
      case 'strikethrough':
        out.push(`<s>${escapeHtml(frag)}</s>`);
        break;
      case 'code':
        out.push(`<code>${escapeHtml(frag)}</code>`);
        break;
      case 'pre':
        out.push(`<pre>${escapeHtml(frag)}</pre>`);
        break;
      case 'text_link':
        out.push(`<a href="${escapeAttr(entity.url || '#')}">${escapeHtml(frag)}</a>`);
        break;
      case 'mention':
        out.push(
          `<a href="https://t.me/${escapeAttr(frag.replace(/^@/, ''))}">${escapeHtml(frag)}</a>`,
        );
        break;
      case 'hashtag':
        out.push(
          `<a href="https://t.me/hashtag/${escapeAttr(frag.replace(/^#/, ''))}">${escapeHtml(frag)}</a>`,
        );
        break;
      case 'url':
        out.push(`<a href="${escapeAttr(frag)}">${escapeHtml(frag)}</a>`);
        break;
      default:
        out.push(escapeHtml(frag));
    }
    pos = offset + length;
  }
  out.push(escapeHtml(source.slice(pos)));
  return out.join('');
}

function pickMedia(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const best = msg.photo.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
    return { type: 'photo', fileId: best.file_id };
  }
  if (msg.video?.file_id) return { type: 'video', fileId: msg.video.file_id };
  if (msg.animation?.file_id) return { type: 'animation', fileId: msg.animation.file_id };
  if (msg.audio?.file_id) return { type: 'audio', fileId: msg.audio.file_id };
  if (msg.document?.file_id) return { type: 'document', fileId: msg.document.file_id };
  if (msg.sticker?.file_id) return { type: 'sticker', fileId: msg.sticker.file_id };
  return null;
}

function buildPostLink(chat, messageId) {
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const raw = String(chat.id ?? '');
  const publicId = raw.startsWith('-100') ? raw.slice(4) : raw.replace(/^-/, '');
  return `https://t.me/c/${publicId}/${messageId}`;
}

function buildChannelLink(chat) {
  if (chat.username) return `https://t.me/${chat.username}`;
  const raw = String(chat.id ?? '');
  const publicId = raw.startsWith('-100') ? raw.slice(4) : raw.replace(/^-/, '');
  return `https://t.me/c/${publicId}`;
}

function normalizeTelegramPost(msg) {
  const chat = msg.chat || {};
  const text = msg.text || msg.caption || '';
  const html = renderEntities(text, msg.entities || msg.caption_entities);
  return {
    id: Number(msg.message_id),
    chatId: String(chat.id ?? ''),
    date: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    link: buildPostLink(chat, msg.message_id),
    text: decodeEntities(text),
    html: html || '',
    author: chat.title || chat.username || '',
    media: pickMedia(msg),
    image: null,
    imageExpiresAt: 0,
    views: msg.views ?? null,
    forwards: msg.forwards ?? null,
    source: 'webhook',
  };
}

/* ------------------------------------------------------------------ */
/* public preview scraping (t.me/s/<channel>)                           */
/* ------------------------------------------------------------------ */

const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins',
  'code', 'pre', 'br', 'span', 'blockquote', 'tg-emoji', 'tg-spoiler',
]);

/**
 * Keep a small whitelist of formatting tags, drop everything else while
 * preserving the inner text.
 */
function sanitizePreviewHtml(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g, (match, tag, attrs) => {
      const name = String(tag).toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return '';
      if (name === 'a') {
        const hrefMatch = /href\s*=\s*["']([^"']*)["']/i.exec(attrs || '');
        const href = hrefMatch ? hrefMatch[1].trim() : '';
        if (!/^https?:\/\//i.test(href)) {
          return match.replace(/href\s*=\s*["'][^"']*["']/i, 'href="#"');
        }
      }
      return match;
    });
}

function parsePreview(html, ref) {
  const posts = [];
  const anchors = [];
  const re = /data-post="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) anchors.push({ raw: m[1], at: m.index });

  let previewUsername = '';

  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i].at;
    const end = i + 1 < anchors.length ? anchors[i + 1].at : html.length;
    const chunk = html.slice(start, end);

    // data-post is "<username>/<id>" for public channels and
    // "c/<chatId>/<id>" for private ones.
    const parts = anchors[i].raw.split('/');
    const messageId = Number(parts[parts.length - 1]);
    if (!Number.isFinite(messageId)) continue;

    const isPrivate = parts.length >= 3 && parts[0] === 'c';
    const postUsername = !isPrivate && parts.length === 2 ? parts[0] : '';
    if (postUsername && !previewUsername) previewUsername = postUsername;

    const dateMatch = /<time[^>]*datetime="([^"]+)"/i.exec(chunk);
    const textMatch =
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(chunk);
    const viewMatch = /tgme_widget_message_views[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
    const imgMatch = /background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i.exec(chunk);
    // the permalink lives on the date anchor; the owner link points at the channel
    const permalinkMatch =
      /<a[^>]+class="[^"]*tgme_widget_message_date[^"]*"[^>]+href="([^"]+)"/i.exec(chunk) ||
      /<a[^>]+href="([^"]*\/\d+)"[^>]*class="[^"]*tgme_widget_message_date/i.exec(chunk);

    const rawHtml = textMatch ? sanitizePreviewHtml(textMatch[1]) : '';
    const plain = decodeEntities(stripTags(rawHtml));

    const permalink = isPrivate
      ? `https://t.me/c/${parts[1]}/${messageId}`
      : postUsername
        ? `https://t.me/${postUsername}/${messageId}`
        : `${ref.link}/${messageId}`;

    const permalink2 = permalinkMatch ? permalinkMatch[1].trim() : '';
    const link = /\/\d+$/.test(permalink2) ? permalink2 : permalink;

    posts.push({
      id: messageId,
      chatId: isPrivate ? parts[1] : '',
      date: dateMatch ? new Date(dateMatch[1]).toISOString() : new Date().toISOString(),
      link,
      text: plain,
      html: rawHtml,
      author: '',
      media: null,
      image: imgMatch ? imgMatch[1] : null,
      imageExpiresAt: imgMatch ? Date.now() + 3600_000 : 0,
      views: viewMatch ? decodeEntities(stripTags(viewMatch[1])) : null,
      forwards: null,
      source: 'preview',
    });
  }

  const titleMatch =
    /tgme_channel_info_header_title[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i.exec(html) ||
    /tgme_channel_info_header_title[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const descMatch = /tgme_channel_info_description[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const userMatch = /tgme_channel_info_header_username[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i.exec(html);
  // the logo is either an <img> inside .tgme_page_photo_image or a background-image
  const logoMatch =
    /<i class="tgme_page_photo_image[^"]*"[^>]*>\s*<img[^>]+src="([^"]+)"/i.exec(html) ||
    /tgme_channel_info_header_image[^>]*background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i.exec(html);

  const headerUser = userMatch ? decodeEntities(stripTags(userMatch[1])).replace(/^@/, '') : '';

  const meta = {
    title: titleMatch ? decodeEntities(stripTags(titleMatch[1])) : '',
    description: descMatch ? decodeEntities(stripTags(descMatch[1])) : '',
    photo: logoMatch ? logoMatch[1] : null,
    username: previewUsername || headerUser.toLowerCase(),
  };

  return { posts, meta };
}

async function fetchPreview(ref, pages, cutoff) {
  const collected = [];
  let meta = {};
  let url = ref.previewUrl;

  for (let page = 0; page < pages; page++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (compatible; TelegramRssWorker/1.0; +https://workers.dev)',
          accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch {
      break;
    }
    if (!res.ok) break;

    const html = await res.text();
    const parsed = parsePreview(html, ref);
    if (!parsed.posts.length) break;

    meta = { ...parsed.meta, ...meta };
    collected.push(...parsed.posts);

    const oldest = parsed.posts[parsed.posts.length - 1];
    // the page is already older than the retention window -> no reason to paginate further
    if (cutoff && Date.parse(oldest.date) < cutoff) break;
    if (!oldest.id) break;
    url = `${ref.previewUrl}?before=${oldest.id}`;
  }

  const seen = new Set();
  const posts = collected
    .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
    .filter((p) => !cutoff || isWithinWindow(p, cutoff))
    .sort((a, b) => b.id - a.id);

  return { posts, meta };
}

/** true when a post is newer than the cutoff timestamp */
function isWithinWindow(post, cutoff) {
  const ts = Date.parse(post?.date || '');
  return !Number.isFinite(ts) ? true : ts >= cutoff;
}

/* ------------------------------------------------------------------ */
/* persistence                                                          */
/* ------------------------------------------------------------------ */

/** merge webhook posts and preview posts, webhook data wins */
function mergePosts(storedPosts, previewPosts) {
  const map = new Map();
  for (const p of previewPosts) map.set(p.id, { ...p });
  for (const p of storedPosts) {
    const base = map.get(p.id) || {};
    map.set(p.id, {
      ...base,
      ...p,
      text: p.text || base.text || '',
      html: p.html || base.html || '',
      link: p.link || base.link || '',
      media: p.media || base.media || null,
      image: p.image || base.image || null,
      imageExpiresAt: p.imageExpiresAt || base.imageExpiresAt || 0,
    });
  }
  return [...map.values()].sort((a, b) => b.id - a.id);
}

async function persistPosts(env, channel, posts, cutoff) {
  const key = channelKey(channel.id, channel.username);
  const max = num(env.MAX_POSTS, DEFAULT_MAX_POSTS);

  // never store posts older than the retention window
  const fresh = posts.filter((p) => !cutoff || isWithinWindow(p, cutoff));
  const ids = fresh.map((p) => p.id).sort((a, b) => a - b).slice(-max);

  for (const post of fresh) {
    await kvPutJson(env, postKey(key, post.id), { ...post, key });
  }

  const existing = await kvGetJson(env, `idx:${key}`);
  const merged = new Set([...(Array.isArray(existing) ? existing : []), ...ids]);
  const mergedList = [...merged].sort((a, b) => a - b).slice(-max);
  await kvPutJson(env, `idx:${key}`, mergedList);

  await kvPutJson(env, `chan:${key}`, {
    id: channel.id ?? '',
    key,
    title: channel.title || 'Telegram channel',
    username: channel.username || '',
    description: channel.description || '',
    photo: channel.photo || null,
    link: channel.link || '',
    updatedAt: Date.now(),
  });

  if (channel.id && /^-?\d+$/.test(String(channel.id))) {
    await kvPutJson(env, `alias:i:${channel.id}`, key);
  }
}

async function persistWebhookPost(env, msg, ctx) {
  const chat = msg.chat || {};
  const key = channelKey(chat.id, chat.username);
  const post = normalizeTelegramPost(msg);

  await kvPutJson(env, postKey(key, post.id), { ...post, key });

  const idxKey = `idx:${key}`;
  const existing = await kvGetJson(env, idxKey);
  const ids = new Set(Array.isArray(existing) ? existing : []);
  ids.add(post.id);
  const max = num(env.MAX_POSTS, DEFAULT_MAX_POSTS);
  const list = [...ids].sort((a, b) => a - b).slice(-max);
  await kvPutJson(env, idxKey, list);

  await kvPutJson(env, `chan:${key}`, {
    id: String(chat.id ?? ''),
    key,
    title: chat.title || 'Telegram channel',
    username: chat.username || '',
    description: chat.description || '',
    photo: null,
    link: buildChannelLink(chat),
    updatedAt: Date.now(),
  });

  await kvPutJson(env, `alias:i:${chat.id}`, key);

  if (ctx && env.BOT_TOKEN && env.RESOLVE_MEDIA !== '0' && post.media?.fileId) {
    ctx.waitUntil(resolveMedia(env, key, post.id));
  }
}

/* ------------------------------------------------------------------ */
/* media resolution (bot token required)                               */
/* ------------------------------------------------------------------ */

async function resolveMedia(env, key, messageId) {
  if (!env.BOT_TOKEN) return;
  const post = await kvGetJson(env, postKey(key, messageId));
  if (!post?.media?.fileId) return;

  try {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(post.media.fileId)}`;
    const res = await fetch(url);
    const payload = await res.json();
    const filePath = payload?.result?.file_path;
    if (!filePath) return;
    post.image = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
    post.imageExpiresAt = Date.now() + 45 * 60_000;
    await kvPutJson(env, postKey(key, messageId), post);
  } catch {
    /* media resolution is best-effort */
  }
}

async function refreshStaleMedia(env, posts, ctx) {
  if (!env.BOT_TOKEN || env.RESOLVE_MEDIA === '0' || !ctx) return;
  const now = Date.now();
  const stale = posts
    .filter((p) => p.media?.fileId && (!p.image || p.imageExpiresAt < now))
    .slice(0, 12);
  for (const post of stale) {
    ctx.waitUntil(resolveMedia(env, post.key, post.id));
  }
}

/* ------------------------------------------------------------------ */
/* feed rendering                                                       */
/* ------------------------------------------------------------------ */

function itemTitle(post) {
  const text = (post.text || '').trim();
  if (!text) return `Post #${post.id}`;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function renderRss(channel, posts, selfUrl) {
  const title = channel.title || 'Telegram channel';
  const description = channel.description || `Telegram channel feed — ${title}`;
  const link = channel.link || 'https://t.me';

  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">',
  );
  parts.push('<channel>');
  parts.push(`<title>${escapeXml(title)}</title>`);
  parts.push(`<link>${escapeXml(link)}</link>`);
  parts.push(`<description>${escapeXml(description)}</description>`);
  parts.push('<language>en</language>');
  parts.push(`<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`);
  parts.push('<generator>telegram-rss-worker</generator>');
  parts.push(`<atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>`);
  parts.push(`<atom:link href="${escapeXml(link)}" rel="alternate" type="text/html"/>`);
  if (channel.photo) {
    parts.push(
      `<image><url>${escapeXml(channel.photo)}</url><title>${escapeXml(title)}</title><link>${escapeXml(link)}</link></image>`,
    );
  }

  for (const post of posts) {
    const body = post.html ? post.html : escapeHtml(post.text || '');
    const plain = post.text ? escapeHtml(post.text) : body;
    parts.push('<item>');
    parts.push(`<title>${escapeXml(itemTitle(post))}</title>`);
    parts.push(`<link>${escapeXml(post.link)}</link>`);
    parts.push(`<guid isPermaLink="true">${escapeXml(post.link)}</guid>`);
    parts.push(`<pubDate>${new Date(post.date).toUTCString()}</pubDate>`);
    parts.push(`<description>${cdata(plain)}</description>`);
    parts.push(`<content:encoded>${cdata(body)}</content:encoded>`);
    parts.push(`<dc:creator>${escapeXml(post.author || title)}</dc:creator>`);
    if (post.image) {
      parts.push(`<media:content url="${escapeXml(post.image)}" medium="image"/>`);
      parts.push(`<enclosure url="${escapeXml(post.image)}" type="image/jpeg" length="0"/>`);
    }
    parts.push('</item>');
  }

  parts.push('</channel>');
  parts.push('</rss>');
  return parts.join('\n');
}

function renderAtom(channel, posts, selfUrl) {
  const title = channel.title || 'Telegram channel';
  const link = channel.link || 'https://t.me';
  const updated = posts.length ? new Date(posts[0].date).toISOString() : new Date().toISOString();

  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<feed xmlns="http://www.w3.org/2005/Atom">');
  parts.push(`<title>${escapeXml(title)}</title>`);
  parts.push(`<subtitle>${escapeXml(channel.description || '')}</subtitle>`);
  parts.push(`<link href="${escapeXml(selfUrl)}" rel="self"/>`);
  parts.push(`<link href="${escapeXml(link)}" rel="alternate"/>`);
  parts.push(`<updated>${updated}</updated>`);
  parts.push('<generator>telegram-rss-worker</generator>');

  for (const post of posts) {
    parts.push('<entry>');
    parts.push(`<title>${escapeXml(itemTitle(post))}</title>`);
    parts.push(`<link href="${escapeXml(post.link)}"/>`);
    parts.push(`<id>${escapeXml(post.link)}</id>`);
    parts.push(`<updated>${new Date(post.date).toISOString()}</updated>`);
    parts.push(`<published>${new Date(post.date).toISOString()}</published>`);
    parts.push(`<author><name>${escapeXml(post.author || title)}</name></author>`);
    parts.push(`<content type="html">${cdata(post.html || escapeHtml(post.text || ''))}</content>`);
    parts.push(`<summary>${cdata(post.text || '')}</summary>`);
    parts.push('</entry>');
  }

  parts.push('</feed>');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ */
/* routes                                                               */
/* ------------------------------------------------------------------ */

async function handleFeed(request, env, ctx, url, channelRaw, format) {
  const ref = normalizeChannelRef(channelRaw);
  if (!ref.value) return json({ ok: false, error: 'missing channel' }, 400);

  const limit = num(url.searchParams.get('limit'), DEFAULT_LIMIT);
  const pages = num(url.searchParams.get('pages'), DEFAULT_PAGES);
  const force = url.searchParams.get('refresh') === '1';

  // retention window: only posts newer than this are exposed
  const defaultDays = num(env.FEED_DAYS, DEFAULT_FEED_DAYS);
  const days = num(url.searchParams.get('days'), defaultDays);
  const cutoff = Date.now() - days * 86_400_000;
  // only the default variant is cached, so a webhook can purge it exactly
  const cacheable = days === defaultDays && limit === DEFAULT_LIMIT;

  const stored = await findStoredChannel(env, ref);
  let channel = stored;
  // over-fetch a little so the date filter cannot starve the feed
  let posts = stored?.key ? await getStoredPosts(env, stored.key, Math.min(limit * 2, 500)) : [];
  posts = posts.filter((p) => isWithinWindow(p, cutoff)).slice(0, limit);

  // Fallback / backfill from the public channel preview.
  if (force || posts.length === 0) {
    const preview = await fetchPreview(ref, pages, cutoff);
    const merged = mergePosts(posts, preview.posts).filter((p) => isWithinWindow(p, cutoff));
    posts = merged.slice(0, limit);

    const username = preview.meta.username || stored?.username || ref.username;
    const chatId = stored?.id || (ref.kind === 'numeric' ? ref.chatIds[0] : '');
    channel = {
      id: chatId,
      key: stored?.key || channelKey(chatId, username),
      username,
      title: preview.meta.title || stored?.title || `@${ref.username || ref.value}`,
      description: preview.meta.description || stored?.description || '',
      photo: preview.meta.photo || stored?.photo || null,
      link: stored?.link || ref.link,
    };

    ctx.waitUntil(persistPosts(env, channel, merged, cutoff).catch(() => {}));
  }

  refreshStaleMedia(env, posts, ctx);

  const selfUrl = `${url.origin}${url.pathname}${format === 'atom' ? '?format=atom' : ''}`;
  const body =
    format === 'atom' ? renderAtom(channel, posts, selfUrl) : renderRss(channel, posts, selfUrl);

  const ttl = num(env.CACHE_TTL, DEFAULT_CACHE_TTL);
  const headers = {
    'content-type': format === 'atom' ? ATOM_CONTENT_TYPE : RSS_CONTENT_TYPE,
    'cache-control': `public, max-age=${ttl}`,
    'x-robots-tag': 'noindex, nofollow',
  };

  const cacheKey = new Request(`${url.origin}${url.pathname}?format=${format}`, { method: 'GET' });
  const cache = caches.default;

  // ?refresh=1 bypasses (and does not populate) the cache; so do custom variants.
  if (!force && cacheable) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const response = new Response(body, { headers });
  if (!force && cacheable) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/** drop cached feeds for a channel so a new post shows up immediately */
async function purgeChannelCache(origin, username) {
  if (!username) return;
  for (const path of [`/rss/${username}`, `/atom/${username}`]) {
    await Promise.all([
      caches.default.delete(new Request(`${origin}${path}?format=rss`, { method: 'GET' })),
      caches.default.delete(new Request(`${origin}${path}?format=atom`, { method: 'GET' })),
    ]);
  }
}

async function handleWebhook(request, env, ctx, secret, origin) {
  const expected = String(env.WEBHOOK_SECRET || '').trim();
  if (!expected) {
    return json({ ok: false, error: 'webhook disabled (WEBHOOK_SECRET not set)' }, 503);
  }
  if (!secretEquals(secret, expected)) {
    return json({ ok: false, error: 'bad webhook secret' }, 403);
  }

  const headerSecret = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!secretEquals(headerSecret, expected)) {
    return json({ ok: false, error: 'bad secret header' }, 403);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }

  const message = update.channel_post || update.edited_channel_post || update.message;
  if (!message || !message.chat) return json({ ok: true, skipped: true });

  try {
    await persistWebhookPost(env, message, ctx);
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }

  await purgeChannelCache(origin, message.chat?.username);

  return json({ ok: true, message_id: message.message_id });
}

async function handleBackfill(request, env, ctx, url) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine */
  }
  const channelRaw = body.channel || url.searchParams.get('channel');
  if (!channelRaw) return json({ ok: false, error: 'missing channel' }, 400);

  const ref = normalizeChannelRef(channelRaw);
  const pages = num(body.pages || url.searchParams.get('pages'), 3);
  const days = num(body.days || url.searchParams.get('days'), num(env.FEED_DAYS, DEFAULT_FEED_DAYS));
  const cutoff = Date.now() - days * 86_400_000;
  const preview = await fetchPreview(ref, pages, cutoff);
  const stored = await findStoredChannel(env, ref);

  const username = preview.meta.username || stored?.username || ref.username;
  const chatId = stored?.id || (ref.kind === 'numeric' ? ref.chatIds[0] : '');
  const channel = {
    id: chatId,
    key: stored?.key || channelKey(chatId, username),
    username,
    title: preview.meta.title || stored?.title || `@${ref.username || ref.value}`,
    description: preview.meta.description || stored?.description || '',
    photo: preview.meta.photo || stored?.photo || null,
    link: stored?.link || ref.link,
  };

  await persistPosts(env, channel, preview.posts, cutoff);
  await purgeChannelCache(url.origin, channel.username);

  return json({
    ok: true,
    channel: channel.title,
    key: channel.key,
    posts: preview.posts.length,
    days,
    pages,
  });
}

async function handleSetupWebhook(request, env, ctx, url) {
  if (!env.BOT_TOKEN) return json({ ok: false, error: 'BOT_TOKEN is not configured' }, 400);
  const secret = String(env.WEBHOOK_SECRET || '').trim();
  if (!secret) return json({ ok: false, error: 'WEBHOOK_SECRET is not configured' }, 400);

  const target = `${url.origin}/hook/${secret}`;
  const api = `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`;
  const res = await fetch(api, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: target,
      secret_token: secret,
      allowed_updates: ['channel_post', 'edited_channel_post', 'message'],
      drop_pending_updates: true,
      max_connections: 10,
    }),
  });
  const payload = await res.json().catch(() => ({}));
  return json({ ok: res.ok && payload?.ok !== false, webhook: target, result: payload });
}

function helpPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Telegram &rarr; RSS Worker</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px/1.6 system-ui,-apple-system,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#222}
code,pre{background:#f4f4f5;padding:2px 6px;border-radius:4px}pre{padding:12px;overflow:auto}
h1{font-size:22px}</style></head><body>
<h1>Telegram &rarr; RSS</h1>
<p>This worker converts a Telegram channel into an RSS/Atom feed. Every feed request must carry the predefined key.</p>
<pre>GET  /rss/&lt;channel&gt;?key=YOUR_KEY     RSS 2.0
GET  /atom/&lt;channel&gt;?key=YOUR_KEY    Atom 1.0
GET  /feeds?key=YOUR_KEY            list known channels
POST /admin/backfill?key=YOUR_KEY   {"channel":"name","pages":3}</pre>
<p>Channel may be <code>@name</code>, <code>name</code>, <code>t.me/name</code>, <code>c/123456789</code> or the numeric chat id.</p>
<p>The key can also be sent as the <code>X-API-Key</code> header or <code>Authorization: Bearer &lt;key&gt;</code>.</p>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* entrypoint                                                           */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/health') {
        return json({ ok: true, ts: Date.now(), hasBotToken: Boolean(env.BOT_TOKEN) });
      }

      if (path === '/' || path === '/index.html') {
        return new Response(helpPage(), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'public, max-age=3600',
          },
        });
      }

      if (path.startsWith('/hook/')) {
        if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
        return handleWebhook(
          request,
          env,
          ctx,
          decodeURIComponent(path.slice('/hook/'.length)),
          url.origin,
        );
      }

      // Everything below is key protected.
      if (!isAuthorized(request, url, env)) return unauthorized();

      if (path === '/feeds') {
        const channels = await listChannels(env);
        return json({ ok: true, count: channels.length, channels });
      }

      if (path === '/admin/backfill') {
        if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
        return handleBackfill(request, env, ctx, url);
      }

      if (path === '/admin/setup-webhook') {
        if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
        return handleSetupWebhook(request, env, ctx, url);
      }

      let channelRaw = null;
      let format = 'rss';

      if (path === '/rss' || path === '/feed.xml' || path === '/rss.xml') {
        channelRaw = url.searchParams.get('channel') || url.searchParams.get('username');
      } else if (path.startsWith('/rss/')) {
        channelRaw = decodeURIComponent(path.slice('/rss/'.length));
      } else if (path.startsWith('/atom/')) {
        channelRaw = decodeURIComponent(path.slice('/atom/'.length));
        format = 'atom';
      } else if (path === '/atom' || path === '/atom.xml') {
        channelRaw = url.searchParams.get('channel');
        format = 'atom';
      }

      if (channelRaw !== null) {
        if (url.searchParams.get('format') === 'atom') format = 'atom';
        if (!channelRaw) return json({ ok: false, error: 'missing channel' }, 400);
        return handleFeed(request, env, ctx, url, channelRaw, format);
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: String(err?.stack || err) }, 500);
    }
  },
};
