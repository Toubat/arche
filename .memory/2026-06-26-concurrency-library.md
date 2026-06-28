# @arche/concurrency — design, semantics & status

- date: 2026-06-26 (updated 2026-06-27: Milestone 2 done; + `io.background`→`io.spawn`, strict blocking-op short-circuit)
- source: design session + TDD build + edge-case hardening + Milestone 2 (verified: 121 tests, 100% LINE coverage, tsc + biome clean)
- status: verified — Milestone 1 (core) + Milestone 2 (combinators + data structures) complete

## What it is

Lightweight, **non-invasive**, ALS-backed structured-concurrency library for TS
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

- `index.ts` — exports `io` namespace (full surface below), `defer`, error
  classes, types.
- `coroutine.ts` — `io.coroutine`/`RoutineHandle` lifecycle, cancellation,
  defers, strict teardown. The heart of the library.
- `context.ts` — `io.context(): Ctx` reads the ambient scope's `ctx`.
- `scope.ts` — `AsyncLocalStorage`-based ambient `Scope`
  (`{ signal, ctx, defers, children }`); `runInScope` / `currentScope`; `makeCtx`
  (moved here from coroutine.ts); **root scope** machinery (`rootScope`,
  `abortRoot`, `resetRoot`) — implicit parent of top-level coroutines.
  `rejectIfCancelled()` (added 2026-06-27): shared blocking-op short-circuit —
  returns a rejected `CancelledError` promise iff the ambient scope is aborted,
  else `undefined`. Used by channel/semaphore/waitGroup.
- `utils.ts` — cancellation-aware `io.sleep` (was `sleep.ts`).
- `defer.ts` — global `defer(cb)` pushes to current scope.
- `combinators.ts` — `io.all`/`io.race`/`io.allSettled`/`io.spawn`/
  `io.withTimeout`/`io.withRetry` (all thin coroutines over the core machinery).
- `future.ts` — `io.future` (externally-settled, write-once, intrinsic cancel).
- `channel.ts` — `io.channel` (buffered/rendezvous, competing-consumer, async-iterable).
- `semaphore.ts` — `io.semaphore` / `io.mutex` (FIFO, cancellable acquire, runExclusive).
- `waitgroup.ts` — `io.waitGroup` (Go-style add/done/wait).
- `waiters.ts` — internal `WaiterQueue`: cancellation-safe FIFO park/wake primitive
  shared by channel/semaphore/waitGroup (cancelled waiters self-remove).
- `global.ts` — `io.cancelGlobal` / `io.cancelGlobalGracefully` (abort root + reset).
- `log.ts` — swappable structured logger (`log`, `setLogger`, `resetLogger`).
- `errors.ts` — `ConcurrencyError`, `CancelledError`,
  `CoroutineAlreadyStartedError`, `TimeoutError`, `ChannelClosedError`,
  `WaitGroupError`; `code` is a typed union `ConcurrencyErrorCode`.
- `types.ts` — `Coroutine`, `RoutineHandle`, `Ctx`, `SpawnOptions`, `RetryOptions`,
  `Backoff`, `Future`, `Channel`, `Semaphore`, `Mutex`, `WaitGroup`,
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
- **Blocking-op short-circuit** (added 2026-06-27, same spirit as spawn short-circuit):
  every blocking data-structure op — `chan.send`/`chan.receive`, `semaphore.acquire`,
  `waitGroup.wait` — called from an **already-aborted** scope rejects `CancelledError`
  and makes **no progress, even when it could complete synchronously**: it will NOT
  drain a buffered value, take a free permit, or resolve on a zero counter. The
  value/permit stays for a live consumer instead of being silently swallowed by a
  coroutine on its way out. One-liner via `rejectIfCancelled()` at the top of each op.
  Parking paths were already cancel-safe (`WaiterQueue.wait`); this closes the
  synchronous fast-path holes. Top-level (non-coroutine) callers have no ambient
  scope → never short-circuited.
  - **DECISION**: do NOT wrap data-structure ops in `io.coroutine().spawn()` to get
    this "for free". "Cancellation wins" would rewrite a _successful_ receive (value
    already shifted off the buffer) into `CancelledError` → the value is LOST (the
    loss bug we eliminated). Plus per-op coroutine allocation overhead on a hot path,
    and it's a category error (a receive is a sync point, not a task). The narrow
    short-circuit + `WaiterQueue` removal is the right, cheap abstraction.
