/**
 * Local test harness — no network, no Cloudflare account required.
 *
 *   node test/local-test.mjs
 *
 * Mocks the Workers KV binding, the Cache API and global fetch, then drives
 * the worker's fetch() handler end to end.
 */

import worker from '../src/index.js';

/* ---------------------------------------------------------------- */
/* mock KV                                                           */
/* ---------------------------------------------------------------- */
class MockKV {
  constructor() {
    this.store = new Map();
  }
  async get(key, type) {
    const v = this.store.get(key);
    if (v === undefined) return null;
    if (type === 'json') return JSON.parse(v);
    return v;
  }
  async put(key, value) {
    this.store.set(key, value);
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name }))
      .slice(0, limit);
    return { keys, list_complete: true, cursor: '' };
  }
}

/* ---------------------------------------------------------------- */
/* mock cache                                                        */
/* ---------------------------------------------------------------- */
class MockCache {
  constructor() {
    this.map = new Map();
  }
  key(req) {
    return typeof req === 'string' ? req : req.url;
  }
  async match(req) {
    const hit = this.map.get(this.key(req));
    return hit ? hit.clone() : undefined;
  }
  async put(req, res) {
    this.map.set(this.key(req), res.clone());
  }
  async delete(req) {
    this.map.delete(this.key(req));
  }
}

/* ---------------------------------------------------------------- */
/* mock telegram preview page                                         */
/* ---------------------------------------------------------------- */
const PREVIEW_HTML = `<!DOCTYPE html><html><head>
<meta property="og:title" content="My Channel"></head><body>
<div class="tgme_channel_info">
  <div class="tgme_channel_info_header_image" style="background-image:url('https://cdn.example/logo.jpg')"></div>
  <div class="tgme_channel_info_header_title"><span dir="auto">My Channel</span></div>
  <div class="tgme_channel_info_description">Latest news &amp; updates</div>
</div>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message js-widget_message" data-post="mychannel/102">
    <div class="tgme_widget_message_date"><time datetime="${new Date(Date.now() - 7200_000).toISOString()}">1 May</time></div>
    <div class="tgme_widget_message_text js-message_text">Hello <b>world</b> &amp; friends</div>
    <div class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn.example/photo1.jpg')"></div>
    <span class="tgme_widget_message_views">1.2K</span>
  </div>
</div>
<div class="tgme_widget_message_wrap">
  <div class="tgme_widget_message js-widget_message" data-post="mychannel/101">
    <div class="tgme_widget_message_date"><time datetime="${new Date(Date.now() - 86400_000).toISOString()}">30 Apr</time></div>
    <div class="tgme_widget_message_text js-message_text">Second post</div>
    <span class="tgme_widget_message_views">900</span>
  </div>
</div>
</body></html>`;

/* ---------------------------------------------------------------- */
/* mock channel with one ancient and one fresh post                 */
/* ---------------------------------------------------------------- */
const FRESH_DATE = new Date(Date.now() - 3600_000).toISOString();
const OLD_CHANNEL_HTML = `<!DOCTYPE html><html><body>
<div class="tgme_channel_info">
  <div class="tgme_channel_info_header_title"><span dir="auto">Old Channel</span></div>
</div>
<div class="tgme_widget_message js-widget_message" data-post="oldchannel/11">
  <div class="tgme_widget_message_date"><time datetime="${FRESH_DATE}">now</time></div>
  <div class="tgme_widget_message_text js-message_text">Recent post</div>
</div>
<div class="tgme_widget_message js-widget_message" data-post="oldchannel/10">
  <div class="tgme_widget_message_date"><time datetime="2020-01-01T00:00:00+00:00">then</time></div>
  <div class="tgme_widget_message_text js-message_text">Ancient post</div>
</div>
</body></html>`;

/* ---------------------------------------------------------------- */
/* test runner                                                       */
/* ---------------------------------------------------------------- */
let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const env = {
  API_KEY: 's3cret-key',
  WEBHOOK_SECRET: 'hook-secret',
  BOT_TOKEN: '123456:BOTTOKEN',
  MAX_POSTS: '300',
  CACHE_TTL: '300',
  POST_TTL_DAYS: '30',
  FEED_DAYS: '30',
  RESOLVE_MEDIA: '1',
  CHANNEL_KV: new MockKV(),
};

