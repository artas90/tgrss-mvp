/**
 * Telegram Channel -> RSS / Atom · Cloudflare Worker (D1 + HTMLRewriter)
 * ----------------------------------------------------------------
 * Ingestion (auto-fallback):
 *   1. Bot API webhook (POST /hook) -> D1  (bot must be admin of the channel)
 *   2. Public preview t.me/s/<name> -> D1  (backfill + channels without bot access)
 *
 * Auth: env.API_KEY, sent as ?key=<key> or "Authorization: Bearer <key>", unlocks
 *       everything. A feed can instead be opened with its random channel token
 *       (/rss/<token>, stored in channels.feed_token): it reaches only that channel's
 *       default feed, so readers never see API_KEY. /feeds lists the tokens. The webhook
 *       is guarded by Telegram's X-Telegram-Bot-Api-Secret-Token header
 *       (= env.WEBHOOK_SECRET). Media URLs embedded in feeds are HMAC-signed, so the
 *       bot token never leaks.
 *
 * Routes
 *   GET  /                          help page
 *   GET  /health                    liveness probe
 *   GET  /rss/:channel              RSS 2.0                        (?key=)
 *   GET  /atom/:channel             Atom 1.0                       (?key=)
 *   GET  /rss/:token                RSS 2.0, one channel           (token only)
 *   GET  /atom/:token               Atom 1.0, one channel          (token only)
 *   GET  /feeds                     known channels + tokens (JSON) (?key=)
 *   GET  /media/:fileId?sig=        HMAC-signed media proxy
 *   POST /admin/setup-webhook       register the Telegram webhook  (?key=)
 *   POST /hook                      Telegram webhook sink (secret-token guarded)
 *
 * Feed params: ?limit= ?days= ?pages= ?refresh=1
 *   (?refresh=1&pages=N doubles as a backfill)
 *
 * Env bindings: DB (D1) · API_KEY · BOT_TOKEN? · WEBHOOK_SECRET? ·
 *               FEED_DAYS? (30) · MAX_POSTS? (5000) · CACHE_TTL? (300 s)
 */

const MS_PER_DAY = 86_400_000;
const DEFAULT_FEED_WINDOW_DAYS = 30; // feed window and post retention (FEED_DAYS)
const DEFAULT_MAX_STORED_POSTS = 5000; // per-channel cap, enforced by cron (MAX_POSTS)
const DEFAULT_CACHE_TTL_SECONDS = 300; // seconds: preview rescrape interval + feed cache (CACHE_TTL)
const DEFAULT_PREVIEW_PAGES = 3; // preview pages per scrape
const MAX_PREVIEW_PAGES = 10; // cap for ?pages=
const MAX_POSTS_PER_FEED = 5000; // cap for ?limit=, also its default
const WEBHOOK_FRESH_WINDOW_MS = 3_600_000; // skip rescraping channels the webhook keeps fresh
const textEncoder = new TextEncoder();

/* ------------------------------------------------------------------ */
/* small helpers                                                        */
/* ------------------------------------------------------------------ */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      ...extraHeaders,
    },
  });
}

