ALTER TABLE nodes ADD COLUMN storage_format INTEGER NOT NULL DEFAULT 0 CHECK (storage_format IN (0, 1));

CREATE TABLE storage_key_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  digest TEXT NOT NULL CHECK (length(digest) = 64)
) STRICT;

CREATE TABLE transfers (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  received_bytes INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes BETWEEN 0 AND total_bytes),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64)
) STRICT;
