# sandcastle: sandbox/agent API contracts

- date: 2026-06-25
- source: session deep-dive of /Users/toubatbrian/Documents/GitHub/sandcastle (v0.11.0) + explore subagent on ADRs/orchestration
- status: reference

## What it is

- npm pkg `@ai-hero/sandcastle`: a **single-process** TS CLI/library that
  orchestrates **one AI coding agent inside one isolated sandbox**. Not a server,
  not multi-client. Entry point is one function: `run({ agent, sandbox, prompt })`.
- Flow: create git worktree (per branch strategy) → stand up sandbox → run agent
  CLI in print/stream loop → parse stdout into typed events → collect commits →
  merge back.
- Provider-agnostic: built-in sandbox providers docker/podman/vercel/daytona/
  no-sandbox; agent providers claudeCode/codex/pi/cursor/opencode/copilot.
- Stack: Effect-TS, zod (peer), `@effect/cli`, tsup build. Public types are
  checked to be "effect-free" (`scripts/check-public-types-effect-free.mjs`).

## Contract 1: sandbox handle (= arche "Workspace" tier)

`src/SandboxProvider.ts`. A provider is a factory `create(opts) => handle`,
tagged `"bind-mount" | "isolated" | "none"` for dispatch. Handle methods:

- `worktreePath: string` — absolute repo dir INSIDE the sandbox.
- `exec(command, { onLine?, cwd?, sudo?, stdin? }) => Promise<ExecResult>`
  - **MUST stream stdout line-by-line via `onLine`** — buffered/batch impl
    violates the contract. Live feedback AND idle-timeout both depend on it.
  - `stdin` carries large payloads (e.g. the prompt) to dodge Linux ~128 KB
    per-arg ARG_MAX limit. Non-zero exit is RETURNED in `ExecResult`, not thrown.
- `interactiveExec?(args, { stdin, stdout, stderr, cwd? })` — optional; allocates
  a PTY (detects TTY from streams) for interactive sessions.
- file transfer: bind-mount has `copyFileIn`; isolated has `copyIn` (file OR dir);
  both have `copyFileOut`.
- `close()` — tear down.
- `ExecResult = { stdout: string; stderr: string; exitCode: number }`.

Three flavors:
- **bind-mount** (docker/podman/no-sandbox): shares host FS via mount; no sync.
- **isolated** (vercel/daytona): own FS; `copyIn` code, sync commits out via
  `git format-patch` → `copyFileOut` → host `git am --3way`. Patch base tracked
  in sandbox-local ref `refs/sandcastle/sync-base` (ADR-0017).
- **none**: runs on host, no isolation.

## Contract 2: agent provider (= how to drive the agent loop)

`src/AgentProvider.ts`. Agent reduced to pure functions:

- `buildPrintCommand({ prompt, dangerouslySkipPermissions, resumeSession?,
  forkSession? }) => { command, stdin? }` — builds the CLI invocation.
- `parseStreamLine(line) => ParsedStreamEvent[]` — normalizes ONE raw stdout
  line into provider-neutral events:
  `{type:"text"} | {type:"result"} | {type:"tool_call",name,args} |
   {type:"session_id"} | {type:"usage",usage}`.
- `buildInteractiveArgs?` — argv for TTY mode.
- `sessionStorage?: AgentSessionStorage` — provider-OWNED capture/resume
  (`captureToHost`/`resumeIntoSandbox`/`existsOnHost`/`findByIdOnHost`), because
  each agent stores sessions differently (Claude JSONL under
  `~/.claude/projects/<enc-cwd>/<id>.jsonl`, Codex rollouts `~/.codex/sessions/
  YYYY/MM/DD/`, Pi, OpenCode SQLite). Captured while sandbox still alive; `cwd`
  fields rewritten host↔sandbox on transfer.
- `captureSessions`, `env`, `parseSessionUsage?` (Claude only).

## Orchestration lifecycle (the loop to copy)