const methodNotAllowed = () =>
  json({ ok: false, error: "method not allowed" }, 405);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const escapeXml = (value) => escapeHtml(value).replace(/'/g, "&apos;");

function cdata(value) {
  return `<![CDATA[${String(value ?? "").replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

function stripTags(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const NAMED_ENTITIES = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
};

/** Single-pass decode: '&amp;lt;' stays '&lt;' -- nothing is decoded twice. */
export function decodeEntities(text) {
  return String(text ?? "").replace(
    /&#(\d+);|&#x([0-9a-f]+);|&(\w+);/gi,
    (m, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return NAMED_ENTITIES[name.toLowerCase()] ?? m;
    },
  );
}

/** positive finite number, or the fallback */
function positiveNumber(value, fallback) {
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

const inWindow = (post, cutoff) => {
  const ts = Date.parse(post.date);
  return !Number.isFinite(ts) || ts >= cutoff;
};

/** compares SHA-256 digests with a constant-time loop (portable, no length leak) */
async function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const [da, db] = await Promise.all(
    [a, b].map((value) =>
      crypto.subtle.digest("SHA-256", textEncoder.encode(value)),
    ),
  );
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = x.length ^ y.length; // digests are always 32 bytes; kept for safety
  for (let i = 0; i < x.length && i < y.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** factory: import the HMAC key once, then sign many file ids cheaply */
async function createSigner(env) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(env.API_KEY)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const hex = (buf) =>
    [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return async (text) =>
    hex(
      await crypto.subtle.sign("HMAC", key, textEncoder.encode(text)),
    ).slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* authorization                                                        */
/* ------------------------------------------------------------------ */

/** accepts the key as "Authorization: Bearer <key>" or as ?key=<key> */
async function isAuthorized(request, url, env) {
  const expected = String(env.API_KEY || "").trim();
  if (!expected) return false;

  const bearer = /^bearer\s+(.+)$/i
    .exec(request.headers.get("authorization") || "")?.[1]
    ?.trim();

  for (const candidate of [bearer, url.searchParams.get("key")]) {
    if (await safeEq(candidate, expected)) return true;
  }
  return false;
}

function unauthorized() {
  return json(
    {
      ok: false,
      error: "unauthorized",
      hint: "Provide the key via ?key=... or Authorization: Bearer <key>.",
    },
    401,
    { "www-authenticate": 'Bearer realm="telegram-rss"' },
  );
}

/* ------------------------------------------------------------------ */
/* per-channel feed tokens                                              */
/* ------------------------------------------------------------------ */

const FEED_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/*
 * A feed token is a random 128-bit value stored in channels.feed_token. D1 generates it
 * when the channel row is created (see upsertChannelStmt); migrate_feed_token.sql adds the
 * column and fills existing rows. It opens only that channel's default feed and does not
 * depend on API_KEY.
 */

/** the channel row (key, username, chat_id) that owns this token, or null; indexed lookup */
function findChannelByToken(env, token) {
  return env.DB.prepare(
    "SELECT key, username, chat_id FROM channels WHERE feed_token = ?1",
  )
    .bind(token)
    .first();
}

/** the channel's token, or "" while its row does not exist */
async function getFeedToken(env, channelKey) {
  const row = await env.DB.prepare(
    "SELECT feed_token FROM channels WHERE key = ?1",
  )
    .bind(channelKey)
    .first();
  return row?.feed_token || "";
}

/* ------------------------------------------------------------------ */
/* channel references                                                   */
/* ------------------------------------------------------------------ */

function publicId(id) {
  const s = String(id ?? "");
  return s.startsWith("-100") ? s.slice(4) : s.replace(/^-/, "");
}

/** Accepts: @name, name, t.me/name, t.me/s/name, t.me/c/12345[/678], -1001234567890, 12345 */
export function normalizeChannelRef(raw) {
  const s = String(raw ?? "")
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i, "")
    .replace(/^\/+/, "")
    .replace(/^s\//i, "")
    .replace(/^c\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0];

  if (/^-?\d+$/.test(s)) {
    const value = publicId(s);
    return {
      kind: "numeric",
      value,
      chatId: `-100${value}`,
      username: "",
      link: `https://t.me/c/${value}`,
      previewUrl: `https://t.me/s/c/${value}`,
    };
  }

  const username = s.toLowerCase();
  return {
    kind: "username",
    value: username,
    chatId: "",
    username,
    link: `https://t.me/${username}`,
    previewUrl: `https://t.me/s/${username}`,
  };
}

/** canonical storage key: public username, otherwise the numeric channel id */
function channelKey(chatId, username) {
  const u = String(username || "")
    .trim()
    .toLowerCase();
  return u || `id:${publicId(chatId)}`;
}

/* ------------------------------------------------------------------ */
/* D1 layer                                                             */
/* ------------------------------------------------------------------ */

function upsertChannelStmt(
  env,
  ch,
  { fetchedAt = null, webhookAt = null } = {},
) {
  return env.DB.prepare(
    // feed_token is set only on insert (random, by D1) and never touched on conflict
    `INSERT INTO channels (key, chat_id, username, title, description, photo, link, fetched_at, webhook_at, updated_at, feed_token)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, lower(hex(randomblob(16))))
     ON CONFLICT(key) DO UPDATE SET
       chat_id     = COALESCE(NULLIF(excluded.chat_id, ''),     channels.chat_id),
       username    = COALESCE(NULLIF(excluded.username, ''),    channels.username),
       title       = COALESCE(NULLIF(excluded.title, ''),       channels.title),
       description = COALESCE(NULLIF(excluded.description, ''), channels.description),
       photo       = COALESCE(excluded.photo,                   channels.photo),
       link        = COALESCE(NULLIF(excluded.link, ''),        channels.link),
       fetched_at  = COALESCE(excluded.fetched_at,              channels.fetched_at),
       webhook_at  = COALESCE(excluded.webhook_at,              channels.webhook_at),
       updated_at  = excluded.updated_at`,
  ).bind(
    ch.key,
    ch.chat_id || "",
    ch.username || "",
    ch.title || "",
    ch.description || "",
    ch.photo || null,
    ch.link || "",
    fetchedAt,
    webhookAt,
    Date.now(),
  );
}

