CREATE TABLE mega_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  binding TEXT NOT NULL CHECK (length(binding) = 36),
  connected INTEGER NOT NULL DEFAULT 0 CHECK (connected IN (0, 1))
) STRICT;

CREATE TABLE mega_replicas (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  remote_id TEXT UNIQUE,
  checksum TEXT CHECK (length(checksum) = 64),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  confirmed_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX mega_replicas_due ON mega_replicas(retry_at);
CREATE INDEX nodes_mega_candidates ON nodes(updated_at, id)
  WHERE importance = 'important' AND storage_format = 1 AND state != 'pending';