globalThis.caches = { default: new MockCache() };

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  if (url.includes('/s/oldchannel')) {
    return new Response(OLD_CHANNEL_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (url.startsWith('https://t.me/s/')) {
    return new Response(PREVIEW_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (url.startsWith('https://api.telegram.org/')) {
    return new Response(
      JSON.stringify({ ok: true, result: { file_path: 'photos/file_1.jpg' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return realFetch(input, init);
};

const ctx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((err) => console.error('  [waitUntil error]', err));
  },
};

const ORIGIN = 'https://rss.example.workers.dev';

async function call(path, init = {}) {
  const req = new Request(`${ORIGIN}${path}`, init);
  return worker.fetch(req, env, ctx);
}

console.log('\n1. Authentication');
{
  const res = await call('/rss/mychannel');
  check('no key → 401', res.status === 401, `got ${res.status}`);

  const wrong = await call('/rss/mychannel?key=nope');
  check('wrong key → 401', wrong.status === 401, `got ${wrong.status}`);

  const ok = await call('/rss/mychannel?key=s3cret-key');
  check('query key → 200', ok.status === 200, `got ${ok.status}`);

  const header = await call('/rss/mychannel', { headers: { 'X-API-Key': 's3cret-key' } });
  check('X-API-Key header → 200', header.status === 200, `got ${header.status}`);

  const bearer = await call('/rss/mychannel', {
    headers: { Authorization: 'Bearer s3cret-key' },
  });
  check('Bearer token → 200', bearer.status === 200, `got ${bearer.status}`);
}

console.log('\n2. RSS rendering (public preview backfill)');
let xml = '';
{
  const res = await call('/rss/mychannel?key=s3cret-key');
  xml = await res.text();
  check('content-type is rss+xml', (res.headers.get('content-type') || '').includes('application/rss+xml'));
  check('is valid XML header', xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  check('has <rss version="2.0">', xml.includes('<rss version="2.0"'));
  check('channel title from preview', xml.includes('<title>My Channel</title>'));
  check('description decoded', xml.includes('Latest news &amp; updates'));
  check('contains 2 items', (xml.match(/<item>/g) || []).length === 2, `got ${(xml.match(/<item>/g) || []).length}`);
  check('post link built', xml.includes('https://t.me/mychannel/102'));
  check('post link backfilled', xml.includes('https://t.me/mychannel/101'));
  check('html entities rendered', xml.includes('<b>world</b>'));
  check('ampersand escaped in CDATA text', xml.includes('Hello <b>world</b> &amp; friends'));
  check('pubDate present', /<pubDate>[^<]+<\/pubDate>/.test(xml));
  check('image media tag', xml.includes('media:content'));
  check('self link', xml.includes('rel="self"'));
}

console.log('\n3. Atom rendering');
{
  const res = await call('/atom/mychannel?key=s3cret-key');
  const atom = await res.text();
  check('content-type is atom+xml', (res.headers.get('content-type') || '').includes('application/atom+xml'));
  check('has feed root', atom.includes('<feed xmlns="http://www.w3.org/2005/Atom">'));
  check('has entries', (atom.match(/<entry>/g) || []).length === 2);
  check('entry id = permalink', atom.includes('<id>https://t.me/mychannel/102</id>'));
}

console.log('\n4. Channel reference forms');
{
  const byAt = await call('/rss/@mychannel?key=s3cret-key');
  check('@username accepted', byAt.status === 200);
  const byUrl = await call('/rss/https%3A%2F%2Ft.me%2Fmychannel?key=s3cret-key');
  check('t.me URL accepted', byUrl.status === 200);
  const byQuery = await call('/rss?channel=mychannel&key=s3cret-key');
  check('?channel= accepted', byQuery.status === 200);
  const numeric = await call('/rss/c/123456789?key=s3cret-key');
  check('numeric channel accepted', numeric.status === 200);
}

console.log('\n5. Webhook ingest');
{
  const badSecret = await call('/hook/wrong', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
    body: '{}',
  });
  check('wrong path secret → 403', badSecret.status === 403, `got ${badSecret.status}`);

  const badHeader = await call('/hook/hook-secret', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'nope' },
    body: '{}',
  });
  check('wrong header secret → 403', badHeader.status === 403, `got ${badHeader.status}`);

  const update = {
    update_id: 1,
    channel_post: {
      message_id: 103,
      date: Math.floor(Date.now() / 1000) - 3600, // must be inside the 30-day window
      chat: { id: -1001234567890, title: 'My Channel', username: 'mychannel', type: 'channel' },
      text: 'Fresh from the bot',
      entities: [{ type: 'bold', offset: 0, length: 5 }],
      views: 42,
    },
  };

  const ok = await call('/hook/hook-secret', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook-secret' },
    body: JSON.stringify(update),
  });
  check('valid webhook → 200', ok.status === 200, `got ${ok.status}`);

  const stored = env.CHANNEL_KV.store.get('chan:mychannel');
  check('channel metadata persisted under username key', Boolean(stored));

  const idx = JSON.parse(env.CHANNEL_KV.store.get('idx:mychannel'));
  check('index contains new post id', idx.includes(103), JSON.stringify(idx));

  const post = JSON.parse(env.CHANNEL_KV.store.get('post:mychannel:000000000103'));
  check('post record persisted', post && post.text === 'Fresh from the bot');

  const alias = JSON.parse(env.CHANNEL_KV.store.get('alias:i:-1001234567890'));
  check('chat-id alias resolves to username key', alias === 'mychannel');

  const feed = await call('/rss/mychannel?key=s3cret-key&refresh=1');
  const body = await feed.text();
  check('webhook post appears in feed', body.includes('Fresh from the bot'));
  check('bold entity rendered', body.includes('<b>Fresh</b>'));
  check('author from chat title', body.includes('<dc:creator>My Channel</dc:creator>'));
}

console.log('\n6. Feed listing + admin');
{
  const list = await call('/feeds?key=s3cret-key');
  const data = await list.json();
  check('/feeds → 200', list.status === 200);
  check('lists 1 channel', data.channels.length === 1, JSON.stringify(data.count));

  const unauth = await call('/feeds');
  check('/feeds without key → 401', unauth.status === 401);

  const setup = await call('/admin/setup-webhook?key=s3cret-key', { method: 'POST' });
  const setupData = await setup.json();
  check('setup-webhook calls Telegram API', setupData.ok === true, JSON.stringify(setupData));
  check('webhook url contains secret', String(setupData.webhook || '').endsWith('/hook/hook-secret'));

  const backfill = await call('/admin/backfill?key=s3cret-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'mychannel', pages: 2 }),
  });
  const bf = await backfill.json();
  check('backfill returns posts', bf.ok === true && bf.posts >= 2, JSON.stringify(bf));
}

console.log('\n7. Health + 404');
{
  const health = await call('/health');
  const h = await health.json();
  check('/health → 200', health.status === 200 && h.ok === true);

  const missing = await call('/nothing?key=s3cret-key');
  check('unknown route → 404', missing.status === 404, `got ${missing.status}`);
}

console.log('\n8. 30-day retention window');
{
  const res = await call('/rss/oldchannel?key=s3cret-key');
  const body = await res.text();
  check('feed includes recent post', body.includes('Recent post'));
  check('feed excludes post older than 30 days', !body.includes('Ancient post'));
  check('feed has exactly 1 item', (body.match(/<item>/g) || []).length === 1, `got ${(body.match(/<item>/g) || []).length}`);

  await new Promise((r) => setTimeout(r, 20)); // let the background persist settle
  check('ancient post not stored in KV', !env.CHANNEL_KV.store.has('post:oldchannel:000000000010'));
  check('recent post stored in KV', env.CHANNEL_KV.store.has('post:oldchannel:000000000011'));

  const idx = JSON.parse(env.CHANNEL_KV.store.get('idx:oldchannel'));
  check('index only holds in-window ids', JSON.stringify(idx) === '[11]', JSON.stringify(idx));

  const narrow = await call('/rss/oldchannel?key=s3cret-key&days=1');
  const narrowBody = await narrow.text();
  check('?days=1 still serves a 1-hour-old post', narrowBody.includes('Recent post'));

  const wide = await call('/rss/oldchannel?key=s3cret-key&days=3650');
  const wideBody = await wide.text();
  check('?days=3650 cannot resurrect filtered posts', !wideBody.includes('Ancient post'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
