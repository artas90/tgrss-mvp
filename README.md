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
npx wrangler d1 create telegram-rss                              # 1. note the printed database_id
echo 'D1_DATABASE_ID=<paste id>' > .env                          # 2. keep it local (gitignored)
chmod +x deploy.sh
./deploy.sh d1 execute telegram-rss --remote --file=schema.sql   # 3. create the tables
./deploy.sh secret put API_KEY                                   # 4. secrets, see below
./deploy.sh secret put WEBHOOK_SECRET                            #    optional
./deploy.sh secret put BOT_TOKEN                                 #    optional
./deploy.sh deploy                                               # 5. deploy
```

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

| Goal | URL |
| --- | --- |
| RSS | `HOST/rss/telegram?key=KEY` |
| Atom | `HOST/atom/telegram?key=KEY` |
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
| `GET` | `/feeds` | key | JSON list of known channels |
| `GET` | `/media/:fileId?sig=…` | signature | photo proxy for webhook posts |
| `POST` | `/admin/setup-webhook` | key | register the Telegram webhook |
| `POST` | `/hook` | secret header | Telegram webhook sink |

| Feed parameter | Default | Meaning |
| --- | --- | --- |
| `limit` | `5000` (max `5000`) | items in the feed |
| `days` | `FEED_DAYS` | only posts newer than N days |
| `pages` | `3` (max `10`) | preview pages scraped on a refresh |
| `refresh=1` | – | force a scrape and bypass the cache; with `pages=N` it is a manual backfill |

Removed: query-style routes (`/rss?channel=`, `/feed.xml`, `/atom?channel=`), `?format=atom`,
and the `?token=` / `?access_token=` key parameters.

## Access

Feed routes, `/feeds` and `/admin/setup-webhook` need `API_KEY`, sent as `?key=…` or as
`Authorization: Bearer …` (compared in constant time). Without a valid key you get `401` and
no channel content. The feed's own `self` link never contains the key. Query-string keys can
end up in logs, so prefer the header if your reader supports it. A key containing `=`, `&`,
`+` or `%` must be percent-encoded in a URL; the header needs no encoding.

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

---

## How it works

- **Refresh.** A feed request scrapes `t.me/s/<channel>` when forced, when the channel has no
  posts, or when the last scrape is older than `CACHE_TTL`, unless the webhook delivered
  something within the last hour. A webhook post is never overwritten by a later scrape.
- **Storage.** [`schema.sql`](schema.sql) defines `channels` (one row per channel, keyed by
  lowercase username or `id:<publicId>`) and `posts` (primary key `(chan, id)`).
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
| `401` JSON | missing or wrong key | check `?key=` or the Bearer header against `API_KEY`; encode special characters |
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
