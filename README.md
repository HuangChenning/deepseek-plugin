# deepseek-plugin

English | [简体中文](./README.zh-CN.md)

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="deepseek-plugin is a local DSH plugin workspace. Its first read-only flow runs from a browser through DSH Web and the local mes CLI to an implementation-plan list.">
</p>

`deepseek-plugin` is a workspace for independently packaged DSH Web plugins.
Its first plugin, `mes-plan-list`, shows MES implementation plans by date range
and status, entirely through the `mes` CLI already installed on your machine.

## First plugin: `mes-plan-list`

The plugin adds an **实施计划** entry to the DSH Web sidebar and serves a page at
`/plugins/mes-plan-list` that sends same-origin queries to its local DSH Web
endpoint. It takes a date range — typed in, or set with the 最近 7/30/90 天
presets — plus any combination of statuses and check types, and lists plan id,
title, customer, check type, executors, hours logged in that window, start and
end dates, and status.

Results come from a local cache, so a repeat query is instant; **同步最新数据**
re-fetches from MES. Every matching plan is returned — the host pages through
the CLI rather than truncating.

Plans that are **overdue and unfinished** can additionally be grouped by
executor and sent a plain-text risk-briefing email, after an explicit preview
and confirmation. Nothing is ever sent in the background. See the
[plugin README](./plugins/mes-plan-list/README.md#overdue-risk-email-reminders)
for the SMTP, Keychain, and mapping setup.

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
pnpm install
pnpm register
```

Run both from the repository root. This is a pnpm workspace, so `pnpm install`
there is what installs the plugin's own dependencies; running it inside
`plugins/mes-plan-list` does not.

`pnpm register` does not install anything. Skip `pnpm install` and DSH fails to
boot with `Cannot find package 'exceljs'`, because the plugin's modules import
their dependencies at load time.

`pnpm register` writes the profile's dependency entry, its
`dsh.profile.bundles` entry — which is what makes DSH load the plugin at all —
and the `node_modules` symlink. It is idempotent, and it avoids `dsh plugin
add`'s full-profile pnpm install, which fails whenever any unrelated package in
the profile trips a supply-chain policy.

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

Email reminder data — SMTP settings, executor address mappings, and send
history — lives in a **separate** database at
`~/.dsh/storages/mes-plan-list/mail.db`, so clearing the plan cache never takes
it with it. The SMTP password is stored only in the macOS Keychain. Neither is
part of this repository.

Hours are fetched only for the queried date range. **同步最新数据 forces a
work-hour refresh, which is why it is slow.** Work-hour records outnumber plans
by roughly an order of magnitude, so a month takes about a minute. If a plain
query has no cached hours for its date range, the plugin fetches that range once
and caches it; repeat queries read the cache. The table therefore shows an
actual total or `0`, rather than `—`.

## Filters

Finished plans (`2`) are always excluded and have no filter option.

A plan is listed when its dates **overlap** the window, not only when it falls
entirely inside it — MES's own filter is containment-only, which would hide a
plan running from May to August from an August query, and would drop 进行中
plans entirely because their end dates lie in the future.

Syncing therefore fetches **every** plan, not the queried range, and the local
database is a complete copy. Any window and filter combination is then answered
locally and instantly, with no "is the cache wide enough" question to get wrong.

MES itself cannot combine values — `--status 2,3` returns nothing and
`--check-type` takes a single int — so the filtering happens locally against
the cache, which holds the whole window.

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
MES plans. The host validates the allowed fields and calls the local `mes`
binary with fixed process arguments—never through a shell—so browser input
cannot supply another CLI flag.

The email reminder is the one feature that sends data off your machine, and it
stays inside that boundary: it reads plans, it never writes them back, and it
never closes a plan or reads a mailbox. Every send requires a preview and an
explicit confirmation, and the server re-checks each plan's status against MES
immediately before the first message leaves.

See [CHANGELOG.md](./CHANGELOG.md) for the release history, and
[`plugins/mes-plan-list/README.md`](./plugins/mes-plan-list/README.md) for the
plugin-specific workflow — settings, login state, CLI updates, and how the
cache decides what to re-fetch.
