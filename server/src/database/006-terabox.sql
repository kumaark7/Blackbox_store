CREATE TABLE terabox_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  binding TEXT NOT NULL CHECK (length(binding) = 64)
) STRICT;

CREATE TABLE terabox_replicas (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  remote_id TEXT UNIQUE,
  checksum TEXT CHECK (length(checksum) = 64),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  confirmed_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX terabox_replicas_due ON terabox_replicas(retry_at);
CREATE INDEX nodes_terabox_candidates ON nodes(updated_at, id)
  WHERE importance = 'backup' AND storage_format = 1 AND state != 'pending';
