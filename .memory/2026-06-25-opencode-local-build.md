# Building opencode locally (verified)

- date: 2026-06-25
- source: ran end-to-end on this machine (`~/Documents/GitHub/opencode`, branch `dev`)
- status: verified working

## Requirements

- **Bun 1.3+** (repo pins `bun@1.3.14` via `packageManager`). Had 1.2.15;
  upgraded with `bun upgrade` → 1.3.14. Old bun would break install/runtime.
- Node 22.x present (v22.15.1) but bun is the primary runtime.

## Steps (from repo root)

```bash
bun upgrade            # only if < 1.3.x
bun install            # ~4618 packages; runs postinstall fix-node-pty + husky
bun dev --version      # prints "local" → CLI boots
bun dev --help         # full yargs command tree
```

Dependencies were missing initially (no `node_modules`) because an earlier disk
cleanup removed them; `bun install` restores everything.

## Run modes

```bash
bun dev                 # TUI in the opencode repo itself
bun dev <directory>     # TUI against another project
bun dev serve           # headless API server (default port 4096)
bun dev serve --port N
bun dev web             # server + open web interface
bun dev run "message"   # one-shot run
```

## Verified smoke test

`bun dev serve --port 4096` → logs `opencode server listening on
http://127.0.0.1:4096`; `curl /` returns HTTP 200 serving the web UI HTML.
Shuts down cleanly with `pkill -f "src/index.ts serve"`.

## Notes

- Logs `OPENCODE_SERVER_PASSWORD is not set; server is unsecured` — fine for
  local; set the env var if exposing it.
- Need provider credentials for real runs: `bun dev auth` (alias of
  `providers`).
- `bun dev` is the dev-equivalent of the built `opencode` binary (same CLI).
- Standalone binary (not built this session):
  `./packages/opencode/script/build.ts --single` →
  `./packages/opencode/dist/opencode-<platform>/bin/opencode`.