/** webhook rows always win; preview rows never overwrite a webhook row */
function upsertPostStmt(env, chan, p, fromWebhook) {
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
     ${fromWebhook ? "" : "WHERE posts.source <> 'webhook'"}`,
  ).bind(
    chan,
    p.id,
    p.chat_id || "",
    p.date,
    p.link || "",
    p.text || "",
    p.html || "",
    p.author || "",
    p.image || null,
    p.file_id || null,
    p.source,
  );
}

async function findChannel(env, ref) {
  if (ref.kind === "username") {
    return env.DB.prepare("SELECT * FROM channels WHERE key = ?1")
      .bind(ref.username)
      .first();
  }
  return env.DB.prepare(
    "SELECT * FROM channels WHERE key = ?1 OR chat_id = ?2 LIMIT 1",
  )
    .bind(`id:${ref.value}`, ref.chatId)
    .first();
}

async function getPosts(env, chan, cutoff, limit) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM posts WHERE chan = ?1 AND date >= ?2 ORDER BY id DESC LIMIT ?3",
  )
    .bind(chan, new Date(cutoff).toISOString(), limit)
    .all();
  return results || [];
}

async function persistPreview(env, channel, posts) {
  const stmts = [
    upsertChannelStmt(env, channel, { fetchedAt: Date.now() }),
    ...posts.map((p) => upsertPostStmt(env, channel.key, p, false)),
  ];
  // chunked to stay within D1's batch limits
  for (let i = 0; i < stmts.length; i += 100)
    await env.DB.batch(stmts.slice(i, i + 100));
}

/** cron: drop posts outside the retention window and above the per-channel cap */
async function cleanup(env) {
  const days = positiveNumber(env.FEED_DAYS, DEFAULT_FEED_WINDOW_DAYS);
  const cutoffIso = new Date(Date.now() - days * MS_PER_DAY).toISOString();
  const max = positiveNumber(env.MAX_POSTS, DEFAULT_MAX_STORED_POSTS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM posts WHERE date < ?1").bind(cutoffIso),
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

const ENTITY_TAGS = {
  bold: "b",
  italic: "i",
  underline: "u",
  strikethrough: "s",
  code: "code",
  pre: "pre",
};

/** renders message text + Telegram entities to safe HTML (UTF-16 offsets match JS slicing) */
export function renderEntities(text, entities) {
  const source = String(text ?? "");
  if (!source) return "";
  if (!entities?.length) return escapeHtml(source);

  const out = [];
  let pos = 0;
  const sorted = [...entities].sort(
    (a, b) => (a.offset || 0) - (b.offset || 0),
  );

  for (const entity of sorted) {
    const offset = entity.offset || 0;
    const length = entity.length || 0;
    if (offset < pos || length <= 0) continue; // overlapping entities are skipped
    out.push(escapeHtml(source.slice(pos, offset)));
    out.push(formatEntity(source.slice(offset, offset + length), entity));
    pos = offset + length;
  }
  out.push(escapeHtml(source.slice(pos)));
  return out.join("");
}

function formatEntity(frag, entity) {
  const f = escapeHtml(frag);
  const tag = ENTITY_TAGS[entity.type];
  if (tag) return `<${tag}>${f}</${tag}>`;
  switch (entity.type) {
    case "text_link":
      return `<a href="${escapeHtml(entity.url || "#")}">${f}</a>`;
    case "mention":
      return `<a href="https://t.me/${escapeHtml(frag.replace(/^@/, ""))}">${f}</a>`;
    case "hashtag":
      return `<a href="https://t.me/hashtag/${escapeHtml(frag.replace(/^#/, ""))}">${f}</a>`;
    case "url":
      return `<a href="${f}">${f}</a>`;
    default:
      return f;
  }
}

function channelLink(chat) {
  return chat.username
    ? `https://t.me/${chat.username}`
    : `https://t.me/c/${publicId(chat.id)}`;
}

function normalizeTelegramPost(msg) {
  const chat = msg.chat || {};
  const text = msg.text || msg.caption || "";
  const photo =
    Array.isArray(msg.photo) && msg.photo.length
      ? msg.photo.reduce((largest, current) =>
          (current.width || 0) > (largest.width || 0) ? current : largest,
        )
      : null;

  return {
    id: Number(msg.message_id),
    chat_id: String(chat.id ?? ""),
    date: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    link: `${channelLink(chat)}/${msg.message_id}`,
    text,
    html: renderEntities(text, msg.entities || msg.caption_entities),
    author: chat.title || chat.username || "",
    image: null,
    file_id: photo?.file_id || null, // photos only; served via the signed /media proxy
    source: "webhook",
  };
}

/* ------------------------------------------------------------------ */
/* preview scraping (t.me/s/<channel>) via HTMLRewriter                 */
/* ------------------------------------------------------------------ */

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "ins",
  "code",
  "pre",
  "br",
  "span",
  "blockquote",
  "tg-emoji",
  "tg-spoiler",
]);

const TEXT_ROOT = ".tgme_widget_message_text:not(.js-message_reply_text)";
const TEXT_STATE = { BEFORE: 0, INSIDE: 1, AFTER: 2 };
const bgImage = (style) =>
  /url\(['"]?([^'")]+)['"]?\)/i.exec(style || "")?.[1] || null;

/**
 * Streams the page once. Message body HTML is rebuilt from scratch:
 * whitelisted tags only, no attributes except a validated https? href on <a>.
 */
