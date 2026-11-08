# Telegram → RSS · Cloudflare Worker

Turns any Telegram channel into a standard **RSS 2.0** / **Atom** feed, served from the
edge and protected by a **predefined key**.

```bash
https://telegram-rss-worker.<you>.workers.dev/rss/telegram?key=YOUR_KEY
```

---

## Getting the three values you need

Only three values are required. **Two you invent yourself, one comes from Telegram.**

| Value | Where it comes from | What it unlocks |
| --- | --- | --- |
| `API_KEY` | **You generate it** | Access to the feed — always required |
| `WEBHOOK_SECRET` | **You generate it** | Authenticating the Telegram webhook |
| `BOT_TOKEN` | **@BotFather**, on Telegram | Real-time updates, private channels, inline images |

### `API_KEY`: the predefined feed key

Telegram never issues this one — you choose it. It is the password every reader must
present to open your feed, so generate a long random value rather than something
guessable:

```bash
openssl rand -hex 32
```

The output is 64 hex characters, e.g. `4f9c1e0b7a2d8c6e3f5a…`. Store it as a Worker secret:

```bash
npx wrangler secret put API_KEY
```

Wrangler prompts for the value — paste it and press Enter (the input is not echoed).
The **same string** then goes into your feed URL:

```
https://telegram-rss-worker.<you>.workers.dev/rss/telegram?key=4f9c1e0b7a2d8c6e3f5a…
```

### `WEBHOOK_SECRET`: the webhook shared secret

Also self-generated. It is embedded in the webhook URL path **and** must equal the
`X-Telegram-Bot-Api-Secret-Token` header that Telegram sends, so the worker can reject
calls that did not come from Telegram.

Telegram only accepts `A-Z a-z 0-9 _ -` here (max 256 characters), so stick to hex or
underscores:

```bash
openssl rand -hex 24
```

```bash
npx wrangler secret put WEBHOOK_SECRET
```

