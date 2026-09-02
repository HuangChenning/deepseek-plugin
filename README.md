# deepseek-plugin

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="deepseek-plugin is a local DSH plugin workspace. Its first read-only flow runs from a browser through DSH Web and the local mes CLI to an implementation-plan list.">
</p>

`deepseek-plugin` is a workspace for independently packaged DSH Web plugins.
Its first plugin, `mes-plan-list`, shows MES implementation plans by date range
and status, entirely through the `mes` CLI already installed on your machine.

## First plugin: `mes-plan-list`

The plugin adds an **实施计划** entry to the DSH Web sidebar and serves a page at
`/plugins/mes-plan-list` that sends same-origin queries to its local DSH Web
endpoint. It accepts a start date, end date, and optional status; then it
renders a plan table, an empty state, or a concise MES error. The plugin only
permits those inputs, and returns every matching plan by paging through the
MES CLI.

## Local setup

### Prerequisites

- **Node 24 or newer.** The plugin's cache uses the built-in `node:sqlite`
  module, which older releases do not have. Development and CI both run 24.
- **pnpm**, for `pnpm register` and the tests.
- **DSH** with a `web` profile — run `dsh --profile web` once if you have never
  started it, so the profile exists.
- **The `mes` CLI**, authenticated. Check with `mes auth status`; the plugin
  shows a banner and refuses to return data when it is not logged in.

### Install

```sh
git clone https://github.com/HuangChenning/deepseek-plugin.git
cd deepseek-plugin
pnpm register
```

This writes the profile's dependency entry, its `dsh.profile.bundles` entry —
which is what makes DSH load the plugin at all — and the `node_modules`
symlink. It is idempotent, and it avoids `dsh plugin add`'s full-profile pnpm
install, which fails whenever any unrelated package in the profile trips a
supply-chain policy.

Run the workspace tests, then start DSH Web:

```sh
pnpm test
dsh --profile web --no-open
```

Open <http://127.0.0.1:3080> and click **实施计划** in the sidebar. Submitting
the form uses your local MES CLI; this repository does not include or claim a
real MES plan query result.

### Updating

Use **设置 → 插件版本 → 检查更新** on the plugin page, which runs
`git pull --ff-only` in this clone. Equivalently, from a terminal:

```sh
git pull --ff-only
```

Either way, **restart DSH** afterwards so it loads the new code. The plugin is
not published to npm or the DSH plugin market; this repository is the only
source.

### Local data

Query results are cached in a per-machine SQLite database at
`~/.dsh/storages/mes-plan-list/plans.db`, created on your first query. It never
leaves your machine and is not part of this repository. The plugin's settings
panel shows what it covers and can clear it.

## Status filter

| Value | MES status |
| --- | --- |
| `0` | Not started (未开始) |
| `1` | In progress (进行中) |
| `2` | Finished (结束) |
| `3` | Overdue and unfinished (已逾期未结束) |

Leave the status field empty to include all statuses.

## Workspace layout

```text
.
├── assets/readme/          # Repository README visuals
├── plugins/
│   └── mes-plan-list/      # Package, patch, source, tests, and usage notes
├── scripts/                # Profile registration
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

See [CHANGELOG.md](./CHANGELOG.md) for the release history, and
[`plugins/mes-plan-list/README.md`](./plugins/mes-plan-list/README.md) for the
plugin-specific workflow — settings, login state, CLI updates, and how the
cache decides what to re-fetch.
