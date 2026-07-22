const API = "http://localhost:3000/api";
const JOB_STATUS = ["None", "Funded", "Delivered", "Disputed", "Released", "Refunded"];
const CHIP = {
  Funded: "accent",
  Delivered: "warning",
  Disputed: "serious",
  Released: "good",
  Refunded: "neutral",
};

const $ = (id) => document.getElementById(id);
const fmtUsd = (base) => {
  const n = Number(base) / 1e6;
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(6).replace(/0+$/, "")}`;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function act(action, jobId, btn) {
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await fetch(`${API}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, jobId }),
    });
    const data = await res.json();
    btn.textContent = res.ok ? "done ✓" : "failed";
    if (!res.ok) console.error(data);
    setTimeout(refresh, 1200);
  } catch (e) {
    btn.textContent = "failed";
    console.error(e);
  }
}

function render(state) {
  $("network").textContent = state.network;
  $("status").textContent = `${state.agents.length} agents · ${state.payments.count} micropayments`;

  $("agents").innerHTML = "";
  for (const a of state.agents) {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="top">
        <span class="name">${a.name}.agent.arc</span>
        <span class="bal">${fmtUsd(a.balance)}</span>
      </div>
      <div class="top">
        <span class="meta">${short(a.wallet)}</span>
        <span class="chip ${a.allowed ? "good" : "neutral"}">${a.allowed ? "screened ✓" : "not screened"}</span>
      </div>`;
    $("agents").appendChild(el);
  }
  if (!state.agents.length) $("agents").innerHTML = '<div class="empty">No agents yet</div>';

  const pending = state.jobs.filter((j) => JOB_STATUS[j.status] === "Delivered");
  $("pending").innerHTML = "";
  for (const j of pending) {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="top">
        <span class="name">Job #${j.jobId} — ${fmtUsd(j.amount)}</span>
        <span class="chip warning">Delivered</span>
      </div>
      <div class="meta">seller ${short(j.seller)} · dispute window open</div>
      <div class="actions">
        <button class="approve">Approve release</button>
        <button class="dispute">Dispute</button>
      </div>`;
    el.querySelector(".approve").addEventListener("click", (e) => act("release", j.jobId, e.target));
    el.querySelector(".dispute").addEventListener("click", (e) => act("dispute", j.jobId, e.target));
    $("pending").appendChild(el);
  }
  if (!pending.length) $("pending").innerHTML = '<div class="empty">Nothing awaiting approval</div>';

  $("jobs").innerHTML = "";
  for (const j of state.jobs.slice(0, 5)) {
    const name = JOB_STATUS[j.status];
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <div class="top">
        <span class="name">#${j.jobId} · ${fmtUsd(j.amount)}</span>
        <span class="chip ${CHIP[name] || "neutral"}">${name}</span>
      </div>
      <div class="meta">${short(j.buyer)} → ${short(j.seller)}</div>`;
    $("jobs").appendChild(el);
  }
  if (!state.jobs.length) $("jobs").innerHTML = '<div class="empty">No escrow jobs yet</div>';
}

async function refresh() {
  try {
    const res = await fetch(`${API}/state`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch {
    $("status").textContent = "Dashboard offline — run pnpm dev:dashboard";
  }
}

refresh();
setInterval(refresh, 3000);