`run.ts` validates → picks branch strategy → `Orchestrator.orchestrate` loops
1..maxIterations, each: `withSandbox` → `withSandboxLifecycle` → `invokeAgent`.
- `invokeAgent`: `sandbox.exec(cmd, { onLine, stdin })`; per line, surface RAW
  line FIRST, then `parseStreamLine` → forward typed events to Display +
  `AgentStreamEmitter` (`logging.onAgentStreamEvent`). text buffered via
  `TextDeltaBuffer`.
- 3-way `Effect.raceFirst`: **idle timer** (default 600s → fail
  `AgentIdleTimeoutError`); **completion grace timer** (default 60s, armed once
  `completionSignal` substring seen → resolves SUCCESS so trailing usage/result/
  `<tag>` is captured, ADR-0019); optional `AbortSignal`.
- iteration stops when completionSignal (default `<promise>COMPLETE</promise>`)
  appears in output.

## Branch strategies (= workspace state-versioning)

- `head` — agent writes directly to host workdir, no worktree. bind-mount only,
  default for bind-mount.
- `merge-to-head` — temp branch in worktree, `git merge` back to HEAD, delete
  temp. default for isolated. `keepSourceBranch` keeps worktree reusable.
- `branch` — commits land on explicit named branch. reuse-by-default
  (clean+behind → ff-only; dirty → reuse+warn) ADR-0003.

## Concurrency contract

- Today relies on **git's own single-writer** (a branch can't be in two
  worktrees) + documented `O_EXCL` PID-stamped lock at
  `.sandcastle/locks/<name>.lock` scoped to `branch` strategy (ADR-0007, spec'd
  but not fully wired). Temp branches get random suffix to avoid same-second
  collisions. SIGINT/SIGTERM multiplexed via `shutdownRegistry`.
- ADR-0018: session-fork ≠ branch-isolation; concurrent fan-out REQUIRES distinct
  `branch` per child.

## Key recurring design principles

1. Fail fast w/ typed errors; bound EVERY step with named timeouts (ADR-0001).
2. Caller owns recovery; preserve side effects on failure (worktree kept on
   abort/error; `StructuredOutputError` carries commits + sessionId).
3. Pluggable behind narrow contracts (branch strategy, provider-owned session
   storage, `Output.*`).
4. **The agent's print stream IS the bus** — one parser → N consumers (display,
   observability, completion detector, structured-output extractor).
5. Don't conflate orthogonal concerns: completion signal ≠ structured output
   (0010); fork session ≠ fork branch (0018); abort on operations not handles
   (0004); inline prompt skips templating (0008).

## Mapping to arche 3-tier (Client / Agent-Worker / Workspace)

- **Workspace** = sandcastle sandbox handle + WorktreeManager — near 1:1; adopt
  the streaming `exec` + `copyIn`/`copyFileOut` + `worktreePath` + `close()`
  contract; bind-mount vs isolated = local-laptop vs cloud-hosted duality.
- **Agent/Worker** = sandcastle `Orchestrator` BUT only half: copy the iteration
  loop + timeout race + commit collection. sandcastle is single-shot/single-
  client; the missing long-lived multi-client worker = arche DO (single-writer
  per session id) / opencode `run-state` single-flight runner.
- **Client** = `AgentStreamEmitter` + `Display` + `onAgentStreamEvent`. Parse raw
  exec stream ONCE into provider-neutral events at the worker, fan out to N
  clients (TUI/web). Surface raw before parsed; wrap consumer callbacks in
  try/swallow so a broken client can't kill the run.

## Selected ADRs (docs/adr/)

- 0001 per-step timeouts; 0003 reuse worktree by default; 0004 AbortSignal on
  run/interactive (not on handles); 0007 worktree O_EXCL PID lock; 0008 inline
  prompts skip processing; 0010 structured output (`Output.object/string`,
  maxIterations===1); 0011 `.resume()` = exactly one iteration; 0012
  provider-owned session storage; 0016 resume requires filesystem-backed sessions
  (SQLite-only stores ship non-resumable); 0017 sandbox-owned sync-base ref; 0018
  fork is session-only; 0019 completion timeout for hanging process; 0020 prompt
  expansion fails fast.
