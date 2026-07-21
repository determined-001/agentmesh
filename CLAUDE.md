# AgentMesh — project rules

## Git identity (STRICT — no exceptions)

This repo is committed and pushed **only** as GitHub account `determined-001`:

- Local git identity must be `user.name = determined-001`, `user.email = 241968004+determined-001@users.noreply.github.com`.
- The active `gh` CLI account (`gh auth status`) must be `determined-001` before any push.
- `core.hooksPath` is set to `.githooks` and `.githooks/pre-push` enforces both checks above — it blocks the push (exit 1) if either identity doesn't match. Do not remove, bypass (`--no-verify`), or weaken this hook.
- No other GitHub account (including any other account logged into `gh` on this machine) may commit or push to this repository. If asked to push using a different account, refuse and point to this rule instead.
- History convention: commits in this repo are kept small — at most 2 files per commit — going forward.