async function parsePreview(res, ref) {
  const posts = [];
  const header = { title: "", description: "", username: "", photo: null };
  let cur = null; // post being built; null outside a message

  await new HTMLRewriter()
    // one element per message: opens the current post
    .on(".tgme_widget_message[data-post]", {
      element(el) {
        const parts = (el.getAttribute("data-post") || "").split("/");
        const id = Number(parts[parts.length - 1]);
        if (!id) {
          cur = null;
          return;
        }
        const isPrivate = parts[0] === "c" && parts.length >= 3;
        cur = {
          id,
          chat_id: isPrivate ? parts[1] : "",
          username: !isPrivate && parts.length === 2 ? parts[0] : "",
          date: "",
          link: "",
          html: "",
          image: null,
          textState: TEXT_STATE.BEFORE,
        };
        posts.push(cur);
      },
    })
    // permalink + timestamp
    .on("a.tgme_widget_message_date", {
      element(el) {
        if (cur) cur.link = el.getAttribute("href") || "";
      },
    })
    .on(".tgme_widget_message_date time", {
      element(el) {
        if (cur) cur.date = el.getAttribute("datetime") || "";
      },
    })
    // first image / video thumbnail
    .on(
      ".tgme_widget_message_photo_wrap, .tgme_widget_message_video_thumb, .tgme_widget_message_roundvideo_thumb",
      {
        element(el) {
          if (cur && !cur.image) cur.image = bgImage(el.getAttribute("style"));
        },
      },
    )
    // message text root: opens/closes capture; text chunks include nested text
    .on(TEXT_ROOT, {
      element(el) {
        const post = cur;
        if (!post || post.textState !== TEXT_STATE.BEFORE) return;
        post.textState = TEXT_STATE.INSIDE;
        el.onEndTag(() => {
          post.textState = TEXT_STATE.AFTER;
        });
      },
      text(t) {
        if (cur?.textState === TEXT_STATE.INSIDE) cur.html += t.text;
      },
    })
    // descendants of the text root: re-emit whitelisted tags, no attributes
    .on(`${TEXT_ROOT} *`, {
      element(el) {
        const post = cur;
        if (!post || post.textState !== TEXT_STATE.INSIDE) return;
        const name = el.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(name)) return;

        let open = `<${name}`;
        if (name === "a") {
          const href = (el.getAttribute("href") || "").trim();
          if (!/^https?:\/\//i.test(href)) return; // drop internal links, keep their text
          open += ` href="${escapeHtml(decodeEntities(href))}"`;
        }
        post.html += `${open}>`;
        if (name === "br") return; // void element
        el.onEndTag(() => {
          if (post.textState === TEXT_STATE.INSIDE) post.html += `</${name}>`;
        });
      },
    })
    // channel header
    .on(".tgme_channel_info_header_title", {
      text(t) {
        header.title += t.text;
      },
    })
    .on(".tgme_channel_info_description", {
      text(t) {
        header.description += t.text;
      },
    })
    .on(".tgme_channel_info_header_username a", {
      text(t) {
        header.username += t.text;
      },
    })
    .on(".tgme_page_photo_image img", {
      element(el) {
        if (!header.photo) header.photo = el.getAttribute("src");
      },
    })
    .transform(res)
    .text(); // consume the stream

  let previewUsername = "";
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
      author: "",
      image: p.image,
      file_id: null,
      source: "preview",
    };
  });

  return {
    posts: out,
    meta: {
      title: decodeEntities(stripTags(header.title)),
      description: decodeEntities(stripTags(header.description)),
      photo: header.photo,
      username:
        previewUsername ||
        decodeEntities(stripTags(header.username))
          .replace(/^@/, "")
          .toLowerCase(),
    },
  };
}

