import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { argon2id, hash, verify } from 'argon2';
import { z } from 'zod';
import { DriveError } from '../errors.ts';

export const passwordInput = z.string().min(12).max(128);
const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');

export class OwnerAuth {
  readonly db: DatabaseSync;
  readonly sessionSeconds: number;

  constructor(db: DatabaseSync, sessionSeconds: number) {
    this.db = db;
    this.sessionSeconds = sessionSeconds;
  }

  configured() {
    return Boolean(this.db.prepare('SELECT 1 FROM owner WHERE id = 1').get());
  }

  async createOwner(password: string) {
    if (this.configured()) throw new DriveError(409, 'The owner has already been configured.');
    const validated = passwordInput.parse(password);
    const passwordHash = await hash(validated, { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const result = this.db.prepare('INSERT OR IGNORE INTO owner (id, password_hash) VALUES (1, ?)').run(passwordHash);
    if (result.changes !== 1) throw new DriveError(409, 'The owner has already been configured.');
  }

  async login(password: string) {
    const row = this.db.prepare('SELECT password_hash FROM owner WHERE id = 1').get();
    if (!row) throw new DriveError(503, 'Configure the owner using the local setup command.');
    if (!(await verify(String(row.password_hash), password))) {
      throw new DriveError(401, 'Incorrect password.');
    }

    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('INSERT INTO sessions (token_hash, owner_id, expires_at) VALUES (?, 1, ?)')
      .run(tokenDigest(token), now + this.sessionSeconds * 1000);
    return token;
  }

  authenticated(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(tokenDigest(token), Date.now()));
  }

  logout(token: string | undefined) {
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenDigest(token));
    }
  }
}
