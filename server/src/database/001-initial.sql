CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id),
  name TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'trash')),
  importance TEXT CHECK (importance IN ('highly-important', 'important', 'backup')),
  object_key TEXT UNIQUE,
  size INTEGER CHECK (size >= 0),
  sha256 TEXT CHECK (length(sha256) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (kind = 'folder' AND state != 'pending' AND object_key IS NULL AND importance IS NULL AND size IS NULL AND sha256 IS NULL)
    OR (kind = 'file' AND object_key IS NOT NULL AND importance IS NOT NULL AND
      ((state = 'pending' AND size IS NULL AND sha256 IS NULL) OR
       (state != 'pending' AND size IS NOT NULL AND sha256 IS NOT NULL)))
  ),
  CHECK (
    (id = '00000000-0000-4000-8000-000000000000' AND parent_id IS NULL AND name = '' AND kind = 'folder' AND state = 'ready')
    OR (id != '00000000-0000-4000-8000-000000000000' AND parent_id IS NOT NULL AND length(name) > 0)
  )
) STRICT;

CREATE UNIQUE INDEX nodes_live_name ON nodes(parent_id, name COLLATE NOCASE) WHERE state IN ('pending', 'ready');
CREATE INDEX nodes_parent_state ON nodes(parent_id, state);
CREATE INDEX nodes_trash_modified ON nodes(updated_at DESC, id) WHERE state = 'trash';

INSERT INTO nodes (id, parent_id, name, kind, state, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000000', NULL, '', 'folder', 'ready', 0, 0);
