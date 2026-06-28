# @arche/concurrency — design, semantics & status

- date: 2026-06-26 (updated 2026-06-27: io.context() API + spawn short-circuit)
- source: design session + TDD build + edge-case hardening pass (verified: 50 tests, 100% coverage, tsc + biome clean)
- status: verified

## What it is

Lightweight, **non-viral**, ALS-backed structured-concurrency library for TS
(Node/workerd/Bun; no browser). Alternative to Effect (avoids Effect's
"virality") while giving agent loops cancellable concurrent "threads". Single
`io.*` namespace.

- Package: `packages/concurrency`, name `@arche/concurrency`.
- Source-linking export condition is `@arche/source` (renamed repo-wide from the
  leftover `@repo/source`; set in `tsconfig.base.json` `customConditions` + each
  package's `exports`).
- Spec: `packages/concurrency/DESIGN.md`. Build plan:
  `~/.cursor/plans/concurrency_lib_design_0995abba.plan.md`.

## Core files (`packages/concurrency/src/`)

- `index.ts` — exports `io` namespace (`context`, `coroutine`, `sleep`), `defer`,
  error classes, types.
- `coroutine.ts` — `io.coroutine`/`RoutineHandle` lifecycle, cancellation,
  defers, strict teardown. The heart of the library.
- `context.ts` — `io.context(): Ctx` reads the ambient scope's `ctx`.
- `scope.ts` — `AsyncLocalStorage`-based ambient `Scope`
  (`{ signal, ctx, defers, children }`); `runInScope` / `currentScope`.
- `sleep.ts` — cancellation-aware `io.sleep`.
- `defer.ts` — global `defer(cb)` pushes to current scope.
- `errors.ts` — `ConcurrencyError`, `CancelledError`,
  `CoroutineAlreadyStartedError`.
- `types.ts` — `Coroutine`, `RoutineHandle`, `Ctx`, `SpawnOptions`,
  `ChildHandle`, `DeferCallback`.

## Mental model

- `io.coroutine(fn)` is **lazy** (fn body doesn't run until `.spawn()`), like a
  Python coroutine vs Task. `.spawn()` twice → `CoroutineAlreadyStartedError`.
- `spawn()` returns a `RoutineHandle` that is **thenable** (`PromiseLike`, awaitable),
  with `cancel()`, `cancelGracefully(opts?)`, `cancelled` getter. External result
  is memoized (await twice = same value, body runs once).
- **`ctx` is NOT a body parameter** (changed 2026-06-27). Bodies and `defer`
  callbacks are **parameterless** (`() => Promise<T>` / `() => void|Promise<void>`).
  Fetch the context on demand: `const ctx = io.context()` → `{ signal, cancelled
(getter), throwIfCancelled(), name }`. Selective/opt-in so the common no-cancel
  body stays clean. `io.context()` reads ALS so it works after any number of
  `await` hops and inside `Promise.all`/`.then` callbacks.
  - Outside any coroutine → **throws** `ConcurrencyError` (code
    `no_active_coroutine`); chose throw over a fake non-cancellable root ctx
    (which would silently make cancellation no-op).
  - Inside a `defer` → returns the **shielded cleanup ctx** (`cancelled === false`).
  - `Ctx.name` is still always `undefined` (never wired to `SpawnOptions`);
    naming for zombie/unhandled logs is a small follow-up.

## Cancellation semantics (the important, subtle part)

- **Injection at framework await points**: the in-flight framework await
  (`io.sleep`, future `chan.receive`, …) throws `CancelledError`; body unwinds via
  `try/finally` + `defer`. JS can't interrupt raw `await p` or tight sync loops →
  grab `io.context()` and cooperate (`ctx.throwIfCancelled()`), or thread
  `ctx.signal` into raw calls (`fetch(url, { signal: io.context().signal })`).
- **Idempotent**: repeated `cancel()` / `cancelGracefully()` are no-ops after the
  first (`#cancelRequested` flag).
- **Spawn short-circuit** (bug fix 2026-06-27): if a coroutine is spawned into an
  **already-aborted** scope (e.g. an already-cancelled parent), the body **never
  runs at all** — handle settles `CancelledError` immediately. `runWithDefers`
  checks `scope.signal.aborted` before invoking `body()`.
  - The bug before this: the body's **synchronous prefix (up to its first
    framework await) DID run**, firing unwanted side effects (e.g. a cancelled
    retry still doing a `db.write()`). The handle _outcome_ was always correct
    (`CancelledError` via signal-linking + "cancellation wins"); only side effects
    leaked. Invisible to bodies that hit a framework checkpoint before any side
    effect. Only triggers when aborted synchronously at spawn; later cancellation
    is normal cooperative injection.
- **Level-triggered re-raise** (Trio-style): once the scope is aborted, the _next_
  `io.sleep` rejects immediately (see `sleep.ts` already-aborted early return).
- **Cancellation wins** (DECISION this session — fixes the asyncio "swallowed
  CancelledError looks successful" footgun): a coroutine whose own scope was
  aborted can **never settle with a value**. If the body catches `CancelledError`
  and `return`s, the handle still rejects `CancelledError`. Implemented in
  `coroutine.ts` runWithDefers: `if (outcome.ok && scope.signal.aborted) → CancelledError`.
  A _different_ thrown error while cancelled is **preserved as-is** (diagnostics),
  not masked. (Soft alternative — let body deny cancellation, asyncio-style — was
  rejected; one-line revert if ever wanted.)
- **Two timeouts** (both default 5000ms, overridable via `SpawnOptions` /
  `cancelGracefully({ timeoutMs })`):
  - _cancel timeout_ = budget for body to halt after cancel; if exceeded the body
    is abandoned as a **zombie**, handle settles `CancelledError`, logs
    `"coroutine hung: … did not halt within Nms"`.
  - _defer timeout_ = total budget for the whole LIFO defer chain; on exhaustion a
    fresh cleanup signal aborts, remaining defers skipped + warning.

## defer

- Global `defer(() => …)` (parameterless; use `io.context()` for the cleanup
  signal), LIFO, runs on normal completion AND on cancel.
- Cleanup runs **shielded** under a fresh non-aborted signal (so cleanup can do
  bounded async work even when the coroutine was cancelled).
- Best-effort: a throwing sync/async defer is swallowed; the rest of the chain
  still runs. `defer()` outside any coroutine is a silent no-op.

## Strict structured concurrency (a child cannot outlive its parent)

- `Scope.children: Set<ChildHandle>`; each spawned child registers with its parent
  scope and deregisters on settle.
- On parent scope exit (normal completion OR cancel), `teardownChildren` runs
  **before** the parent's own defers: every still-running child is
  `cancelGracefully()`'d and awaited → leaf-first teardown, grandchildren before
  children. Bounded by each child's cancel timeout (a hung grandchild can't block
  the parent forever).
- **Strict teardown, NOT strict fault propagation**: errors from background
  children do NOT bubble up to the parent (keeps the non-viral error model).
  Inspired by Effection's strict-structured-concurrency blog.

## Error model

- **No upward fault propagation** (non-viral). Unobserved errors are logged, not
  re-thrown into parents. (Fail-fast combinators like `io.all` are a follow-up.)
- Error classes carry a class + are subclasses of `ConcurrencyError`.

## Test status (verified 2026-06-27)

- 50 tests; **100% functions + 100% lines** coverage; tsc `--noEmit` clean;
  biome clean.
- Edge-case suites: `edge-cancellation` (incl. cancellation-wins, level-triggered
  re-raise, `io.context()` surface + outside-coroutine throw + defer-shielded ctx,
  spawn short-circuit), `edge-sleep`, `edge-defer`, `edge-errors`,
  `edge-lifecycle`, `edge-graceful`, `edge-strict-races`, `edge-als` (+ original
  `coroutine`/`sleep`/`cancel`/`defer`/`nested`/`graceful`/`defer-timeout`/`strict`).
- ALS verified to survive multiple await hops and `Promise.all`/`.then` callbacks
  (children stay correctly parented + torn down) — the key implicit-context risk.

## Research references (for cancellation design)

- Trio: level-triggered cancellation + shielded cleanup.
- asyncio: swallowing `CancelledError` makes a cancelled task look successful
  (cpython#102780); motivated the "cancellation wins" decision.

## Next (Milestone 2 — slices 8-16, NOT started; user wanted to review first)

- Combinators: `io.all`/`io.race` (fail-fast, cancellable RoutineHandle),
  `io.background`/`io.allSettled` (unobserved-error log), `io.withTimeout`
  (`TimeoutError`), `io.withRetry` (factory).
- Data structures: `io.future`, `io.channel`, `io.mutex`/`io.semaphore`,
  `io.waitGroup`. Global: `io.cancelGlobal`. pubsub is a TODO.
- Open design questions surfaced: `io.withTimeout` completion-vs-timeout race
  (same "cancellation wins" tension); `io.all`/`race` sibling teardown on first
  failure (reuses strict-teardown machinery).
