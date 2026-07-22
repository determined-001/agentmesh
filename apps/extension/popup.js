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

// DOM builders only — agent names come from the on-chain registry, which anyone
// can write to; interpolating them into innerHTML would be popup XSS.
function span(className, text) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}

function div(className, ...children) {
  const d = document.createElement("div");
  d.className = className;
  for (const c of children) d.append(c);
  return d;
}

function empty(container, text) {
  container.replaceChildren(div("empty", text));
}

function render(state) {
  $("network").textContent = state.network;
  $("status").textContent = `${state.agents.length} agents · ${state.payments.count} micropayments`;

  $("agents").replaceChildren();
  for (const a of state.agents) {
    $("agents").append(
      div(
        "row",
        div("top", span("name", `${a.name}.agent.arc`), span("bal", fmtUsd(a.balance))),
        div(
          "top",
          span("meta", short(a.wallet)),
          span(`chip ${a.allowed ? "good" : "neutral"}`, a.allowed ? "screened ✓" : "not screened"),
        ),
      ),
    );
  }
  if (!state.agents.length) empty($("agents"), "No agents yet");

  const pending = state.jobs.filter((j) => JOB_STATUS[j.status] === "Delivered");
  $("pending").replaceChildren();
  for (const j of pending) {
    const approve = document.createElement("button");
    approve.className = "approve";
    approve.textContent = "Approve release";
    approve.addEventListener("click", (e) => act("release", j.jobId, e.target));
    const disputeBtn = document.createElement("button");
    disputeBtn.className = "dispute";
    disputeBtn.textContent = "Dispute";
    disputeBtn.addEventListener("click", (e) => act("dispute", j.jobId, e.target));

    $("pending").append(
      div(
        "row",
        div("top", span("name", `Job #${j.jobId} — ${fmtUsd(j.amount)}`), span("chip warning", "Delivered")),
        div("meta", `seller ${short(j.seller)} · dispute window open`),
        div("actions", approve, disputeBtn),
      ),
    );
  }
  if (!pending.length) empty($("pending"), "Nothing awaiting approval");

  $("jobs").replaceChildren();
  for (const j of state.jobs.slice(0, 5)) {
    const name = JOB_STATUS[j.status];
    $("jobs").append(
      div(
        "row",
        div(
          "top",
          span("name", `#${j.jobId} · ${fmtUsd(j.amount)}`),
          span(`chip ${CHIP[name] || "neutral"}`, name),
        ),
        div("meta", `${short(j.buyer)} → ${short(j.seller)}`),
      ),
    );
  }
  if (!state.jobs.length) empty($("jobs"), "No escrow jobs yet");
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
