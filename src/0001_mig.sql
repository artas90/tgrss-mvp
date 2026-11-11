-- Adds a random per-channel feed token: /rss/<token> opens only that channel's feed.
-- Run once, after schema.sql and before deploying the worker that uses the column:
--   ./deploy.sh d1 execute telegram-rss --remote --file=migrate_feed_token.sql
-- (add --local for local development)

ALTER TABLE channels ADD COLUMN feed_token TEXT;

-- fill channels that already exist; new channels get their token when the worker inserts them
UPDATE channels SET feed_token = lower(hex(randomblob(16))) WHERE feed_token IS NULL;

-- a token must identify exactly one channel (NULLs are allowed to repeat)
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_feed_token ON channels (feed_token);