async function fetchPreview(ref, pages, cutoff) {
  const byId = new Map();
  let meta = { title: "", description: "", photo: null, username: "" };
  let url = ref.previewUrl;

  for (let page = 0; page < pages; page++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (compatible; TelegramRssWorker/2.0; +https://workers.dev)",
          accept: "text/html,application/xhtml+xml",
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
  const chat_id = stored?.chat_id || (ref.kind === "numeric" ? ref.chatId : "");
  return {
    key: stored?.key || channelKey(chat_id, username),
    chat_id,
    username,
    title:
      preview.meta.title || stored?.title || `@${ref.username || ref.value}`,
    description: preview.meta.description || stored?.description || "",
    photo: preview.meta.photo || stored?.photo || null,
    link: stored?.link || ref.link,
  };
}

/* ------------------------------------------------------------------ */
/* feed rendering                                                       */
/* ------------------------------------------------------------------ */

export function itemTitle(post) {
  const text = (post.text || "").trim();
  if (!text) return `Post #${post.id}`;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function itemBody(post) {
  const image = post.image
    ? `<p><img src="${escapeHtml(post.image)}" alt=""></p>`
    : "";
  const content = post.html || escapeHtml(post.text || "");
  return image + content;
}

function getFeedInfo(channel, posts) {
  return {
    title: channel.title || "Telegram channel",
    link: channel.link || "https://t.me",
    updated: posts.length ? new Date(posts[0].date) : new Date(),
  };
}

export function renderRss(channel, posts, selfUrl) {
  const { title, link, updated } = getFeedInfo(channel, posts);
  const description = channel.description || `Telegram channel feed — ${title}`;

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">',
    "<channel>",
    `<title>${escapeXml(title)}</title>`,
    `<link>${escapeXml(link)}</link>`,
    `<description>${escapeXml(description)}</description>`,
    `<lastBuildDate>${updated.toUTCString()}</lastBuildDate>`,
    "<generator>telegram-rss-worker</generator>",
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
      "<item>",
      `<title>${escapeXml(itemTitle(post))}</title>`,
      `<link>${escapeXml(post.link)}</link>`,
      `<guid isPermaLink="true">${escapeXml(post.link)}</guid>`,
      `<pubDate>${new Date(post.date).toUTCString()}</pubDate>`,
      `<description>${cdata(escapeHtml(post.text || ""))}</description>`,
      `<content:encoded>${cdata(itemBody(post))}</content:encoded>`,
      `<dc:creator>${escapeXml(post.author || title)}</dc:creator>`,
    );
    if (post.image)
      parts.push(
        `<media:content url="${escapeXml(post.image)}" medium="image"/>`,
      );
    parts.push("</item>");
  }

  parts.push("</channel>", "</rss>");
  return parts.join("\n");
}

export function renderAtom(channel, posts, selfUrl) {
  const { title, link, updated } = getFeedInfo(channel, posts);
  const description = channel.description || "";

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<id>${escapeXml(link)}</id>`,
    `<title>${escapeXml(title)}</title>`,
    `<subtitle>${escapeXml(description)}</subtitle>`,
    `<link href="${escapeXml(selfUrl)}" rel="self"/>`,
    `<link href="${escapeXml(link)}" rel="alternate"/>`,
    `<updated>${updated.toISOString()}</updated>`,
    "<generator>telegram-rss-worker</generator>",
  ];

  for (const post of posts) {
    const iso = new Date(post.date).toISOString();
    parts.push(
      "<entry>",
      `<title>${escapeXml(itemTitle(post))}</title>`,
      `<link href="${escapeXml(post.link)}"/>`,
      `<id>${escapeXml(post.link)}</id>`,
      `<updated>${iso}</updated>`,
      `<published>${iso}</published>`,
      `<author><name>${escapeXml(post.author || title)}</name></author>`,
      `<content type="html">${cdata(itemBody(post))}</content>`,
      `<summary>${cdata(post.text || "")}</summary>`,
      "</entry>",
    );
  }

  parts.push("</feed>");
  return parts.join("\n");
}

/** one entry per supported URL format: /rss/:channel and /atom/:channel */
const FEED_FORMATS = {
  rss: { render: renderRss, contentType: "application/rss+xml; charset=utf-8" },
  atom: {
    render: renderAtom,
    contentType: "application/atom+xml; charset=utf-8",
  },
};

/* ------------------------------------------------------------------ */
/* feed handler                                                         */
/* ------------------------------------------------------------------ */

/** "/rss/<channel>" or "/atom/<channel>" -> { format, channel }, otherwise null */
export function parseFeedRoute(path) {
  const match = /^\/(rss|atom)\/(.+)$/.exec(path);
  return match ? { format: match[1], channel: safeDecode(match[2]) } : null;
}

const cacheRequest = (origin, format, value) =>
  new Request(`${origin}/__cache/${format}/${encodeURIComponent(value)}`);

/** query options are honoured only for API_KEY requests; token holders get the plain default feed */
function getFeedOptions(request, url, env, isAdmin) {
  const param = (name) => (isAdmin ? url.searchParams.get(name) : null);
  const defaultDays = positiveNumber(env.FEED_DAYS, DEFAULT_FEED_WINDOW_DAYS);
  const days = positiveNumber(param("days"), defaultDays);
  const limit = Math.min(
    positiveNumber(param("limit"), MAX_POSTS_PER_FEED),
    MAX_POSTS_PER_FEED,
  );
  const pages = Math.min(
    positiveNumber(param("pages"), DEFAULT_PREVIEW_PAGES),
    MAX_PREVIEW_PAGES,
  );
  const forceRefresh = param("refresh") === "1";

  return {
    limit,
    pages,
    forceRefresh,
    cutoff: Date.now() - days * MS_PER_DAY,
    ttlMs: positiveNumber(env.CACHE_TTL, DEFAULT_CACHE_TTL_SECONDS) * 1000,
    // only the default GET feed is cached; HEAD and customised requests bypass it
    cacheable:
      request.method === "GET" &&
      !forceRefresh &&
      days === defaultDays &&
      limit === MAX_POSTS_PER_FEED,
  };
}

function shouldFetchPreview({ forceRefresh, posts, channel, ref, now, ttlMs }) {
  const webhookIsFresh =
    channel?.webhook_at != null &&
    now - channel.webhook_at < WEBHOOK_FRESH_WINDOW_MS;
  const previewIsStale =
    channel?.fetched_at == null || now - channel.fetched_at > ttlMs;
  // private channels (numeric id, no username) are available only via the webhook
  const isPrivate = ref.kind === "numeric" && !channel?.username;

  return (
    !isPrivate &&
    (forceRefresh || !posts.length || (!webhookIsFresh && previewIsStale))
  );
}

/** reads channel + posts from D1, topping up from the public preview when stale */
async function loadFeed(env, ref, options) {
  const { cutoff, limit, pages, forceRefresh, ttlMs } = options;
  let channel = await findChannel(env, ref);
  let posts = channel ? await getPosts(env, channel.key, cutoff, limit) : [];

  if (
    shouldFetchPreview({
      forceRefresh,
      posts,
      channel,
      ref,
      now: Date.now(),
      ttlMs,
    })
  ) {
    // a numeric ref to a channel with a known username scrapes via the username
    const scrapeRef = channel?.username
      ? normalizeChannelRef(channel.username)
      : ref;
    const preview = await fetchPreview(scrapeRef, pages, cutoff);
    if (preview.posts.length || preview.meta.title) {
      channel = buildChannel(preview, channel, ref);
      await persistPreview(env, channel, preview.posts);
      posts = await getPosts(env, channel.key, cutoff, limit);
    }
  }

  return { channel, posts };
}

/** posts without a preview image get a signed /media URL, so the bot token never leaks */
async function signPostMedia(posts, origin, env) {
  if (!env.BOT_TOKEN) return posts;

  const sign = await createSigner(env);
  return Promise.all(
    posts.map(async (post) => {
      if (post.image || !post.file_id) return post;

      const fileId = encodeURIComponent(post.file_id);
      const signature = await sign(post.file_id);
      return { ...post, image: `${origin}/media/${fileId}?sig=${signature}` };
    }),
  );
}

/** drop cached feeds for a channel so a new post shows up immediately */
async function purgeChannelCache(
  origin,
  { username = "", chatId = "", token = "" },
) {
  const values = [
    String(username || "").toLowerCase(),
    publicId(chatId),
    token && `token:${token}`,
  ].filter(Boolean);
  await Promise.all(
    values.flatMap((value) =>
      Object.keys(FEED_FORMATS).map((format) =>
        caches.default.delete(cacheRequest(origin, format, value)),
      ),
    ),
  );
}

/**
 * Serves /rss|atom/<segment>. The segment is either a channel (needs API_KEY) or a
 * channel token (no key needed, opens only that channel's default feed).
 */
async function handleFeed(
  request,
  env,
  ctx,
  { format, channel: segment },
  isAdmin,
) {
  const url = new URL(request.url);
  const options = getFeedOptions(request, url, env, isAdmin);
  const cached = (key) =>
    options.cacheable ? caches.default.match(key) : undefined;

  // cache entries under a token key exist only for tokens that were already validated
  const token = FEED_TOKEN_PATTERN.test(segment) ? segment : "";
  const tokenCacheKey = cacheRequest(url.origin, format, `token:${token}`);
  if (token) {
    const hit = await cached(tokenCacheKey);
    if (hit) return hit;
  }

  const tokenChannel = token ? await findChannelByToken(env, token) : null;
  if (!tokenChannel && !isAdmin) return unauthorized();

  const ref = normalizeChannelRef(
    tokenChannel
      ? tokenChannel.username || tokenChannel.chat_id || tokenChannel.key
      : segment,
  );
  if (!ref.value) return json({ ok: false, error: "missing channel" }, 400);

  const cacheKey = tokenChannel
    ? tokenCacheKey
    : cacheRequest(url.origin, format, ref.value);
  if (!tokenChannel) {
    const hit = await cached(cacheKey);
    if (hit) return hit;
  }

  const { channel, posts } = await loadFeed(env, ref, options);
  if (!channel) {
    return json(
      {
        ok: false,
        error: "channel not found",
        hint: "Public channels need a t.me/s preview. Private channels need the bot as channel admin plus the registered webhook, and appear after their first post.",
      },
      404,
    );
  }

  // a forced refresh also drops the cached default variants (by name and by token)
  if (options.forceRefresh) {
    ctx.waitUntil(
      purgeChannelCache(url.origin, {
        username: channel.username,
        chatId: channel.chat_id,
        token: await getFeedToken(env, channel.key),
      }),
    );
  }

  const { render, contentType } = FEED_FORMATS[format];
  const selfUrl = url.origin + url.pathname;
  const body = render(
    channel,
    await signPostMedia(posts, url.origin, env),
    selfUrl,
  );
  const response = new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${Math.floor(options.ttlMs / 1000)}`,
      "x-robots-tag": "noindex, nofollow",
    },
  });
  if (options.cacheable)
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

