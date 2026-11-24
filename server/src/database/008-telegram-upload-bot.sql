CREATE TABLE telegram_bot_offsets (
  bot_id TEXT PRIMARY KEY,
  next_update INTEGER NOT NULL CHECK (next_update > 0),
  updated_at INTEGER NOT NULL
) STRICT;
