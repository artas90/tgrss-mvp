# Telegram → RSS · Cloudflare Worker

Turns a Telegram channel into an **RSS 2.0** or **Atom** feed, served from the edge and
protected by a key. Posts are stored in **Cloudflare D1**. Public channels are read from
their `t.me/s/<name>` preview page (parsed with HTMLRewriter); an optional bot webhook adds
live updates and private channels.

```
https://telegram-rss.<account>.workers.dev/rss/telegram?key=YOUR_KEY
```

## Quick start

```bash
# 1. create the database and note the printed database_id
npx wrangler d1 create telegram-rss

# 2. keep the id local (gitignored)
echo 'D1_DATABASE_ID=<paste id>' > .env
chmod +x deploy.sh

# 3. create the tables (including the per-channel feed tokens)
./deploy.sh d1 execute telegram-rss --remote --file=schema.sql

# 4. secrets, see below (WEBHOOK_SECRET and BOT_TOKEN are optional)
./deploy.sh secret put API_KEY
./deploy.sh secret put WEBHOOK_SECRET
./deploy.sh secret put BOT_TOKEN

# 5. deploy
./deploy.sh deploy
```

**Upgrading an existing database** (created before feed tokens): run
`./deploy.sh d1 execute telegram-rss --remote --file=migrate_feed_token.sql` once **before**
you deploy this version. It adds `channels.feed_token`, gives every existing channel a random
token and adds a unique index; the worker fails on a database without that column. A new
database needs only `schema.sql`.

Always run wrangler through `./deploy.sh`. It renders the git-ignored `wrangler.toml` from
`wrangler.template.toml` and `.env` by replacing the `__D1_DATABASE_ID__` placeholder
(`database_id = "__D1_DATABASE_ID__"` in the template), which keeps `database_id` out of
git. In CI, take `D1_DATABASE_ID` from a secret and run
`sed "s|__D1_DATABASE_ID__|$D1_DATABASE_ID|g" wrangler.template.toml > wrangler.toml`.

### Secrets