/* ------------------------------------------------------------------ */
/* other routes                                                         */
/* ------------------------------------------------------------------ */

async function handleWebhook(request, env, ctx, origin) {
  const expected = String(env.WEBHOOK_SECRET || "").trim();
  if (!expected)
    return json(
      { ok: false, error: "webhook disabled (WEBHOOK_SECRET not set)" },
      503,
    );

  const header = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!(await safeEq(header, expected)))
    return json({ ok: false, error: "bad secret" }, 403);

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  // channel posts only -- groups the bot happens to sit in are ignored
  const msg = update.channel_post || update.edited_channel_post;
  if (!msg?.chat) return json({ ok: true, skipped: true });

  const chat = msg.chat;
  const key = channelKey(chat.id, chat.username);
  const channel = {
    key,
    chat_id: String(chat.id ?? ""),
    username: chat.username || "",
    title: chat.title || "",
    link: channelLink(chat),
  };

  await env.DB.batch([
    upsertChannelStmt(env, channel, { webhookAt: Date.now() }),
    upsertPostStmt(env, key, normalizeTelegramPost(msg), true),
  ]);
  ctx.waitUntil(
    purgeChannelCache(origin, {
      username: chat.username,
      chatId: chat.id,
      token: await getFeedToken(env, key),
    }),
  );
  return json({ ok: true, message_id: msg.message_id });
}

