import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Address } from "viem";
import type { ClaimResult, PaymentRecord, Quote, X402State } from "./x402Middleware.js";

export interface JobRecord {
  jobId: string;
  buyer: Address;
  amount: string;
  report?: string;
  deliveredTx?: string;
  status: string;
}

/** Durable seller state: x402 replay/quote bookkeeping, payment log, worked
 *  jobs, and the escrow poller's block cursor. Everything that previously
 *  lived in module-level Maps and died with the process.
 *
 *  The store is scoped to one escrow deployment: if the configured escrow
 *  address changes (fresh local redeploy), all tables are wiped so stale job
 *  ids from the previous deployment can't shadow new ones. */
export class SellerStore implements X402State {
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
      CREATE TABLE IF NOT EXISTS quotes (
        quoteId TEXT PRIMARY KEY, resource TEXT NOT NULL, price TEXT NOT NULL, validUntil INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumed (quoteId TEXT PRIMARY KEY, txHash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS used_tx (txHash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS payments (
        ts INTEGER NOT NULL, sender TEXT NOT NULL, amount TEXT NOT NULL,
        txHash TEXT NOT NULL, resource TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        jobId TEXT PRIMARY KEY, buyer TEXT NOT NULL, amount TEXT NOT NULL,
        report TEXT, deliveredTx TEXT, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_nonces (nonce TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL);
    `);
    const stored = this.getMeta("scope");
    if (stored !== scope.toLowerCase()) {
      // Unconditional wipe on mismatch — a missing scope marker with existing
      // rows (legacy DB) must not let stale jobs shadow new ones.
      this.db.exec(
        "DELETE FROM quotes; DELETE FROM consumed; DELETE FROM used_tx; DELETE FROM payments; DELETE FROM jobs; DELETE FROM used_nonces; DELETE FROM meta;",
      );
      this.setMeta("scope", scope.toLowerCase());
    }
    this.buildClaimTxn();
  }

  private getMeta(k: string): string | undefined {
    return (this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;
  }

  private setMeta(k: string, v: string): void {
    this.db
      .prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(k, v);
  }

  // ---- X402State ----
  getQuote(id: string): Quote | undefined {
    const row = this.db.prepare("SELECT resource, price, validUntil FROM quotes WHERE quoteId = ?").get(id) as
      | { resource: string; price: string; validUntil: number }
      | undefined;
    return row ? { resource: row.resource, price: BigInt(row.price), validUntil: row.validUntil } : undefined;
  }

  setQuote(id: string, q: Quote): void {
    this.db
      .prepare("INSERT OR REPLACE INTO quotes (quoteId, resource, price, validUntil) VALUES (?, ?, ?, ?)")
      .run(id, q.resource, q.price.toString(), q.validUntil);
  }

  getConsumed(id: string): `0x${string}` | undefined {
    const row = this.db.prepare("SELECT txHash FROM consumed WHERE quoteId = ?").get(id) as
      | { txHash: `0x${string}` }
      | undefined;
    return row?.txHash;
  }

  hasUsedTx(txHash: string): boolean {
    return this.db.prepare("SELECT 1 FROM used_tx WHERE txHash = ?").get(txHash) !== undefined;
  }

  /** Atomic claim: validate the quote and the replay state, then consume both,
   *  in one IMMEDIATE transaction. This is the only place that marks a payment
   *  spent — a plain INSERT (never `OR IGNORE`) makes the used_tx primary key
   *  the last line of defence, so a lost race rolls the whole claim back
   *  instead of silently serving a second response for one payment. */
  claim(quoteId: string, txHash: string, resource: string, now: number): ClaimResult {
    return this.claimTxn(quoteId, txHash, resource, now);
  }

  /** Built in the constructor, not as a field initializer: field initializers
   *  run before the constructor body, where `this.db` is assigned. */
  private claimTxn!: (quoteId: string, txHash: string, resource: string, now: number) => ClaimResult;

  private buildClaimTxn(): void {
    this.claimTxn = this.db.transaction(
      (quoteId: string, txHash: string, resource: string, now: number): ClaimResult => {
        const claimedBy = this.getConsumed(quoteId);
        if (claimedBy) {
          if (claimedBy === txHash) return { ok: true, idempotent: true };
          return { ok: false, status: 402, error: "quote already claimed" };
        }
        const quote = this.getQuote(quoteId);
        if (!quote) return { ok: false, status: 402, error: "unknown or expired quote" };
        if (now > quote.validUntil) return { ok: false, status: 402, error: "quote expired" };
        if (quote.resource !== resource) {
          return { ok: false, status: 402, error: "quote is for another resource" };
        }
        try {
          this.db.prepare("INSERT INTO used_tx (txHash) VALUES (?)").run(txHash);
        } catch {
          // Primary-key violation: another claim already spent this payment.
          // The failed statement is rolled back on its own; the transaction
          // commits having changed nothing.
          return { ok: false, status: 402, error: "payment already used" };
        }
        this.db.prepare("INSERT INTO consumed (quoteId, txHash) VALUES (?, ?)").run(quoteId, txHash);
        this.db.prepare("DELETE FROM quotes WHERE quoteId = ?").run(quoteId);
        return { ok: true, idempotent: false };
      },
    ).immediate;
  }

  pruneQuotes(now: number): void {
    this.db.prepare("DELETE FROM quotes WHERE validUntil < ?").run(now);
  }

  // ---- deliverable auth nonces ----
  /** Burn a nonce. Returns false if it was already used, so a captured
   *  authorisation header cannot be replayed within its validity window.
   *  The insert itself is the check — no read-then-write race. */
  useNonce(nonce: string, expiresAt: number): boolean {
    this.db.prepare("DELETE FROM used_nonces WHERE expiresAt < ?").run(Date.now());
    try {
      this.db.prepare("INSERT INTO used_nonces (nonce, expiresAt) VALUES (?, ?)").run(nonce, expiresAt);
      return true;
    } catch {
      return false;
    }
  }

  // ---- payments ----
  addPayment(p: PaymentRecord): void {
    this.db
      .prepare("INSERT INTO payments (ts, sender, amount, txHash, resource) VALUES (?, ?, ?, ?, ?)")
      .run(p.ts, p.from, p.amount, p.txHash, p.resource);
  }

  paymentCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM payments").get() as { n: number }).n;
  }

  recentPayments(limit = 500): PaymentRecord[] {
    const rows = this.db
      .prepare("SELECT ts, sender, amount, txHash, resource FROM payments ORDER BY ts DESC LIMIT ?")
      .all(limit) as Array<{
      ts: number;
      sender: Address;
      amount: string;
      txHash: `0x${string}`;
      resource: string;
    }>;
    return rows
      .reverse()
      .map((r) => ({ ts: r.ts, from: r.sender, amount: r.amount, txHash: r.txHash, resource: r.resource }));
  }

  // ---- jobs ----
  getJob(jobId: string): JobRecord | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE jobId = ?").get(jobId) as JobRecord | undefined;
  }

  upsertJob(job: JobRecord): void {
    this.db
      .prepare(
        `INSERT INTO jobs (jobId, buyer, amount, report, deliveredTx, status) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(jobId) DO UPDATE SET report = excluded.report, deliveredTx = excluded.deliveredTx, status = excluded.status`,
      )
      .run(job.jobId, job.buyer, job.amount, job.report ?? null, job.deliveredTx ?? null, job.status);
  }

  listJobs(): JobRecord[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY CAST(jobId AS INTEGER)").all() as JobRecord[];
  }

  /** Jobs discovered from the chain but not yet worked. The block cursor may
   *  only advance past blocks whose jobs are recorded here, so a crash or a
   *  failed delivery leaves work queued rather than silently skipped. */
  pendingJobs(): JobRecord[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE status = 'pending' ORDER BY CAST(jobId AS INTEGER)")
      .all() as JobRecord[];
  }

  setJobStatus(jobId: string, status: string): void {
    this.db.prepare("UPDATE jobs SET status = ? WHERE jobId = ?").run(status, jobId);
  }

  // ---- block cursor ----
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
