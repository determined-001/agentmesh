import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/** Durable watcher state: screening verdicts, tracked job ids, block cursor.
 *  Without this, a restart forgot every job older than the rescan window and
 *  silently dropped pending releases/refunds.
 *
 *  Scoped to one escrow deployment — tables are wiped when the escrow address
 *  changes (fresh local redeploy). */
export class WatcherStore {
  private db: Database.Database;

  /** `scope` must uniquely identify the deployment instance — escrow address
   *  alone is NOT enough: deterministic local redeploys (fresh anvil chain,
   *  same nonce) reuse addresses, so include the chain's genesis hash. */
  constructor(path: string, scope: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS screened (address TEXT PRIMARY KEY, allowed INTEGER NOT NULL, screenedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tracked (jobId TEXT PRIMARY KEY);
    `);
    const stored = this.getMeta("scope");
    if (stored !== scope.toLowerCase()) {
      if (stored) this.db.exec("DELETE FROM screened; DELETE FROM tracked; DELETE FROM meta;");
      this.setMeta("scope", scope.toLowerCase());
    }
  }

  private getMeta(k: string): string | undefined {
    return (this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;
  }

  private setMeta(k: string, v: string): void {
    this.db
      .prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(k, v);
  }

  isScreened(address: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM screened WHERE address = ?").get(address.toLowerCase()) !== undefined
    );
  }

  markScreened(address: string, allowed: boolean): void {
    this.db
      .prepare("INSERT OR REPLACE INTO screened (address, allowed, screenedAt) VALUES (?, ?, ?)")
      .run(address.toLowerCase(), allowed ? 1 : 0, Date.now());
  }

  track(jobId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO tracked (jobId) VALUES (?)").run(jobId);
  }

  untrack(jobId: string): void {
    this.db.prepare("DELETE FROM tracked WHERE jobId = ?").run(jobId);
  }

  trackedJobs(): string[] {
    return (this.db.prepare("SELECT jobId FROM tracked").all() as Array<{ jobId: string }>).map(
      (r) => r.jobId,
    );
  }

  getCursor(): bigint | undefined {
    const v = this.getMeta("cursor");
    return v === undefined ? undefined : BigInt(v);
  }

  setCursor(block: bigint): void {
    this.setMeta("cursor", block.toString());
  }

  close(): void {
    this.db.close();
  }
}