async function handleMedia(env, fileId, sig) {
  if (!env.BOT_TOKEN || !env.API_KEY)
    return json({ ok: false, error: "forbidden" }, 403);

  const sign = await createSigner(env);
  if (!(await safeEq(sig, await sign(fileId))))
    return json({ ok: false, error: "forbidden" }, 403);

  const meta = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`,
  )
    .then((r) => r.json())
    .catch(() => null);
  const path = meta?.result?.file_path;
  if (!path) return json({ ok: false, error: "file not found" }, 404);

  const upstream = await fetch(
    `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`,
  );
  if (!upstream.ok) return json({ ok: false, error: "upstream error" }, 502);

  const type = upstream.headers.get("content-type") || "";
  return new Response(upstream.body, {
    headers: {
      "content-type": type.startsWith("image/") ? type : "image/jpeg",
      "cache-control": "public, max-age=86400, immutable",
    },
  });
}

async function handleSetupWebhook(env, url) {
  if (!env.BOT_TOKEN)
    return json({ ok: false, error: "BOT_TOKEN is not configured" }, 400);

  const secret = String(env.WEBHOOK_SECRET || "").trim();
  // Telegram only allows A-Z a-z 0-9 _ - (1..256 chars) in secret_token
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    return json(
      { ok: false, error: "WEBHOOK_SECRET must match [A-Za-z0-9_-]{1,256}" },
      400,
    );
  }

  const target = `${url.origin}/hook`;
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: target,
        secret_token: secret,
        allowed_updates: ["channel_post", "edited_channel_post"],
        drop_pending_updates: true,
        max_connections: 10,
      }),
    },
  );
  const payload = await res.json().catch(() => ({}));
  return json({
    ok: res.ok && payload?.ok !== false,
    webhook: target,
    result: payload,
  });
}

/** every known channel, newest first, with its token and both URL forms (token / name + key) */
async function handleFeeds(env, origin) {
  const { results } = await env.DB.prepare(
    "SELECT key, title, username, chat_id, link, feed_token, updated_at FROM channels ORDER BY updated_at DESC",
  ).all();

  const channels = results.map((channel) => {
    const token = channel.feed_token;
    const name = encodeURIComponent(channel.username || channel.chat_id);
    const urls = (format) => ({
      by_token: `${origin}/${format}/${token}`,
      by_name: `${origin}/${format}/${name}?key=YOUR_KEY`,
    });
    return {
      key: channel.key,
      title: channel.title,
      username: channel.username,
      link: channel.link,
      updated_at: channel.updated_at,
      token,
      rss: urls("rss"),
      atom: urls("atom"),
    };
  });
  return json({ ok: true, count: channels.length, channels });
}

const HELP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Telegram &rarr; RSS Worker</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font: 15px/1.6 system-ui, -apple-system, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 20px; color: #222; }
  code, pre { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; }
  pre { padding: 12px; overflow: auto; }
  h1 { font-size: 22px; }
  h2 { font-size: 17px; margin-top: 32px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e4e4e7; vertical-align: top; }
  th { font-weight: 600; }
</style>
</head>
<body>
<h1>Telegram &rarr; RSS</h1>
<p>Converts a Telegram channel into an RSS or Atom feed.</p>

<h2>Endpoints</h2>
<table>
<tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr>
<tr><td>GET</td><td><code>/</code></td><td>none</td><td>This page</td></tr>
<tr><td>GET</td><td><code>/health</code></td><td>none</td><td>Liveness probe</td></tr>
<tr><td>GET</td><td><code>/rss/&lt;channel&gt;</code></td><td>API key</td><td>RSS 2.0 feed</td></tr>
<tr><td>GET</td><td><code>/atom/&lt;channel&gt;</code></td><td>API key</td><td>Atom 1.0 feed</td></tr>
<tr><td>GET</td><td><code>/rss/&lt;token&gt;</code><br><code>/atom/&lt;token&gt;</code></td><td>channel token</td><td>The same feed for one channel, without the API key</td></tr>
<tr><td>GET</td><td><code>/feeds</code></td><td>API key</td><td>JSON list of known channels with their tokens and both URL forms</td></tr>
<tr><td>GET</td><td><code>/media/&lt;fileId&gt;?sig=&hellip;</code></td><td>signature</td><td>Signed media proxy; the URLs are generated inside feeds</td></tr>
<tr><td>POST</td><td><code>/admin/setup-webhook</code></td><td>API key</td><td>Register the Telegram webhook</td></tr>
<tr><td>POST</td><td><code>/hook</code></td><td>Telegram secret header</td><td>Telegram webhook sink (called by Telegram)</td></tr>
</table>

<h2>Authentication</h2>
<p>
  Endpoints marked <em>API key</em> take the key as <code>?key=YOUR_KEY</code>
  or as <code>Authorization: Bearer YOUR_KEY</code>.
  A key containing <code>=</code>, <code>&amp;</code>, <code>+</code> or <code>%</code>
  must be percent-encoded in the query string; the header needs no encoding.
</p>
<pre>curl "https://HOST/rss/&lt;channel&gt;?key=YOUR_KEY"
curl -H "Authorization: Bearer YOUR_KEY" "https://HOST/atom/&lt;channel&gt;"</pre>

<h2>Feed tokens</h2>
<p>
  Give feed readers the token URL, so the API key never leaves your hands.
  <code>GET /feeds</code> (API key) lists each channel's token and both URL forms.
  A token is random, stored in D1, and opens only its own channel's default feed;
  query options are ignored.
</p>
<pre>curl "https://HOST/feeds?key=YOUR_KEY"
curl "https://HOST/rss/&lt;token&gt;"</pre>

<h2>Channel</h2>
<p>
  <code>&lt;channel&gt;</code> may be <code>@name</code>, <code>name</code>,
  <code>t.me/name</code>, <code>c/123456789</code> or the numeric chat id.
</p>

<h2>Feed options</h2>
<p>These apply to requests that carry the API key; token URLs ignore them.</p>
<table>
<tr><th>Param</th><th>Default</th><th>Meaning</th></tr>
<tr><td><code>limit</code></td><td>${MAX_POSTS_PER_FEED}</td><td>Max posts in the feed (also the upper bound)</td></tr>
<tr><td><code>days</code></td><td>${DEFAULT_FEED_WINDOW_DAYS}</td><td>How many days back the feed reaches</td></tr>
<tr><td><code>pages</code></td><td>${DEFAULT_PREVIEW_PAGES}</td><td>Preview pages to scrape per refresh (max ${MAX_PREVIEW_PAGES})</td></tr>
<tr><td><code>refresh=1</code></td><td>off</td><td>Skip the cache and rescrape now; with <code>pages=N</code> it doubles as a backfill</td></tr>
</table>

<h2>Backfill</h2>
<p>
  A normal request scrapes only the newest ${DEFAULT_PREVIEW_PAGES} preview pages.
  To load older history, force a refresh and ask for more pages (max ${MAX_PREVIEW_PAGES}).
  Scraping stops early once it reaches posts older than <code>days</code>.
  This works for public channels; private channels fill up through the webhook.
</p>
<pre># scrape up to ${MAX_PREVIEW_PAGES} preview pages, discard the XML, print the HTTP status
curl -s -o /dev/null -w "%{http_code}" "https://HOST/rss/&lt;channel&gt;?key=YOUR_KEY&amp;refresh=1&amp;pages=${MAX_PREVIEW_PAGES}"

# reach further back (also needs FEED_DAYS &gt;= 90, see below)
curl -s -o /dev/null -w "%{http_code}" "https://HOST/rss/&lt;channel&gt;?key=YOUR_KEY&amp;refresh=1&amp;pages=${MAX_PREVIEW_PAGES}&amp;days=90"

# check that the channel is now stored
curl "https://HOST/feeds?key=YOUR_KEY"</pre>
<p>
  Posts older than <code>FEED_DAYS</code> (default ${DEFAULT_FEED_WINDOW_DAYS} days) are removed by the cleanup cron,
  so raise that setting if you want a longer history to stay.
</p>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* entrypoint                                                           */
/* ------------------------------------------------------------------ */

/** public routes first, then everything behind the API key */
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const { method } = request;

  // public routes
  if (path === "/health") return json({ ok: true, ts: Date.now() });

  if (path === "/") {
    return new Response(HELP_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  }

  if (path === "/hook") {
    if (method !== "POST") return methodNotAllowed();
    return handleWebhook(request, env, ctx, url.origin);
  }

  if (path.startsWith("/media/")) {
    if (method !== "GET") return methodNotAllowed();
    return handleMedia(
      env,
      safeDecode(path.slice("/media/".length)),
      url.searchParams.get("sig") || "",
    );
  }

  const isAdmin = await isAuthorized(request, url, env);
  const isRead = method === "GET" || method === "HEAD";

  // feeds take an API key or a channel token (handleFeed decides which)
  const feed = parseFeedRoute(path);
  if (feed) {
    if (!isRead) return methodNotAllowed();
    return handleFeed(request, env, ctx, feed, isAdmin);
  }

  // everything below needs API_KEY
  if (!isAdmin) return unauthorized();

  if (path === "/admin/setup-webhook") {
    if (method !== "POST") return methodNotAllowed();
    return handleSetupWebhook(env, url);
  }

  if (path === "/feeds") {
    if (!isRead) return methodNotAllowed();
    return handleFeeds(env, url.origin);
  }

  return json({ ok: false, error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      // `await` is required: a bare `return route(...)` would let a rejected
      // handler promise skip this catch and surface as an unhandled Worker error
      return await route(request, env, ctx);
    } catch (err) {
      return json({ ok: false, error: String(err?.stack || err) }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
