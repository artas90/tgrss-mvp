# Telegram → RSS · Cloudflare Worker

Turns a Telegram channel into an **RSS 2.0** or **Atom** feed, served from the edge and
protected by a key. Posts are stored in **Cloudflare D1**; the public preview page is
parsed with **HTMLRewriter**.

```
https://telegram-rss.<account>.workers.dev/rss/telegram?key=YOUR_KEY
```

## Contents

[Secrets](#secrets) · [Quick start](#quick-start) · [Access](#access) ·
[Live updates](#live-updates-and-private-channels) · [Endpoints](#endpoints) ·
[Configuration](#configuration) · [Retention](#retention) ·
[Older posts](#loading-older-posts) · [Storage](#storage) ·
[Local dev](#local-development) · [Notes](#notes) ·
[Troubleshooting](#troubleshooting) · [Migrating](#migrating-from-the-kv-version)

---

## Secrets

| Secret | Required | Source | Unlocks |
| --- | --- | --- | --- |
| `API_KEY` | yes | you generate it | access to every feed; also signs media URLs |
| `WEBHOOK_SECRET` | for the webhook | you generate it | authenticating Telegram's webhook calls |
| `BOT_TOKEN` | for the webhook | [@BotFather](https://t.me/BotFather) | real-time updates, private channels, photos |

`API_KEY` alone is enough to serve **public** channels from the preview page.

```bash
openssl rand -hex 32   # API_KEY
openssl rand -hex 24   # WEBHOOK_SECRET — only [A-Za-z0-9_-], max 256 chars (Telegram's rule)
```

**Bot token:** in Telegram open @BotFather → `/newbot` → pick a display name and a
username ending in `bot` → copy the token (`7123456789:AAH…`, including the part before
the colon).

Store each one with `./deploy.sh secret put <NAME>`. Check the names with
`./deploy.sh secret list` (values are never shown). Keep the bot token out of git and out
of the wrangler config.

---

## Quick start

```bash
# 1. create the database and copy the printed database_id
npx wrangler d1 create telegram-rss

# 2. keep the id local (gitignored)
echo 'D1_DATABASE_ID=<paste id>' > .env

# 3. create the tables
chmod +x deploy.sh
./deploy.sh d1 execute telegram-rss --remote --file=schema.sql

# 4. secrets (see above)
./deploy.sh secret put API_KEY
./deploy.sh secret put WEBHOOK_SECRET   # optional
./deploy.sh secret put BOT_TOKEN        # optional

# 5. deploy
./deploy.sh deploy
```

### Your final feed URL

`./deploy.sh deploy` prints the worker address, `https://<worker-name>.<account>.workers.dev`
(`telegram-rss` is the worker name from the template). Append the route, the channel and
your `API_KEY`:

```
https://telegram-rss.<account>.workers.dev/rss/telegram?key=4f9c1e0b7a2d8c6e3f5a9b1c7d2e4f60a8b3c5d7e9f102132435465768798a9b
```

| Part | Example | Replace with |
| --- | --- | --- |
| worker name | `telegram-rss` | `name` in `wrangler.template.toml` |
| account subdomain | `<account>` | your Cloudflare workers.dev subdomain (shown at the end of `deploy`); `workers.dev` stays as is |
| route | `/rss/` | `/rss/`, `/atom/`, or one of the query-style routes |
| channel | `telegram` | the channel you want |
| key | `4f9c…` | your `API_KEY` |

For example, with the subdomain `artas90` the host is `telegram-rss.artas90.workers.dev`.
Paste the full URL into your feed reader. More examples, using `KEY` for the key:

| Goal | URL |
| --- | --- |
| RSS | `https://telegram-rss.<account>.workers.dev/rss/telegram?key=KEY` |
| Atom | `https://telegram-rss.<account>.workers.dev/atom/telegram?key=KEY` |
| Channel as a query parameter | `https://telegram-rss.<account>.workers.dev/feed.xml?channel=@telegram&key=KEY` |
| Last 7 days, 20 items | `https://telegram-rss.<account>.workers.dev/rss/telegram?key=KEY&days=7&limit=20` |
| Private channel (needs the bot) | `https://telegram-rss.<account>.workers.dev/rss/-1001234567890?key=KEY` |
| Key in a header instead of the URL | `curl -H "Authorization: Bearer KEY" https://telegram-rss.<account>.workers.dev/rss/telegram` |
| List known channels | `https://telegram-rss.<account>.workers.dev/feeds?key=KEY` |

`<channel>` can be `@name`, `name`, `t.me/name`, `t.me/c/123456789`, or a numeric chat id
(`-1001234567890`); names are case-insensitive.

**Path form or query form?** `/rss/katimsya?key=…` and `/feed.xml?channel=@Katimsya&key=…`
return the same feed from the same cache entry. Use the path form by default. The query
form is for tools that need a fixed path, or for channel references containing slashes
(for example a pasted `https://t.me/c/123…` link).

### Keeping `database_id` out of git

Wrangler reads one config file and does not expand environment variables, so the repo
renders it:

| File | In git | Purpose |
| --- | --- | --- |
| `wrangler.template.toml` | yes | real config, with `database_id = "${D1_DATABASE_ID}"` |
| `.env` | no | `D1_DATABASE_ID=…` |
| `wrangler.toml` | no | generated from the template on every `./deploy.sh` run |
| `deploy.sh` | yes | runs `envsubst`, then forwards all arguments to `wrangler` |

Always call wrangler through `./deploy.sh` (`deploy`, `dev`, `d1 …`, `secret …`).
`envsubst` comes with `gettext`. In CI, export `D1_DATABASE_ID` from a secret and run
`envsubst '${D1_DATABASE_ID}' < wrangler.template.toml > wrangler.toml`.

> A D1 `database_id` is not a credential; it is useless without your API token. With
> wrangler ≥ 4.45 (open beta) you can also omit it and let `wrangler deploy` provision
> the database.

---

## Access

Every feed route needs `API_KEY`, compared through SHA-256 digests with
`timingSafeEqual`.

| Method | Example |
| --- | --- |
| Query parameter | `?key=…` (`?token=` and `?access_token=` also work) |
| Bearer header | `Authorization: Bearer …` |

Requests without a valid key get `401` and no channel content. The feed's own `self` link
never contains the key. Query-string keys can end up in logs, so prefer the header if
your reader supports it.

---

## Live updates and private channels

Without a bot the worker only sees public channels. With a bot you get instant updates,
**private channels**, and photos.

1. Add the bot to the channel as an **administrator** (permission to post messages is
   enough).
2. Register the webhook:

   ```bash
   curl -X POST "https://telegram-rss.<account>.workers.dev/admin/setup-webhook?key=YOUR_KEY"
   ```

   Manual equivalent:

   ```bash
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -d url="https://telegram-rss.<account>.workers.dev/hook" \
     -d secret_token="<WEBHOOK_SECRET>" \
     -d 'allowed_updates=["channel_post","edited_channel_post"]'
   ```

Telegram then calls `POST /hook` with `WEBHOOK_SECRET` in the
`X-Telegram-Bot-Api-Secret-Token` header. New posts are written to D1 and the cached feed
is purged. Only channel posts are stored; groups the bot sits in are ignored.

**Private channels** have no public preview, so they exist only through the webhook:

- A private channel appears after the bot receives its **first post**; until then its
  feed URL returns `404`.
- Request it by numeric id (`-1001234567890`, `1234567890` or `t.me/c/1234567890`).
- The worker never scrapes private channels.

**Media.** Preview posts use the image URL from `t.me`. Webhook photos are served through
`/media/<file_id>?sig=<hmac>`; the signature is an HMAC of the file id keyed with
`API_KEY`, so the bot token never appears in a feed. Rotating `API_KEY` invalidates issued
media URLs until readers refetch the feed. Only photos are proxied (no video, documents
or stickers).

---

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/` · `/health` | – | help page · health probe |
| `GET` | `/rss/:channel` · `/atom/:channel` | key | RSS / Atom feed |
| `GET` | `/rss?channel=…` · `/feed.xml?channel=…` · `/atom?channel=…` | key | same, channel as a query parameter |
| `GET` | `/feeds` | key | known channels |
| `GET` | `/media/:fileId?sig=…` | signature | photo proxy for webhook posts |
| `POST` | `/admin/setup-webhook` | key | register the Telegram webhook |
| `POST` | `/hook` | secret header | Telegram webhook sink |

| Feed parameter | Default | Meaning |
| --- | --- | --- |
| `limit` | `50` (max `500`) | items in the feed |
| `days` | `FEED_DAYS` | only posts newer than N days |
| `pages` | `2` (max `10`) | preview pages scraped on a refresh |
| `refresh=1` | – | force a scrape and bypass the cache; with `pages=N` it is a manual backfill |
| `format=atom` | – | Atom instead of RSS |
| `channel` / `username` | – | channel for the query-style routes |

---

## Configuration

`[vars]` in `wrangler.template.toml`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FEED_DAYS` | `30` | retention window |
| `MAX_POSTS` | `5000` | posts kept per channel, enforced by the nightly cleanup |
| `CACHE_TTL` | `300` | edge cache lifetime and minimum time between scrapes (seconds) |

---

## Retention

A feed exposes only the last `FEED_DAYS` (30) days. The window is applied at four points:

1. **Render:** the query returns only posts newer than the cutoff.
2. **Backfill:** pagination stops at the first page that is entirely older.
3. **Write:** preview posts older than the window are never stored.
4. **Storage:** a daily cron (`17 3 * * *` UTC) deletes posts older than `FEED_DAYS` and
   trims each channel to its newest `MAX_POSTS`.

`?days=N` narrows the window per request. A value above `FEED_DAYS` only returns what is
still stored, so raise `FEED_DAYS` instead. Custom `days` or `limit` values bypass the
edge cache.

> The window is strict: a channel that posts less often than every 30 days returns an
> **empty feed**. Raise `FEED_DAYS` for quiet channels (for example `365`), and keep
> `MAX_POSTS` above `posts_per_day × FEED_DAYS`.

---

## Loading older posts

A feed shows the newest 50 posts of the last `FEED_DAYS` days. To pull in older history:

1. **Raise retention first**, otherwise the nightly cleanup deletes what you backfill.
   In `wrangler.template.toml` set `FEED_DAYS = "365"` and run `./deploy.sh deploy`.
2. **Backfill once** (open it in a browser or `curl` it):

   ```
   https://telegram-rss.<account>.workers.dev/rss/katimsya?key=KEY&refresh=1&pages=10&days=365
   ```

   `refresh=1` forces a scrape and skips the cache, `pages=10` walks back ten preview
   pages, and `days=365` is how far back to go (the default stops at `FEED_DAYS`).
3. **Read it back** with a larger `limit` (max `500`):

   ```
   https://telegram-rss.<account>.workers.dev/rss/katimsya?key=KEY&days=365&limit=300
   ```

Limits: a preview page holds about 20 posts and every refresh starts from the newest post,
so one backfill reaches roughly 200 posts (`pages` is capped at 10 in `handleFeed`). A feed
reader subscribed to the default URL only ever sees the newest 50 items; older ones appear
only if the URL asks for them with `limit`.

---

## Storage

Tables are defined in [`schema.sql`](schema.sql).

- **`channels`** — one row per channel, keyed by lowercase username, or `id:<publicId>`
  when there is none. Holds title, description, logo, `chat_id`, and the `fetched_at` /
  `webhook_at` timestamps.
- **`posts`** — primary key `(chan, id)`: text, HTML, link, date, image URL or photo
  `file_id`, and `source` (`webhook` or `preview`). A webhook post is never overwritten
  by a later scrape of the same message.

**Refresh logic.** A feed request scrapes `t.me/s/<channel>` when forced, when the
channel has no posts, or when the last scrape is older than `CACHE_TTL`, unless a webhook
delivered something within the last hour. Writes go through D1 `batch()`.

**Preview parsing.** HTMLRewriter rebuilds each message body from a tag whitelist
(`a b i u s code pre br blockquote …`) with all attributes dropped, except an `http(s)`
`href` on links.

---

## Local development

```bash
echo 'API_KEY=change-me' > .dev.vars        # gitignored
./deploy.sh d1 execute telegram-rss --local --file=schema.sql
./deploy.sh dev
curl "http://localhost:8787/rss/telegram?key=change-me"
```

---

## Notes

- The public preview shows about 20 posts per page; see
  [Loading older posts](#loading-older-posts) for going further back.
- Overlapping formatting in webhook posts (for example bold plus italic on the same text)
  is not nested; the first entity wins.
- `lastBuildDate` is the newest post's date, and `<language>` is omitted.
- Feeds are sent with `noindex, nofollow`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The reader shows the "Telegram → RSS" help text | it fetched `/`, so the URL has no route | subscribe to the full URL: `…/rss/<channel>?key=…` |
| `401` JSON | missing or wrong key | check `?key=` or the Bearer header against `API_KEY` |
| `404` "channel not found or has no public preview" | wrong name, or the channel has no public preview | check the username; private channels need the bot |
| `404` "unknown private channel" | the bot has not received a post from it yet | add the bot as admin, register the webhook, wait for a post |
| Feed has a title but no items | no posts within `FEED_DAYS` | raise `FEED_DAYS`, or try `&days=365` |
| `curl` cannot resolve the host but the browser can | local DNS, VPN or proxy difference | `nslookup <host> 1.1.1.1`; `curl --doh-url https://cloudflare-dns.com/dns-query …`; check `env \| grep -i proxy` |
| `Could not resolve host … alice …` | the README's placeholder was copied | use your own account subdomain: `telegram-rss.<account>.workers.dev` |
| Photos missing on webhook posts | `BOT_TOKEN` not set, or the media is not a photo | set the secret; only photos are proxied |

To see what is stored for each channel:

```bash
./deploy.sh d1 execute telegram-rss --remote \
  --command "SELECT chan, COUNT(*) AS posts, MAX(date) AS newest FROM posts GROUP BY chan"
```

Live logs: `./deploy.sh tail`.

---

## Migrating from the KV version

- The KV namespace is unused and nothing is migrated. Channels are re-scraped on the
  first request; webhook history older than the preview window is lost.
- Removed: `POST /admin/backfill` (use `?refresh=1&pages=N`), the `/hook/:secret` path
  secret (the header check stays), the `X-API-Key` and `X-Feed-Key` headers, `/rss.xml`,
  `/atom.xml`, and the `POST_TTL_DAYS` and `RESOLVE_MEDIA` variables.
- Run `/admin/setup-webhook` again so Telegram points at the new `/hook` URL.