| Secret | Required | How to get it |
| --- | --- | --- |
| `API_KEY` | yes | `openssl rand -hex 32`. Unlocks every feed and signs media URLs. |
| `WEBHOOK_SECRET` | for the webhook | `openssl rand -hex 24`. Only `[A-Za-z0-9_-]`, max 256 chars (Telegram's rule). |
| `BOT_TOKEN` | for the webhook | [@BotFather](https://t.me/BotFather) → `/newbot`. Gives live updates, private channels, photos. |

`API_KEY` alone is enough for **public** channels. Keep the bot token out of git and out of
the wrangler config. `./deploy.sh secret list` shows the names, never the values.

### Your feed URL

`./deploy.sh deploy` prints the worker address, `https://telegram-rss.<account>.workers.dev`
(`telegram-rss` is `name` in `wrangler.template.toml`, `<account>` is your workers.dev
subdomain). Below, `HOST` stands for that address and `KEY` for your `API_KEY`.

**Give feed readers the channel token URL, not the key.** Each channel has its own token,
which opens only that channel's feed. A channel is listed once it has been fetched (open
`HOST/rss/<channel>?key=KEY` once) or, for a private channel, once the bot has received its
first post. List every channel with its token and both URL forms:

```bash
curl "HOST/feeds?key=KEY"
```

| Goal | URL |
| --- | --- |
| RSS, token (for readers) | `HOST/rss/:<token>` |
| Atom, token (for readers) | `HOST/atom/:<token>` |
| RSS, by name | `HOST/rss/telegram?key=KEY` |
| Atom, by name | `HOST/atom/telegram?key=KEY` |
| Last 7 days, 20 items | `HOST/rss/telegram?key=KEY&days=7&limit=20` |
| Private channel (needs the bot) | `HOST/rss/-1001234567890?key=KEY` |
| Key in a header | `curl -H "Authorization: Bearer KEY" HOST/rss/telegram` |

`<channel>` can be `@name`, `name`, `t.me/name`, `t.me/c/123456789` or a numeric chat id
(`-1001234567890`). Names are case-insensitive.

---

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/` · `/health` | – | help page · health probe |
| `GET` | `/rss/:channel` · `/atom/:channel` | key | RSS / Atom feed |
| `GET` | `/rss/:<token>` · `/atom/:<token>` | channel token | the same feed for one channel, no key needed |
| `GET` | `/feeds` | key | JSON list of known channels with their tokens and both URL forms |
| `GET` | `/media/:fileId?sig=…` | signature | photo proxy for webhook posts |
| `POST` | `/admin/setup-webhook` | key | register the Telegram webhook |
| `POST` | `/hook` | secret header | Telegram webhook sink |

Feed parameters need the API key; token URLs ignore them and serve the default feed.

| Feed parameter | Default | Meaning |
| --- | --- | --- |
| `limit` | `5000` (max `5000`) | items in the feed |
| `days` | `FEED_DAYS` | only posts newer than N days |
| `pages` | `3` (max `10`) | preview pages scraped on a refresh |
| `refresh=1` | – | force a scrape and bypass the cache; with `pages=N` it is a manual backfill |

Removed: query-style routes (`/rss?channel=`, `/feed.xml`, `/atom?channel=`), `?format=atom`,
and the `?token=` / `?access_token=` aliases for the API key (a channel token goes in the
path, not in a query parameter).

## Access

`API_KEY`, sent as `?key=…` or as `Authorization: Bearer …` (compared in constant time),
unlocks everything: feeds by channel name, `/feeds`, `/admin/setup-webhook` and the feed
parameters. A key containing `=`, `&`, `+` or `%` must be percent-encoded in a URL; the
header needs no encoding. Without a valid key you get `401` and no channel content.

**Channel tokens** are the only thing that works without the key, and only for
`/rss/:<token>` and `/atom/:<token>`; the leading colon is what marks a token (a channel name
can never contain one), and `%3A` works too. A token is a random 128-bit value (32 hex characters)
stored in `channels.feed_token`. D1 creates it when the channel is first stored and it never
changes by itself. It opens that one channel's default feed, and the feed's `self` link
carries the token, never the key. A token is a bearer secret like the key, only narrower:
anyone who has the URL can read that feed, and query-string secrets can end up in logs.

**Regenerating a token** takes one SQL statement (drop the `WHERE` to regenerate all).
`key` is the lowercase username, or `id:<number>` for a private channel:

```bash
./deploy.sh d1 execute telegram-rss --remote \
  --command "UPDATE channels SET feed_token = lower(hex(randomblob(16))) WHERE key = 'telegram'"
```

The old URL keeps working until its cached copy expires (at most `CACHE_TTL`, 5 minutes by
default). Then take the new URL from `/feeds`. Rotating `API_KEY` does not change tokens.

---

## Live updates and private channels

Without a bot the worker only sees public channels. With a bot you get instant updates,
**private channels** and photos.

1. Add the bot to the channel as an **administrator** (permission to post is enough).
2. Register the webhook:

   ```bash
   curl -X POST "HOST/admin/setup-webhook?key=KEY"
   ```

Telegram then calls `POST /hook` with `WEBHOOK_SECRET` in the `X-Telegram-Bot-Api-Secret-Token`
header. New posts are written to D1 and the cached feed is purged. Only channel posts are
stored; groups the bot sits in are ignored.

- **Private channels** have no public preview, so they exist only through the webhook. A
  channel appears after the bot receives its **first post**, and is requested by numeric id.
  The worker never scrapes it.
- **Media.** Preview posts use the image URL from `t.me`. Webhook photos go through
  `/media/<file_id>?sig=<hmac>`, signed with `API_KEY`, so the bot token never appears in a
  feed. Rotating `API_KEY` invalidates issued media URLs until readers refetch. Only photos
  are proxied.

---

## Configuration and retention

`[vars]` in `wrangler.template.toml`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FEED_DAYS` | `30` | retention window and default feed window |
| `MAX_POSTS` | `5000` | posts kept per channel |
| `CACHE_TTL` | `300` | edge cache lifetime and minimum time between scrapes (seconds) |

A feed exposes only the last `FEED_DAYS` days. Scraped posts older than that are never
stored, and a daily cron (`17 3 * * *` UTC) deletes posts older than `FEED_DAYS` and trims
each channel to its newest `MAX_POSTS`. `?days=N` narrows the window per request; a value
above `FEED_DAYS` only returns what is still stored. Custom `days`, `limit` or `refresh`
bypass the edge cache.

The cron removes **posts only**. Channels are never removed automatically, so a channel's
feed token stays the same; see [Outdated channels](#outdated-channels) for cleaning up by
hand.

> The window is strict: a channel that posts less often than every 30 days returns an
> **empty feed**. Raise `FEED_DAYS` for quiet channels (for example `365`) and keep
> `MAX_POSTS` above `posts_per_day × FEED_DAYS`.

## Loading older posts

1. **Raise retention first**, otherwise the cron deletes what you backfill. In
   `wrangler.template.toml` set `FEED_DAYS = "365"` and run `./deploy.sh deploy`.
2. **Backfill once** (open it in a browser or `curl` it):

   ```bash
   curl -s -o /dev/null -w "%{http_code}" "HOST/rss/telegram?key=KEY&refresh=1&pages=10&days=365"
   ```

   `refresh=1` forces a scrape and skips the cache, `pages=10` walks back ten preview pages,
   and `days=365` is how far back to go.
3. Your normal feed URL now includes the older posts, because `days` defaults to `FEED_DAYS`.

A preview page holds about 20 posts and every refresh starts from the newest post, so one
backfill reaches roughly 200 posts. Public channels only; private channels fill up through
the webhook.

## Outdated channels

Old posts expire on their own, but a channel row stays after its last post is gone. That
keeps feed tokens stable, and it means channels nobody uses any more stay in `/feeds` until
you remove them. Check now and then, and clean up by hand.

**Find them.** A channel is outdated when nothing has refreshed it for longer than
`FEED_DAYS` (replace `30` with your value) and it has no posts left. `last_activity` is the
last scrape or webhook post; a public channel that a reader keeps polling is re-scraped about
every `CACHE_TTL` seconds, so it does not show up here.

```bash
./deploy.sh d1 execute telegram-rss --remote --command "SELECT key, title,
  datetime(updated_at / 1000, 'unixepoch') AS last_activity,
  (SELECT COUNT(*) FROM posts WHERE posts.chan = channels.key) AS posts
FROM channels
WHERE updated_at < (strftime('%s', 'now') - 30 * 86400) * 1000
ORDER BY updated_at"
```

Rows with `posts = 0` are the ones to remove. Without wrangler, the same idle list (but no post
counts) comes from `/feeds`:

```bash
curl -s "HOST/feeds?key=KEY" | jq -r '.channels[]
  | select(.updated_at < (now - 30 * 86400) * 1000)
  | [.key, .title, (.updated_at / 1000 | todate)] | @tsv'
```

**Remove one channel.** Use the `key` from the lists above (the lowercase username, or
`id:<number>` for a private channel). Delete its posts first, then the channel:

```bash
./deploy.sh d1 execute telegram-rss --remote --command "DELETE FROM posts WHERE chan = 'telegram'"
./deploy.sh d1 execute telegram-rss --remote --command "DELETE FROM channels WHERE key = 'telegram'"
```

**Remove every outdated channel at once** (idle for the whole window and no posts left):

```bash
./deploy.sh d1 execute telegram-rss --remote --command "DELETE FROM channels
WHERE updated_at < (strftime('%s', 'now') - 30 * 86400) * 1000
  AND NOT EXISTS (SELECT 1 FROM posts WHERE posts.chan = channels.key)"
```

A removed channel disappears from `/feeds` and its token URL returns `401`; the edge cache
may still serve its old feed for up to `CACHE_TTL` seconds. If the channel is requested again
by name (public) or the bot receives a new post (private), it is stored again with a **new
token**, so readers need the new URL from `/feeds`.

---

## How it works

- **Refresh.** A feed request scrapes `t.me/s/<channel>` when forced, when the channel has no
  posts, or when the last scrape is older than `CACHE_TTL`, unless the webhook delivered
  something within the last hour. A webhook post is never overwritten by a later scrape.
- **Storage.** [`schema.sql`](schema.sql) defines `channels` (one row per channel, keyed by
  lowercase username or `id:<publicId>`, with its random `feed_token`) and `posts` (primary
  key `(chan, id)`). [`migrate_feed_token.sql`](migrate_feed_token.sql) upgrades databases
  that predate `feed_token`.
- **Parsing.** Message HTML is rebuilt from a tag whitelist with all attributes dropped,
  except an `http(s)` `href` on links. Overlapping formatting in webhook posts is not
  nested; the first entity wins.
- Feeds are sent with `noindex, nofollow`.

## Local development

```bash
echo 'API_KEY=change-me' > .dev.vars        # gitignored
./deploy.sh d1 execute telegram-rss --local --file=schema.sql
./deploy.sh dev
curl "http://localhost:8787/rss/telegram?key=change-me"
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Reader shows the "Telegram → RSS" help text | it fetched `/`, so the URL has no route | subscribe to the full URL: `HOST/rss/<channel>?key=…` |
| `401` JSON | missing or wrong key, or a token that was regenerated | check `?key=` or the Bearer header against `API_KEY` (encode special characters); for a token URL take the current one from `/feeds` and keep the leading colon: `/rss/:<token>` |
| `500` with `no such column: feed_token` | the migration has not been run | `./deploy.sh d1 execute telegram-rss --remote --file=migrate_feed_token.sql` |
| A channel is missing from `/feeds` | it has not been fetched yet | open `HOST/rss/<channel>?key=KEY` once (private channel: wait for the bot's first post) |
| `404` "channel not found" | wrong name, no public preview, or a private channel the bot has not seen yet | check the username; for private channels add the bot as admin, register the webhook and wait for a post |
| Feed has a title but no items | no posts within `FEED_DAYS` | raise `FEED_DAYS`, or try `&days=365` |
| Photos missing on webhook posts | `BOT_TOKEN` not set, or the media is not a photo | set the secret; only photos are proxied |
| `curl` cannot resolve the host but the browser can | local DNS, VPN or proxy | `curl --doh-url https://cloudflare-dns.com/dns-query …` |

See what is stored per channel:

```bash
./deploy.sh d1 execute telegram-rss --remote \
  --command "SELECT chan, COUNT(*) AS posts, MAX(date) AS newest FROM posts GROUP BY chan"
```

Live logs: `./deploy.sh tail`.
