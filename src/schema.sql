CREATE TABLE IF NOT EXISTS channels (
  key         TEXT PRIMARY KEY,          -- lowercase username, or "id:<channel id>"
  chat_id     TEXT NOT NULL DEFAULT '',  -- e.g. -1001234567890
  username    TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  photo       TEXT,
  link        TEXT NOT NULL DEFAULT '',
  fetched_at  INTEGER,                   -- last successful preview scrape (ms)
  webhook_at  INTEGER,                   -- last webhook delivery (ms)
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS channels_chat_id ON channels(chat_id);

CREATE TABLE IF NOT EXISTS posts (
  chan    TEXT NOT NULL,
  id      INTEGER NOT NULL,
  chat_id TEXT NOT NULL DEFAULT '',
  date    TEXT NOT NULL,                 -- ISO 8601 UTC
  link    TEXT NOT NULL DEFAULT '',
  text    TEXT NOT NULL DEFAULT '',
  html    TEXT NOT NULL DEFAULT '',
  author  TEXT NOT NULL DEFAULT '',
  image   TEXT,                          -- t.me CDN url (preview posts)
  file_id TEXT,                          -- Bot API photo file_id (webhook posts)
  source  TEXT NOT NULL,                 -- 'webhook' | 'preview'
  PRIMARY KEY (chan, id)
);

CREATE INDEX IF NOT EXISTS posts_date ON posts(date);
