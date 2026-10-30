// The patrol outbox's SQLite table (Patrols P1-E). PURE: written against the small subset of expo-sqlite's async API
// below, so scripts/guard-patrols.spec.cjs runs these exact statements against a real SQLite engine (node:sqlite) and
// the phone runs them through expo-sqlite (src/services/patrolNative.ts).
//
// Every statement that reads, changes or deletes rows is filtered on owner_user_id: one Guard's rows are never
// returned to, or removable by, another user signed in on the same phone. The ONE exception is referencedFilePaths():
// it returns only the photo file locations of every row, solely so the stale temporary-file sweep never deletes a file
// that any Guard's queue still needs. It changes nothing, and nothing it returns is shown or sent.

import type { OutboxItem, OutboxStore } from './patrolOutbox';

export interface SqlDb {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: Array<string | number | null>): Promise<unknown>;
  getAllAsync<T>(source: string, params: Array<string | number | null>): Promise<T[]>;
}

export const PATROL_OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS patrol_outbox (
  owner_user_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  company_id INTEGER,
  shift_id INTEGER NOT NULL,
  client_run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, id)
);
CREATE INDEX IF NOT EXISTS patrol_outbox_owner_seq ON patrol_outbox (owner_user_id, seq);
`;

export class SqlOutboxStore implements OutboxStore {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: SqlDb, private readonly now: () => Date = () => new Date()) {}

  private init(): Promise<void> {
    if (!this.ready) this.ready = this.db.execAsync(PATROL_OUTBOX_SCHEMA);
    return this.ready;
  }

  async list(ownerUserId: number): Promise<OutboxItem[]> {
    await this.init();
    const rows = await this.db.getAllAsync<{ data: string }>(
      'SELECT data FROM patrol_outbox WHERE owner_user_id = ? ORDER BY seq, id',
      [ownerUserId],
    );
    return rows.map((r) => JSON.parse(r.data) as OutboxItem).filter((item) => item.ownerUserId === ownerUserId);
  }

  async put(item: OutboxItem): Promise<void> {
    await this.init();
    await this.db.runAsync(
      `INSERT INTO patrol_outbox (owner_user_id, id, company_id, shift_id, client_run_id, seq, kind, status, data, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_user_id, id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
      [item.ownerUserId, item.id, item.companyId, item.shiftId, item.clientRunId, item.seq, item.kind, item.status, JSON.stringify(item), this.now().toISOString()],
    );
  }

  /** Every photo file location any row references (any owner): only so a cleanup never deletes a queued file. */
  async referencedFilePaths(): Promise<string[]> {
    await this.init();
    const rows = await this.db.getAllAsync<{ data: string }>("SELECT data FROM patrol_outbox WHERE kind = 'photo'", []);
    const paths: string[] = [];
    for (const row of rows) {
      try {
        const filePath = (JSON.parse(row.data) as OutboxItem).photo?.filePath;
        if (typeof filePath === 'string' && filePath) paths.push(filePath);
      } catch {
        // An unreadable row protects nothing by itself; the sweep only ever touches cache folders anyway.
      }
    }
    return paths;
  }

  async remove(ownerUserId: number, id: string): Promise<void> {
    await this.init();
    await this.db.runAsync('DELETE FROM patrol_outbox WHERE owner_user_id = ? AND id = ?', [ownerUserId, id]);
  }
}
