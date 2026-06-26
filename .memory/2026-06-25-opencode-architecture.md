# opencode architecture (study notes)

- date: 2026-06-25
- source: deep-dive of `~/Documents/GitHub/opencode` (branch `dev`) to inform `arche`
- status: reference

## Why we studied it

`arche` is building a local-first, optionally cloud-hosted coding-agent control
plane on Cloudflare Durable Objects (DOs). `opencode` solves the same shape
(local agent server + multiple clients + optional cloud sync), so its boundaries
are a strong reference.

## Dependency direction (the single most important rule)

From `opencode` root `AGENTS.md`. Everything flows out of one zero-dependency
contract package (`schema`):

```
schema  ←  protocol  ←  server
schema  ←  core      ←  server
schema, protocol  ←  client        (client must NOT import core/server)
sdk-next  =  client + core + server
```

`effect-sqlite-node` and `effect-drizzle-sqlite` must stay generic (no
opencode-specific tables/paths). Schema holds wire/storage contracts only;
runtime behavior lives in the owning domain.

## Package map by layer

### Contracts & codegen
- `schema` — browser-safe Effect Schema for every wire/storage shape; branded
  IDs (`SessionID`); only depends on `effect`. No I/O.
- `protocol` — public API surface as an Effect `HttpApi`; middleware slots are
  abstract `Context.Key`s, concrete services injected later.
- `httpapi-codegen` — compiles the `HttpApi` into TWO clients (Effect + plain
  Promise/`fetch`); tracks generated files; fails CI on drift.
- `client` — generated typed transport (`@opencode-ai/client` Promise +
  `/effect`). Replacement for legacy `sdk`.
- `sdk` (legacy) — OpenAPI-generated; ships `createOpencodeServer()` that just
  `cross-spawn`s `opencode serve`.
- `sdk-next` (transitional) — in-process host: `OpenCode.create()` runs the
  server router in memory, no socket.

### Runtime core
- `core` — the fat runtime: sessions, agents, tool/permission/skill registries,
  providers, FS, PTY, git, snapshots, plugin host, system-context, V2 session
  runner. Everything is **Location-scoped**. Uses conditional `#sqlite`/`#pty`
  imports to swap Bun vs Node backends.
- `llm` — provider-neutral LLM core. Decomposes provider access into 4
  orthogonal axes: **Protocol** (body + event state machine), **Endpoint**
  (URL), **Auth** (signing/bearer), **Framing** (SSE/eventstream). Emits one
  canonical `LLMEvent` stream. No `@ai-sdk/*` runtime dependency.
- `plugin` — public plugin SDK (Promise + Effect + v2); pulls only generated
  SDK types, no runtime.
- `server` — thin layer binding abstract protocol middleware to concrete `core`
  services + handlers.

### Storage adapters & test infra
- `effect-sqlite-node` — Node 22 `node:sqlite` adapter implementing Effect's
  generic `SqlClient` (sibling of `@effect/sql-sqlite-bun`).
- `effect-drizzle-sqlite` — vendored Drizzle ↔ Effect SQLite adapter; generic.
- `http-recorder` — VCR-style recorder for Effect `HttpClient` + WebSocket;
  records real provider traffic into committed JSON cassettes for deterministic,
  secret-free tests.

### Entrypoints & clients
- `opencode` — the shipping binary (`bin/opencode` → `src/index.ts`, big yargs
  tree: `serve`, `tui`, `run`, `mcp`, `attach`…). One binary that either serves
  a local HTTP/SSE API or runs a UI against it.
- `cli` (binary `lildax`) — newer Effect-based CLI owning the **daemon
  lifecycle** (PID `server.json` + bearer password file) so N clients attach to
  one local process.
- `tui` — terminal UI in SolidJS via `@opentui/solid` (same component model as
  the web app).

### Graphical UI & sites
- `app` (web SPA, Vite+SolidJS), `desktop` (thin Electron wrapper owning IPC /
  PTY / auto-update), `ui` (design system, only published UI surface),
  `session-ui` (streaming message/diff rendering), `storybook`, `web` (Astro
  marketing site), `docs` (Mintlify, fed by `openapi.json`).

### Cloud / commercial
- `function` — **Cloudflare Worker + `SyncServer` Durable Object**
  (`src/api.ts`). The closest reference for arche. See event-sourcing notes.
- `console/core` — multi-tenant SaaS backend: `actor` (account/user/system/
  public + workspace + role), `billing`, `subscription`, `referral`,
  `workspace`, `provider`, `model`, `key`. Drizzle + PlanetScale.
- `console/function` — CF Workers: `auth`, `log-processor`, `stat`.
- `console/app` — console web app (SolidStart).
- `console/resource` — resource shim: same API over `cloudflare:workers` env
  bindings OR the Cloudflare REST SDK under Node.
