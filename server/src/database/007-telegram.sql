CREATE TABLE telegram_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  binding TEXT NOT NULL CHECK (length(binding) = 64)
) STRICT;

CREATE TABLE telegram_replicas (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  remote_id TEXT UNIQUE,
  message_id INTEGER UNIQUE CHECK (message_id > 0),
  checksum TEXT CHECK (length(checksum) = 64),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  confirmed_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX telegram_replicas_due ON telegram_replicas(retry_at);
