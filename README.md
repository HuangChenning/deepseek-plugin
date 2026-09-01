# deepseek-plugin

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="deepseek-plugin is a local DSH plugin workspace. Its first read-only flow runs from a browser through DSH Web and the local mes CLI to an implementation-plan list.">
</p>

`deepseek-plugin` is a workspace for independently packaged DSH Web plugins.
Its first plugin, `mes-plan-list`, lets a developer view MES implementation
plans locally by date range and status.

## First plugin: `mes-plan-list`

The plugin serves a page at `/plugins/mes-plan-list` and sends same-origin
queries to its local DSH Web endpoint. It accepts a start date, end date, and
optional status; then it renders a plan table, an empty state, or a concise MES
error. The plugin only permits those inputs and requests the first 200 matching
plans.

## Local setup

After branch integration, the workspace root will be
`/Users/huangcn/deepseek-plugin`. Run these commands from that root.

First, ensure the local MES CLI is authenticated:

```sh
mes auth status
```

Link the plugin to DSH's Web profile once:

```sh
dsh plugin --profile web add "link:$(pwd)/plugins/mes-plan-list"
```

Run the workspace tests, then start DSH Web with the plugin patch:

```sh
pnpm test
dsh web --patch plugins/mes-plan-list/cordis.patch.yml --no-open
```

Open <http://127.0.0.1:3080/plugins/mes-plan-list>. Submitting the form uses
your local MES CLI; this repository does not include or claim a real MES plan
query result.

## Status filter

| Value | MES status |
| --- | --- |
| `0` | Not started (未开始) |
| `1` | In progress (进行中) |
| `2` | Finished (已完成) |
| `3` | Overdue and unfinished (逾期未完成) |

Leave the status field empty to include all statuses.

## Workspace layout

```text
.
├── assets/readme/          # Repository README visuals
├── plugins/
│   └── mes-plan-list/      # Package, patch, source, tests, and usage notes
├── docs/                   # Plugin conventions and design notes
├── CHANGELOG.md
├── package.json
└── pnpm-workspace.yaml
```

Each plugin owns its dependencies, source, tests, patch configuration, and
README. The root package coordinates workspace-wide commands; a shared package
is deferred until two plugins have a stable, tested common need.

## Read-only safety boundary

`mes-plan-list` does not create, update, delete, export, or otherwise modify
MES plans. The host validates the three allowed fields and calls the local
`mes` binary with fixed process arguments—never through a shell—so browser
input cannot supply another CLI flag.

See [CHANGELOG.md](./CHANGELOG.md) for unreleased changes, and
[`plugins/mes-plan-list/README.md`](./plugins/mes-plan-list/README.md) for the
plugin-specific workflow.
