"use client";

import { useEffect, useState } from "react";

interface Agent {
  name: string;
  wallet: string;
  endpoint: string;
  balance: string;
  allowed: boolean;
  registeredAt: string;
}
interface Job {
  jobId: string;
  buyer: string;
  seller: string;
  amount: string;
  deadline: string;
  deliveredAt: string;
  status: number;
}
interface Payment {
  ts: number;
  from: string;
  amount: string;
  txHash: string;
  resource: string;
}
interface State {
  network: string;
  agents: Agent[];
  jobs: Job[];
  payments: { count: number; payments: Payment[] };
  error?: string;
}

const JOB_STATUS = ["None", "Funded", "Delivered", "Disputed", "Released", "Refunded"] as const;
const STATUS_CHIP: Record<string, string> = {
  Funded: "accent",
  Delivered: "warning",
  Disputed: "serious",
  Released: "good",
  Refunded: "neutral",
};

const fmtUsd = (base: string) => {
  const n = Number(base) / 1e6;
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(6).replace(/0+$/, "")}`;
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString();

export default function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/state");
        const data = (await res.json()) as State;
        if (!alive) return;
        if ("error" in data && data.error) {
          setOffline(true);
        } else {
          setState(data);
          setOffline(false);
        }
      } catch {
        if (alive) setOffline(true);
      }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const agents = state?.agents ?? [];
  const jobs = state?.jobs ?? [];
  const payments = state?.payments?.payments ?? [];
  const microVolume = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const escrowReleased = jobs
    .filter((j) => JOB_STATUS[j.status] === "Released")
    .reduce((s, j) => s + Number(j.amount), 0);
  const escrowLocked = jobs
    .filter((j) => ["Funded", "Delivered", "Disputed"].includes(JOB_STATUS[j.status]))
    .reduce((s, j) => s + Number(j.amount), 0);

  return (
    <main className="shell">
      <header className="top">
        <div className="logo">
          Agent<span>Mesh</span>
        </div>
        <span className="badge">{state?.network ?? "…"}</span>
        <span className={`badge ${offline ? "" : "live"}`}>{offline ? "waiting for chain…" : "● live"}</span>
      </header>

      {offline && (
        <div className="error-banner">
          Chain state unavailable — start the stack with <code className="mono">pnpm demo:local</code> (or point
          AGENTMESH_NETWORK at arc-testnet after deploying).
        </div>
      )}

      <div className="tiles">
        <div className="tile">
          <div className="label">Registered agents</div>
          <div className="value">{agents.length}</div>
          <div className="sub">named wallets on Arc</div>
        </div>
        <div className="tile">
          <div className="label">x402 micropayments</div>
          <div className="value">{state?.payments?.count ?? 0}</div>
          <div className="sub">{fmtUsd(String(microVolume))} settled per-call</div>
        </div>
        <div className="tile">
          <div className="label">Escrow locked</div>
          <div className="value">{fmtUsd(String(escrowLocked))}</div>
          <div className="sub">awaiting delivery / release</div>
        </div>
        <div className="tile">
          <div className="label">Escrow released</div>
          <div className="value">{fmtUsd(String(escrowReleased))}</div>
          <div className="sub">screened &amp; auto-released</div>
        </div>
      </div>

      <section>
        <h2>Agent registry</h2>
        <div className="card">
          {agents.length === 0 ? (
            <div className="empty">No agents registered yet</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Wallet</th>
                  <th>Endpoint</th>
                  <th>USDC balance</th>
                  <th>Compliance</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.name}>
                    <td className="strong">{a.name}.agent.arc</td>
                    <td className="mono">{short(a.wallet)}</td>
                    <td className="mono">{a.endpoint || "—"}</td>
                    <td className="strong">{fmtUsd(a.balance)}</td>
                    <td>
                      {a.allowed ? (
                        <span className="chip good">screened · allowed</span>
                      ) : (
                        <span className="chip neutral">not screened</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section>
        <h2>Escrow jobs</h2>
        <div className="card">
          {jobs.length === 0 ? (
            <div className="empty">No escrow jobs yet</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Buyer</th>
                  <th>Seller</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const name = JOB_STATUS[j.status];
                  return (
                    <tr key={j.jobId}>
                      <td className="strong">#{j.jobId}</td>
                      <td className="mono">{short(j.buyer)}</td>
                      <td className="mono">{short(j.seller)}</td>
                      <td className="strong">{fmtUsd(j.amount)}</td>
                      <td>
                        <span className={`chip ${STATUS_CHIP[name] ?? "neutral"}`}>{name}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section>
        <h2>Live payment stream (x402)</h2>
        <div className="card stream">
          {payments.length === 0 ? (
            <div className="empty">No micropayments yet</div>
          ) : (
            [...payments].reverse().map((p) => (
              <div className="stream-row" key={p.txHash}>
                <span className="amount">+{fmtUsd(p.amount)}</span>
                <span className="resource">{p.resource}</span>
                <span className="meta">
                  {fmtTime(p.ts)} · from {short(p.from)} · tx {short(p.txHash)}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