- **Level-triggered re-raise** (Trio-style): once the scope is aborted, the _next_
  `io.sleep` rejects immediately (see `utils.ts` already-aborted early return).
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
  re-thrown into parents.
- Error classes are subclasses of `ConcurrencyError` with a typed `code`.

## Milestone 2 — combinators + data structures (done 2026-06-27)

All combinators are **thin coroutines** over the core machinery, so fail-fast +
strict teardown fall out for free (the member coroutines are children of the
combinator's scope; on body settle, `teardownChildren` cancels the losers).

- `io.all(coros)` — input-order results; first rejection tears down + rejects (fail-fast).
- `io.race(coros)` — `Promise.race` (first to **settle**, resolve OR reject, wins);
  losers torn down and **awaited** before the handle settles (consistent w/ strict
  SC). First-to-**resolve** is the separate future `io.any` (TODO).
- `io.allSettled(coros)` — never rejects on member failure; all run to completion.
- `io.withTimeout(ms, coro)` — races work vs a timer coroutine (both children); loser
  cancelled; rejects `TimeoutError`. NOTE arg order is **(ms, coro)** per DESIGN.
- `io.withRetry(factory, opts?)` — factory mints a fresh coroutine per attempt
  (Coroutines are one-shot). `RetryOptions` = `{ maxAttempts=3, backoff=
"exponential"|"linear"|"constant", baseDelayMs=100, maxDelayMs=30_000,
jitter=true (full jitter), shouldRetry, onRetry }`. **CancelledError is never
  retried.** Backoff via an exhaustive `Record<Backoff, …>` map (not a switch).
- `io.spawn(coro | coros)` — fire-and-forget; **renamed from `io.background`** and made
  **polymorphic** (2026-06-27): single `Coroutine<T>` → `RoutineHandle<T>` (direct
  `.spawn()`), or `Coroutine<T>[]` → `RoutineHandle<T[]>` (reuses `io.all`). Parented
  to the caller (torn down on caller exit). Attaches a logging `.catch` so a
  **non-cancellation** failure logs `{ code: "spawn_error" }` instead of an unhandled
  rejection; CancelledError (normal teardown) is NOT logged. Distinct from
  `coro.spawn()` (low-level start): `io.spawn` adds the unobserved-error logger.
  Bare-async-body axis (`() => Promise<T>`) is still TODO (post-union).
- `io.future<T>()` — externally `resolve`/`reject`, write-once (later settles are
  no-ops), thenable. **Cancellation is intrinsic and bound to the CREATING
  coroutine** (captures the scope signal at construction; on abort rejects itself
  with CancelledError). No per-await wrapper, internal promise never left dangling.
  (Earlier draft used a `cancellable()` util wrapper bound to the _awaiter_ — removed;
  it left the promise pending on cancel.) Created outside a coroutine = not cancellable.
- `io.channel<T>({ capacity? })` — Go-style, **competing-consumer** (each value to
  one receiver), `capacity 0` = rendezvous, `>0` = buffered FIFO. `send`/`receive`
  block cancellably; `for await` ends cleanly on `close`; `send` after close and
  `receive` after close+drain reject `ChannelClosedError`; `close` wakes blocked
  receivers (done) and rejects blocked senders. Backed by two `WaiterQueue`s.
  - **Value-commitment invariant**: a value is "in the channel" only once **buffered**
    or handed directly to a receiver. A value riding on a **parked sender** is
    in-flight, NOT committed → it is **dropped** both on cancel of that sender AND on
    `close` (matches Go: close with a blocked sender is a sender-side error; we reject
    `ChannelClosedError`). Already-buffered values still drain after close.
  - **Multi-consumer guarantees** (tests pin these): N `for await` consumers get a
    **disjoint partition** (each item to exactly one consumer — `wakeOne`/`buffer.shift`
    each hand one value to one caller; `send` is a strict deliver-XOR-buffer-XOR-park).
    If some consumers are cancelled mid-stream, the union across ALL buckets still
    equals every item (no loss — cancelled blocked receivers self-remove before any
    value is committed; a received value is pushed synchronously before the next
    cancellable await). With the strict short-circuit, a cancelled consumer no longer
    drains ready buffered items (they go to survivors); union invariant still holds.
- `io.semaphore(n)` / `io.mutex()` (= semaphore(1)) — `acquire()` → idempotent
  release token (FIFO, cancellable park); `runExclusive(fn)` always releases (incl.
  throw/cancel); `available` getter. Release hands the permit straight to the next
  waiter, else returns it to the pool.
- `io.waitGroup()` — `add(delta=1)` / `done()` / `wait()`; counter < 0 throws
  `WaitGroupError` (counter unchanged); `wait` resolves when counter hits 0
  (`resolveAll` wakes all waiters), cancellable.
- `io.cancelGlobal()` / `io.cancelGlobalGracefully(opts?)` — top-level coroutines are
  implicitly parented to a module **root scope**; these abort it (cascading to all)
  and install a **fresh root** so the runtime stays usable / tests stay isolated.
  Graceful awaits every child's `cancelGracefully` (defers flushed) first.

`WaiterQueue<TResolve, TPayload>` (internal, `waiters.ts`): FIFO park/wake; a
cancelled waiter splices itself out so a later `wakeOne` is never handed to an
abandoned waiter; waiters can carry a payload (channel sender's value).

## Test status (verified 2026-06-27)

- **121 tests; 100% LINE coverage** across all files; tsc `--noEmit` clean; biome clean.
  (+strict blocking-op short-circuit tests for channel/semaphore/waitGroup, channel
  multi-consumer partition + mid-cancel union tests, `io.spawn` single+list tests —
  all written RED-first per TDD.)
- Func coverage shows ~98% only due to a **bun attribution quirk**: event-listener
  arrows (`onAbort` in `waiters.ts`) and getters/default-params bun won't credit as
  "hit" even though they ARE executed (proven by explicit cancellation tests asserting
  the body unwinds via the rejection — no 5s zombie reap). Lines are the real metric.
- Milestone 1 edge suites still present (`edge-*`, cancellation-wins, level-triggered
  re-raise, spawn short-circuit, strict-races, ALS). Milestone 2 suites:
  `combinators`, `future`, `channel`, `semaphore`, `waitgroup`, `global`.
- ALS verified to survive multiple await hops and `Promise.all`/`.then` callbacks.

## Open follow-ups (post-Milestone-2)

- **Combinators accept bare bodies**: `Coroutine<T> | (() => Promise<T>)` named union
  (`CoroutineLike<T>`) for `all`/`race`/`allSettled`/`spawn` to cut boilerplate.
  Keep Coroutine-only ownership; do NOT accept `RoutineHandle` (already-parented).
  NOTE `io.spawn` already accepts a single `Coroutine` or a list; only the bare-body
  axis remains.
- `io.any` (first to resolve), pub/sub broadcast, nursery/group object, context
  values, absolute-time deadline, generic unobserved-error logging for bare `.spawn()`.
- `Ctx.name` still always `undefined` (never wired to `SpawnOptions`).

## Research references (for cancellation design)

- Trio: level-triggered cancellation + shielded cleanup.
- asyncio: swallowing `CancelledError` makes a cancelled task look successful
  (cpython#102780); motivated the "cancellation wins" decision.
