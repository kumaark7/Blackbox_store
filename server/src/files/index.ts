import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DriveError } from '../errors.ts';

export const ROOT_ID = '00000000-0000-4000-8000-000000000000';
export const IMPORTANCE = ['highly-important', 'important', 'backup'] as const;
export type Importance = (typeof IMPORTANCE)[number];
type State = 'pending' | 'ready' | 'trash';

type NodeRow = {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'folder' | 'file';
  state: State;
  importance: Importance | null;
  objectKey: string | null;
  size: number | null;
  sha256: string | null;
  updatedAt: number;
  deletionPending?: number;
};

type PublicEntry = Omit<NodeRow, 'objectKey' | 'state' | 'sha256' | 'deletionPending'> & {
  storage: 'local' | null;
  protection: 'single-copy' | 'degraded' | null;
  deletionPending: boolean;
};

type BrowseOptions = {
  parentId: string;
  search?: string;
  sort: 'name' | 'updated' | 'size';
  offset: number;
  limit: number;
  trash?: boolean;
};

const columns = `nodes.id, nodes.parent_id AS parentId, nodes.name, nodes.kind, nodes.state,
  nodes.importance, nodes.object_key AS objectKey, nodes.size, nodes.sha256, nodes.updated_at AS updatedAt`;
const subtree = `WITH RECURSIVE subtree(id) AS (
  SELECT id FROM nodes WHERE id = ?
  UNION ALL
  SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
)`;
const publicFields = (row: NodeRow): PublicEntry => ({
  id: row.id, parentId: row.parentId, name: row.name, kind: row.kind,
  importance: row.importance, size: row.size, updatedAt: row.updatedAt,
  storage: row.kind === 'file' ? 'local' : null,
  protection: row.kind === 'folder' ? null : row.importance === 'highly-important' ? 'degraded' : 'single-copy',
  deletionPending: Boolean(row.deletionPending),
});

