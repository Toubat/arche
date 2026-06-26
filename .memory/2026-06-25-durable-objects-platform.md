# Cloudflare Durable Objects platform facts (for arche)

- date: 2026-06-25
- source: Cloudflare docs (verified via docs MCP) + workerd experiments in `arche`
- status: reference

## SQLite storage limit

- **10 GB per Durable Object** for SQLite-backed DOs (GA 2025-04-07; was 1 GB in
  beta — ignore stale 1 GB footnotes).
- Limit is **per instance** (per unique `idFromName(...)`), not per class/
  account. Scale = `10 GB × number of objects` → shard one DO per session/room/
  tenant.
- SQLite API only on **SQLite-backed** classes (`new_sqlite_classes` migration).
  Free plan can ONLY create SQLite-backed DOs.

### Practical constraints alongside the 10 GB
- **128 MB memory** per DO isolate at runtime → can store 10 GB but cannot load
  it all in memory; stream/paginate with SQL `LIMIT`/cursors.
- Individual `TEXT`/`BLOB` values capped ~low-MB → 10 GB is meant to be spread
  across many rows, not a few giant blobs. Big binaries belong in **R2** with the
  DO holding metadata/pointers (the SyncServer pattern).

## workerd runtime constraints (relevant to agent loops)

- No filesystem, no subprocess/child_process, no arbitrary native binaries.
- An agent loop that only calls model APIs + HTTP orchestration works fine in a
  DO. A full coding agent that touches FS / spawns LSP / runs shell does NOT —
  that part must run in a native (Bun/Node) process locally. This is exactly why
  opencode keeps the agent loop local and uses DOs only for shared coordination.
- `nodejs_compat` flag enables many `node:*` builtins. `node:fs` import in a
  dynamic worker fails without it (`No such module "node:fs"`); adding
  `compatibilityFlags: ["nodejs_compat"]` to the loader options resolves the
  import (though FS still won't have a real disk).

## Scheduling

- DO **Alarms**: per-object scheduled wake (`ctx.storage.setAlarm` /
  `alarm()` handler). Good for background control-plane tasks that emit to the
  agent. One pending alarm per object.

## Dynamic workers (Worker Loader / facets)

- `env.LOADER.get(...)` loads arbitrary code strings as isolated Workers at
  runtime; can run as DO facets (child DOs) supervised by a parent.
- Parent⇄child interaction works via RPC; capability injection via
  `ctx.exports.<Service>({})` (note: pass an empty options object, e.g.
  `this.ctx.exports.SupervisorApi({})`, or you get
  "parameter 1 is not of type 'Options'").
- Plugins/agent code must be **pre-bundled** to a single JS string for the
  loader (no node resolution at runtime).

## npm package compat

- `zod` and the Vercel AI SDK schema bits are generally fine under
  `nodejs_compat`; problems come from packages that import `node:fs`/native
  addons or spawn processes.

## Single-writer guarantee

- A DO is single-threaded per id = inherent single writer. You do NOT need
  opencode-style optimistic concurrency (seq + owner_id) UNLESS you replicate a
  DO's log outward (R2 / another region / another DO), which reintroduces
  distributed reconciliation.

## Environment gotcha observed this session

- `wrangler dev` / `wrangler deploy --dry-run` hung at startup due to multiple
  `esbuild`/`workerd` processes stuck in uninterruptible I/O wait (`UE` state),
  caused by heavy memory paging + nearly full disk → disk I/O thrashing. Not
  killable; required a **reboot**. Freed ~69 GB (Unreal Engine + regenerable
  node_modules/.venv/datasets) to drop disk from 91% → 74%.