**Keep this value** — you need it again for the `setWebhook` call in
[Enabling live updates](#enabling-live-updates-recommended).

### `BOT_TOKEN`: from @BotFather

1. Open Telegram and search for [@BotFather](https://t.me/BotFather) — confirm the blue
   verification check — then press **Start**.
2. Send the command `/newbot`.
3. BotFather asks for a **display name** → any label, e.g. `My RSS Feed`.
4. BotFather asks for a **username** → it must end in `bot`, e.g. `myrssfeedbot`.
5. BotFather replies with the token:

   ```
   Use this token to access the HTTP API:
   7123456789:AAHfqk3xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

   That whole string is the token — copy it including the part before the colon.

```bash
npx wrangler secret put BOT_TOKEN
```

> Treat the bot token like a password: it grants full control of your bot. Keep it out of
> git and out of `wrangler.toml` — Worker secrets are encrypted at rest.

### Checking what you have

```bash
npx wrangler secret list
```

This prints the **names only**, never the values:

```
┌─────────────────┬─────────┐
│ name            │ type    │
├─────────────────┼─────────┤
│ API_KEY         │ secret  │
│ BOT_TOKEN       │ secret  │
│ WEBHOOK_SECRET  │ secret  │
└─────────────────┴─────────┘
```

### Do I need all three?

No. **`API_KEY` alone is enough** to publish feeds for public channels — posts are pulled
from the public preview. Add `BOT_TOKEN` and `WEBHOOK_SECRET` when you want real-time
updates, access to private channels, or inline images.

---

## Why this works without a bot

The worker pulls posts from two sources and merges them:

| Source | When it is used | Requirements |
| --- | --- | --- |
| **Public preview** — `https://t.me/s/<channel>` | Always available as a fallback; used to backfill history | Channel must be public |
| **Bot webhook** — Telegram Bot API `setWebhook` | Gives real-time updates for channels you own (including private ones) | Bot must be an admin of the channel |

So a feed works for *any* public channel immediately after deployment, and gets instant
updates once the bot is added to the channel.

---

## Quick start

**1. Install and create the KV namespace**

```bash
npm install
npx wrangler kv namespace create CHANNEL_KV
```

Copy the printed `id` / `preview_id` into `wrangler.toml`.

**2. Set your secrets**

See [Getting the three values](#getting-the-three-values-you-need) for exactly what each
value is, where it comes from, and how to generate it.

```bash
npx wrangler secret put API_KEY          # the predefined feed key  → required
npx wrangler secret put WEBHOOK_SECRET   # webhook path + header secret → required for live updates
npx wrangler secret put BOT_TOKEN        # token from @BotFather → optional
```

**3. Deploy**

```bash
npm run deploy
```

The feed is now live:

```
https://telegram-rss-worker.<you>.workers.dev/rss/<channel>?key=YOUR_API_KEY
```

`<channel>` accepts `@name`, `name`, `t.me/name`, `t.me/c/123456789` or the raw numeric
chat id (`-1001234567890`).

---

## Access protection

Every feed route requires the predefined key (`API_KEY`). Comparison is constant-time.

| Method | Example |
| --- | --- |
| Query parameter | `GET /rss/telegram?key=YOUR_KEY` |
| Header | `GET /rss/telegram` + `X-API-Key: YOUR_KEY` |
| Bearer token | `GET /rss/telegram` + `Authorization: Bearer YOUR_KEY` |

Responses without a valid key return `401` and never contain channel content.

The Telegram webhook is protected separately by `WEBHOOK_SECRET`, which must appear
**both** in the URL path and in Telegram's `X-Telegram-Bot-Api-Secret-Token` header.

---

## Enabling live updates (recommended)

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token.
2. Add the bot to your channel as an **administrator** (the "post messages" permission is
   enough for `channel_post` updates).
3. Register the webhook — either automatically:

   ```bash
   curl -X POST "https://telegram-rss-worker.<you>.workers.dev/admin/setup-webhook?key=YOUR_KEY"
   ```

   or manually:

   ```bash
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d url="https://telegram-rss-worker.<you>.workers.dev/hook/<WEBHOOK_SECRET>" \
     -d secret_token="<WEBHOOK_SECRET>"
   ```

New posts are written to KV and the cached feed is purged, so readers see them
immediately. Image attachments are resolved through the Bot API (`getFile`) and embedded
as `media:content` / `enclosure`.

---

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/` | – | Help page |
| `GET` | `/health` | – | Health probe |
| `GET` | `/rss/:channel` | key | RSS 2.0 feed |
| `GET` | `/atom/:channel` | key | Atom 1.0 feed |
| `GET` | `/feed.xml?channel=…` | key | RSS alias |
| `GET` | `/feeds` | key | List of harvested channels |
| `POST` | `/admin/backfill` | key | `{"channel":"name","pages":3}` — scrape history |
| `POST` | `/admin/setup-webhook` | key | Register the Telegram webhook |
| `POST` | `/hook/:secret` | secret | Telegram webhook sink |

Feed query parameters: `limit` (default 50), `pages` (default 2 preview pages),
`days` (default 30 — retention window), `refresh=1` (bypass the cache), `format=atom`.

---

## Configuration

`wrangler.toml` `[vars]` — changeable without redeploying secrets:

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_KEY` | – | **The predefined key** guarding all feed routes — [how to get](#api_key-the-predefined-feed-key) |
| `WEBHOOK_SECRET` | – | Secret for the webhook path and header — [how to get](#webhook_secret-the-webhook-shared-secret) |
| `BOT_TOKEN` | – | Telegram bot token — [how to get](#bot_token-from-botfather) |
| `FEED_DAYS` | `30` | **Retention window** — the feed only exposes the last N days |
| `MAX_POSTS` | `1000` | Posts kept per channel in KV (history cap) |
| `CACHE_TTL` | `300` | Edge cache lifetime in seconds |
| `POST_TTL_DAYS` | `30` | How long a stored post expires in KV |
| `RESOLVE_MEDIA` | `1` | Set to `0` to skip Bot API media lookups |

---

## Retention window (last 30 days)

By default a feed only exposes posts from the **last 30 days**. The window is applied at
four points, so old content never leaks through:

1. **At render time** — items older than the cutoff are dropped from the feed, even if
   they are still present in KV (KV expiry is lazy, so this is the real guarantee).
2. **During backfill** — pagination stops as soon as a page is entirely older than the
   window, so history is not fetched needlessly.
3. **During persistence** — posts older than the window are never written to KV.
4. **In storage** — `POST_TTL_DAYS` (30) expires the remaining records.

Adjust it globally with `FEED_DAYS`, or per request with `?days=N`:

```
/rss/telegram?key=YOUR_KEY          # last 30 days (FEED_DAYS)
/rss/telegram?key=YOUR_KEY&days=7   # last 7 days
/rss/telegram?key=YOUR_KEY&days=90  # last 90 days
```

> **Heads-up:** the window is strict, so a channel that posts less often than every 30
> days will return an **empty feed**. Raise `FEED_DAYS` for quiet channels — for example
> `FEED_DAYS=365` for a monthly newsletter. `MAX_POSTS` must stay comfortably above
> `posts_per_day × FEED_DAYS`, or the window gets truncated by the history cap.

Feeds with a custom `?days=` value bypass the edge cache, so a cached feed never
contradicts the window you asked for.

---

## How storage works

* **Key** — the channel's public username (`mychannel`), so a channel is never
  duplicated. Channels without a username fall back to `id:<chatId>`.
* `chan:<key>` — channel metadata (title, description, logo, last update).
* `idx:<key>` — ordered list of message ids.
* `post:<key>:<messageId>` — one post per key, including rendered formatting entities.
* `alias:i:<chatId>` — maps a numeric chat id onto the username key.

Feeds are cached in the Cloudflare cache for `CACHE_TTL` seconds and purged as soon as a
webhook delivers a new post.

---

## Local testing

The test suite runs offline with a mocked KV binding, cache and network:

```bash
npm test
```

For an interactive local server:

```bash
npx wrangler dev
curl "http://localhost:8787/rss/telegram?key=change-me"
```

---

## Notes & limits

* The public preview exposes roughly the **last 20 posts per page**; `?pages=N` or
  `/admin/backfill` walks further back with `?before=<id>`.
* **Private channels** only work through the bot webhook — the public preview is
  unavailable to them.
* KV on the free plan allows 1,000 writes/day. For high-traffic channels prefer a paid
  KV namespace, or `RESOLVE_MEDIA=0` to reduce writes.
* Media URLs resolved via the Bot API are valid for ~1 hour; the worker refreshes them
  in the background.
* Feeds are marked `noindex, nofollow` so they are not picked up by search engines.
