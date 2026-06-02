# arche

A Turborepo monorepo skeleton managed with [Bun](https://bun.sh) workspaces.

## Structure

```
arche/
├── apps/
│   └── web/          # example application
├── packages/
│   └── utils/        # example shared package (@repo/utils)
├── turbo.json        # Turborepo pipeline config
├── tsconfig.base.json
└── package.json      # workspaces + root scripts
```

## Getting started

```bash
bun install
```

## Scripts

Run from the repo root; Turborepo orchestrates tasks across all workspaces.

| Command               | Description                           |
| --------------------- | ------------------------------------- |
| `bun run build`       | Build every package and app           |
| `bun run dev`         | Run all `dev` tasks in watch mode     |
| `bun run lint`        | Lint every workspace                  |
| `bun run check-types` | Type-check every workspace            |
| `bun run clean`       | Remove build artifacts + node_modules |

## Adding a workspace

Create a new folder under `apps/` or `packages/` with its own `package.json`.
Reference internal packages with the workspace protocol, e.g.:

```json
{
  "dependencies": {
    "@repo/utils": "workspace:*"
  }
}
```
