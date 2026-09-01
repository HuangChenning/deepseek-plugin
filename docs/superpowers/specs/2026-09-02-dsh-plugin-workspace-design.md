# DSH Plugin Workspace Design

## Purpose

This workspace hosts independently installable DSH Web plugins. The first plugin, `mes-plan-list`, shows implementation plans returned by the local `mes` CLI for a selected date range and status.

## Workspace layout

```text
.
├── package.json
├── pnpm-workspace.yaml
├── plugins/
│   └── mes-plan-list/
│       ├── package.json
│       ├── cordis.patch.yml
│       ├── src/
│       ├── test/
│       └── README.md
└── docs/
    └── plugins.md
```

Each plugin is a separate workspace package with its own runtime dependencies, source, tests, patch configuration, and usage instructions. The root package coordinates workspace-wide commands only. A shared package is not created until at least two plugins have a stable, tested common need.

## MES implementation-plan list plugin

The plugin serves a Web page at `/plugins/mes-plan-list` and exposes a same-origin query endpoint at `POST /api/plugins/mes-plan-list/query`.

The request body has three fields:

- `startDate`: required `YYYY-MM-DD` start date.
- `endDate`: required `YYYY-MM-DD` end date that is not earlier than `startDate`.
- `status`: an empty string for all statuses, or one of `0`, `1`, `2`, `3`.

Status values map to MES CLI values as follows:

| Value | Meaning |
| --- | --- |
| `0` | Not started |
| `1` | In progress |
| `2` | Finished |
| `3` | Overdue and unfinished |

The host validates the input, then invokes the local binary without a shell:

```text
mes -o json plan list --start-date <startDate> --end-date <endDate> [--status <status>] --page 1 --page-size 200
```

Using direct process arguments prevents browser input from becoming executable shell syntax. The page cannot supply any other CLI flag. A successful JSON response is rendered as a plan table; no rows render an empty state. Invalid requests, non-zero CLI exits, and invalid CLI JSON produce a concise Chinese error without a stack trace.

The first version is read-only and deliberately excludes plan mutations, exports, pagination, and additional filters.

## Testing and development conventions

Each plugin has isolated tests for input validation, CLI argument construction, empty results, and CLI failure. Tests use fixtures or injected process runners and never query MES production data automatically.

The root `pnpm test` command runs all workspace tests; `pnpm --filter <package> test` runs one plugin. Each plugin README records prerequisites, dependency installation, testing, and the `dsh web --patch` invocation. `docs/plugins.md` records the shared conventions and minimal new-plugin workflow.

## Verification criteria

The first implementation is ready when all workspace tests pass and `dsh web --patch plugins/mes-plan-list/cordis.patch.yml` loads the plugin without module-resolution warnings. A manually opened page can submit a valid query and display either MES results, the empty state, or a friendly CLI error.
