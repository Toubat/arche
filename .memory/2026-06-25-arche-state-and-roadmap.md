# arche: current state & roadmap lessons

- date: 2026-06-25
- source: this session's work + transferable lessons from opencode
- status: living notes

## Repo shape

- Monorepo: bun + turbo. `apps/`, `packages/`, `tsconfig.base.json`,
  `biome.json`.
- Main app: `apps/durable-objects/` (Cloudflare Workers + DOs, config in
  `wrangler.toml`, TOML not jsonc).

## apps/durable-objects current files

- `src/index.ts` — HTTP router: `/dynamic` → `AppRunner`, `/plugin` →
  `PluginHost`, `/` → `MyDurableObject` (counter).
- `src/counter.ts` — `MyDurableObject`, stateful SQLite counter. Table created
  with `CREATE TABLE IF NOT EXISTS` in the constructor (a missing table once
  caused `no such table: counter`).
- `src/supervisor.ts` — `AppRunner` DO loads dynamic code as child DO facets
  (`AGENT_CODE`) and injects `SupervisorApi` for child→parent RPC (capability
  security demo).
- `src/plugin-host.ts` — `PluginHost` DO: loads a pre-bundled plugin via
  `env.LOADER`, gets a `PluginManifest` over RPC, runs a mock agent turn calling
  hooks (`onBeforeTurnStart`/`onBeforeTurnEnd`) + tools (e.g. "shout").
- `src/plugin-sdk.ts` — `definePlugin(setup)` returns a `WorkerEntrypoint` whose
  `register()` builds `{ tools, beforeTurnStart, beforeTurnEnd }` by running
  setup in the plugin's own isolate; callbacks travel back as RPC stubs.
- `src/plugins/echo-plugin.ts` (+ `.bundle.ts`) — example plugin + generated
  bundle string.
- `scripts/build-plugins.ts` — Bun build that pre-bundles plugin TS → single JS
  string for the loader.
- `src/env.ts`, `src/cloudflare.d.ts` — bindings/types.

## wrangler.toml bindings

- DO bindings: `MY_DURABLE_OBJECT`, `APP_RUNNER`, `PLUGIN_HOST` (+ migrations).
- `LOADER` worker-loader binding for dynamic workers.

## Design intent

- Local-first, optionally cloud-hosted: a publishable package users run locally
  (easiest path for individuals), with a cloud-hosted version for enterprises
  with multiple clients connecting to a central coordinator.
- Control plane runs on the user's laptop; DOs provide single-threaded
  coordination + persistent state.

## Transferable lessons from opencode (priority order)

1. **`function`'s `SyncServer` DO is the closest reference** — "DO as live hub,
   R2 as durable mirror": one DO per session via `idFromName`, `acceptWebSocket`
   fan-out, dual-write every event to `ctx.storage` + R2. arche is already
   partway there.
2. **`schema → protocol → server` + dual codegen** — declare control-plane RPCs
   once as a typed `HttpApi`; generate an Effect client (in-process DO callers)
   AND a Promise client (browser/CLI); same router serves a Worker fetch handler
   and a DO `fetch`. Commit generated code, fail CI on drift.
3. **Location-scoped services map 1:1 onto DOs** — one DO = one "Location"
   owning its SessionRunner/tools/permissions/FS; keep `SessionExecution`
   process-global keyed by Session ID (= DO single-thread-per-id guarantee).
4. **`llm`'s 4-axis provider split (Protocol/Endpoint/Auth/Framing)** — store
   the canonical `LLMEvent` stream in the DO transcript, never provider-specific
   events, so replay + client catch-up stay provider-independent.
5. **Effect `SqlClient` as the storage seam** — write a `SqlClient` over
   `state.storage.sql`; Drizzle queries/migrations then run unchanged locally
   and in the DO (mirror `effect-sqlite-node`).
6. **Daemon broker (`cli`) + in-process host (`sdk-next`)** — tiny daemon owning
   one PID + bearer token lets N clients attach to one local agent; in-process
   host lets tests/Electron dispatch handlers with no socket.
7. **`console/core`'s `Actor` pattern** — for the future multi-tenant cloud
   tier: one `Actor.provide(type, properties, cb)` carries account/user/system/
   public + workspace + role through every call.
8. **sandcastle's sandbox-handle = the Workspace tier contract** (see
   `2026-06-25-sandcastle-architecture.md`): adopt one streaming
   `exec(cmd,{onLine,cwd,stdin}) => {stdout,stderr,exitCode}` + `copyIn`/
   `copyFileOut` + `worktreePath` + `close()`, tagged bind-mount|isolated|none
   (= local vs cloud). Normalize the agent stdout stream ONCE into a
   provider-neutral event union at the worker, then fan out to N clients. Make
   the single-flight/ownership lock explicit at the workspace boundary (DOs give
   this for free per id).

## Open follow-ups (not yet done)

- Expand `SyncServer` into a concrete `apps/durable-objects` architecture sketch
  (event log table + R2 mirror + SSE/WebSocket fan-out).
- Translate the V2 session-admission spec into a DO `runTurn` + Alarm design
  (durable prompt admission separate from model execution).