export function validateName(name: string) {
  const normalized = name.trim().normalize('NFC');
  if (!normalized || normalized.length > 180 || normalized === '.' || normalized === '..'
    || /[<>:"/\\|?*\p{Cc}\p{Cs}]/u.test(normalized) || normalized.endsWith('.')
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i.test(normalized)) {
    throw new DriveError(400, 'Choose a name without path separators, reserved characters or device names.');
  }
  return normalized;
}

export class FileIndex {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  ancestors(id: string) {
    return this.db.prepare(`
      WITH RECURSIVE parents(id, parent_id, depth) AS (
        SELECT id, parent_id, 0 FROM nodes WHERE id = ?
        UNION ALL
        SELECT nodes.id, nodes.parent_id, parents.depth + 1
        FROM nodes JOIN parents ON nodes.id = parents.parent_id
      )
      SELECT ${columns} FROM parents JOIN nodes USING(id) ORDER BY parents.depth DESC
    `).all(id) as NodeRow[];
  }

  get(id: string) {
    const ancestors = this.ancestors(id);
    const row = ancestors.at(-1);
    if (row?.id !== id || ancestors.some((node) => node.state !== 'ready')) {
      throw new DriveError(404, 'Item not found.');
    }
    return row;
  }

  folder(id: string) {
    const row = this.get(id);
    if (row.kind !== 'folder') throw new DriveError(404, 'Folder not found.');
    return row;
  }

  breadcrumbs(id: string) {
    this.folder(id);
    return this.ancestors(id).map(({ id, name }) => ({ id, name: id === ROOT_ID ? 'My Files' : name }));
  }

  browse(options: BrowseOptions) {
    const { parentId, search, sort, offset, limit, trash } = options;
    const ordering = {
      name: "nodes.kind DESC, nodes.name COLLATE NOCASE, nodes.id",
      updated: "nodes.updated_at DESC, nodes.id",
      size: "nodes.size DESC NULLS LAST, nodes.name COLLATE NOCASE, nodes.id",
    }[sort];
    const tail = `ORDER BY ${ordering} LIMIT ? OFFSET ?`;
    let rows: NodeRow[];
    if (trash) {
      rows = this.db.prepare(`
        SELECT ${columns}, (trash_purges.node_id IS NOT NULL) AS deletionPending
        FROM nodes LEFT JOIN trash_purges ON trash_purges.node_id = nodes.id
        WHERE state = 'trash' ${tail}
      `).all(limit + 1, offset) as NodeRow[];
    } else if (search) {
      rows = this.db.prepare(`
        WITH RECURSIVE live(id) AS (
          SELECT id FROM nodes WHERE id = ?
          UNION ALL
          SELECT nodes.id FROM nodes JOIN live ON nodes.parent_id = live.id WHERE nodes.state = 'ready'
        )
        SELECT ${columns} FROM live JOIN nodes USING(id)
        WHERE nodes.id != ? AND instr(lower(nodes.name), lower(?)) > 0 ${tail}
      `).all(ROOT_ID, ROOT_ID, search, limit + 1, offset) as NodeRow[];
    } else {
      this.folder(parentId);
      rows = this.db.prepare(`
        SELECT ${columns} FROM nodes WHERE parent_id = ? AND state = 'ready' ${tail}
      `).all(parentId, limit + 1, offset) as NodeRow[];
    }
    return {
      items: rows.slice(0, limit).map(publicFields),
      nextOffset: rows.length > limit ? offset + limit : null,
      breadcrumbs: trash || search ? [] : this.breadcrumbs(parentId),
    };
  }

  createFolder(parentId: string, rawName: string) {
    this.folder(parentId);
    const name = validateName(rawName);
    const id = randomUUID();
    const now = Date.now();
    this.writeName(() => this.db.prepare(`
      INSERT INTO nodes (id, parent_id, name, kind, state, created_at, updated_at)
      VALUES (?, ?, ?, 'folder', 'ready', ?, ?)
    `).run(id, parentId, name, now, now));
    return publicFields(this.get(id));
  }

  edit(id: string, edits: { name?: string; parentId?: string; importance?: Importance }) {
    if (id === ROOT_ID) throw new DriveError(400, 'The root folder cannot be changed.');
    const row = this.get(id);
    const name = edits.name === undefined ? row.name : validateName(edits.name);
    const parentId = edits.parentId ?? row.parentId!;
    this.folder(parentId);
    if (row.kind === 'folder' && this.ancestors(parentId).some((ancestor) => ancestor.id === id)) {
      throw new DriveError(400, 'A folder cannot be moved inside itself.');
    }
    if (edits.importance && row.kind !== 'file') throw new DriveError(400, 'Choose a file to change importance.');
    this.writeName(() => this.db.prepare(`
      UPDATE nodes SET name = ?, parent_id = ?, importance = ?, updated_at = ? WHERE id = ?
    `).run(name, parentId, edits.importance ?? row.importance, Date.now(), id));
    return publicFields(this.get(id));
  }

  moveToTrash(id: string) {
    if (id === ROOT_ID) throw new DriveError(400, 'The root folder cannot be deleted.');
    this.get(id);
    const pending = this.db.prepare(`
      ${subtree}
      SELECT 1 FROM nodes JOIN subtree USING(id) WHERE state = 'pending' LIMIT 1
    `).get(id);
    if (pending) throw new DriveError(409, 'Wait for the upload in this folder to finish.');
    this.db.prepare("UPDATE nodes SET state = 'trash', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  restore(id: string) {
    const row = this.db.prepare(`SELECT ${columns} FROM nodes WHERE id = ? AND state = 'trash'`).get(id) as NodeRow | undefined;
    if (!row?.parentId) throw new DriveError(404, 'Recycle bin item not found.');
    if (this.purgeAncestor(id)) throw new DriveError(409, 'Permanent deletion has already started for this item or its parent.');
    if (this.ancestors(row.parentId).some((node) => node.state !== 'ready')) {
      throw new DriveError(409, 'Restore the parent folder first.');
    }
    this.writeName(() => this.db.prepare("UPDATE nodes SET state = 'ready', updated_at = ? WHERE id = ?").run(Date.now(), id));
    return publicFields(this.get(id));
  }

  private purgeAncestor(id: string) {
    return this.db.prepare(`
      WITH RECURSIVE ancestors(id, parent_id) AS (
        SELECT id, parent_id FROM nodes WHERE id = ?
        UNION ALL
        SELECT nodes.id, nodes.parent_id FROM nodes JOIN ancestors ON nodes.id = ancestors.parent_id
      )
      SELECT node_id AS id FROM trash_purges JOIN ancestors ON trash_purges.node_id = ancestors.id LIMIT 1
    `).get(id)?.id;
  }

  startPurge(id: string) {
    if (!this.db.prepare("SELECT 1 FROM nodes WHERE id = ? AND state = 'trash'").get(id)) {
      throw new DriveError(404, 'Recycle bin item not found.');
    }
    const purging = this.purgeAncestor(id);
    if (purging === id) return;
    if (purging) throw new DriveError(409, 'Finish permanently deleting the parent folder first.');
    if (this.db.prepare(`
      ${subtree}
      SELECT 1 FROM trash_purges JOIN subtree ON trash_purges.node_id = subtree.id LIMIT 1
    `).get(id)) {
      throw new DriveError(409, 'Finish permanently deleting the item inside this folder first.');
    }
    this.db.prepare('INSERT INTO trash_purges (node_id) VALUES (?)').run(id);
  }

  purgeObjects(id: string) {
    return this.db.prepare(`
      ${subtree}
      SELECT object_key AS key FROM nodes JOIN subtree USING(id) WHERE object_key IS NOT NULL
    `).all(id) as { key: string }[];
  }

  finishPurge(id: string) {
    this.db.prepare(`${subtree} DELETE FROM nodes WHERE id IN (SELECT id FROM subtree)`).run(id);
  }

  reserve(parentId: string, rawName: string, importance: Importance) {
    this.folder(parentId);
    const name = validateName(rawName);
    const id = randomUUID();
    const key = randomUUID();
    const now = Date.now();
    this.writeName(() => this.db.prepare(`
      INSERT INTO nodes (id, parent_id, name, kind, state, importance, object_key, created_at, updated_at)
      VALUES (?, ?, ?, 'file', 'pending', ?, ?, ?, ?)
    `).run(id, parentId, name, importance, key, now, now));
    return { id, key };
  }

  finish(id: string, size: number, sha256: string) {
    const row = this.db.prepare(`
      UPDATE nodes SET size = ?, sha256 = ?, updated_at = ?, state = 'ready' WHERE id = ? AND state = 'pending'
      RETURNING ${columns}
    `).get(size, sha256, Date.now(), id) as NodeRow | undefined;
    if (!row) throw new Error('Upload reservation could not be finalized.');
    return publicFields(row);
  }

  abandon(id: string) {
    this.db.prepare("DELETE FROM nodes WHERE id = ? AND state = 'pending'").run(id);
  }

  pending() {
    return this.db.prepare("SELECT id, object_key AS key FROM nodes WHERE state = 'pending'").all() as {
      id: string; key: string;
    }[];
  }

  writeName(write: () => unknown) {
    try {
      write();
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === 2067) {
        throw new DriveError(409, 'An item with this name already exists in that folder.');
      }
      throw error;
    }
  }
}