- `console/mail`, `console/support` — transactional email / support lookup.
- `enterprise` — self-hostable SolidStart app exposing share/storage over an
  S3/R2 `Storage.Adapter` (aws4fetch).
- `stats/*` — separate analytics property (SolidStart app + Effect core +
  Lambda + Athena) for token usage/cost.
- `slack` — Slack bot mapping each thread to an opencode session.

### Build/brand (not architectural)
- `script` (release tooling), `containers` (CI Docker images), `identity`
  (logo SVGs only).

## Event sourcing & the "multiple writers" subtlety

Core file: `packages/core/src/event.ts` (+ `event/sql.ts`).

- Live events broadcast via Effect `PubSub`. Durable events persisted to
  `EventTable` with a monotonic per-aggregate `seq`; `EventSequenceTable` tracks
  the latest seq per `aggregateID` (e.g. session id).
- `commitDurableEvent` is an "optimistic-concurrency dance" inside a SQLite
  `BEGIN IMMEDIATE` transaction: read latest seq, validate incoming seq +
  ownership (`owner_id`), reject replays, then bump seq + insert.
- `durable()` stream = historical events (from SQLite) concatenated with live
  events (per-aggregate PubSub) → gapless replay + live tail for mid-stream
  client joins.

### Key correction (clarified this session)
Default/local mode is **one session → one DB → one writer** (the owning
instance), exactly like a DO. The seq/owner machinery is effectively dormant
there (`BEGIN IMMEDIATE` alone suffices).

"Multiple writers" only arises from the **experimental Workspaces** feature
(`flags.experimentalWorkspaces`) where a session physically MOVES between
instances/machines, each with its own DB. See
`packages/opencode/src/control-plane/workspace.ts`:
- `sessionWarp` reads all of a session's events from the source DB, POSTs them
  in batches to the target instance's `/sync/replay`, then `/sync/steal`, then
  `setWorkspace`.
- `events.claim(sessionID, newWorkspaceID)` fences the old owner: "any future
  events coming from the old workspace are ignored".
- `syncWorkspaceLoop`/`syncHistory` mirror a remote instance's events into the
  local DB via `replay` with `ownerID`.

So seq + owner_id + idempotent replay = **distributed log reconciliation**
across separate databases (locks can't span DBs). A DO is natively single-owner
per id, so it needs none of this UNLESS you replicate its log out (to R2 /
another region / another DO) — then the same reconciliation problem returns.

## SyncServer DO (the direct reference for arche)

`packages/function/src/api.ts`, `class SyncServer extends DurableObject<Env>`:
- KV-style classic DO storage (not SQLite-backed) + R2 mirror.
- WebSocket fan-out via `ctx.acceptWebSocket` / `getWebSockets()`.
- `publish(key, content)` dual-writes: `Bucket.put("share/{key}.json", …)` (R2)
  **and** `ctx.storage.put(key, content)`, then broadcasts to all sockets.
- RPC methods (`share`, `publish`, `getData`, `clear`, `assertSecret`) called
  from the Hono Worker. Pattern = "DO as live hub, R2 as durable mirror".

## Live update path (local serve)

- `/event` SSE endpoint (`server/routes/instance/httpapi/handlers/event.ts`):
  unbounded Queue subscribed to `EventV2Bridge.Service`, filtered by instance/
  workspace, streamed as `text/event-stream` with `server.connected` +
  `server.heartbeat`.
- `EventV2Bridge` injects `location` (dir/workspaceID/project) and forwards to a
  Node `EventEmitter` `GlobalBus`.
- Mid-stream join works via subscribe-then-snapshot + durable replay by `seq`.

## specs/ folder = the V2 redesign

Per-file: `project.md` (structure), `layer-node-tiers.md` (process-global vs
location-scoped service tiers validated at graph build), `tui-package.md`,
`storage/effect-sqlite-package.md` + `storage/remove-opencode-db.md` (the
SqlClient seam + DB migration), `v2/session.md` (durable prompt admission
separate from model execution; reusing a Session ID adopts it; one runner per
session), `v2/config.md` + `instructions.md` (layered config), `v2/
provider-model.md` + `provider-policy.md` (resolution + ordered allow/deny),
`v2/catalog-config-plugin-lifecycle.md` (plugins as replayable Immer
transforms), `v2/tools.md` (tools as opaque codec+executor records),
`v2/schema-changelog.md`, `v2/todo.md`.

Recurring themes:
1. Durable admission vs. model execution (persist intent first, then wake runner).
2. Event-source with per-aggregate sequence numbers, not wall-clock.
3. Tier services: process-global vs location-scoped; validate graph at build.
4. Layered, replayable config + ordered policy (later layers override).
5. Dumb core services + plugin hook points (opaque records, scoped overlays).
