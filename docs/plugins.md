# DSH Web plugins

This workspace contains independently installable DSH Web plugins. Each plugin
keeps its source, tests, patch configuration, and README in its own package.
Plugins must document their prerequisites and whether they can mutate external
systems.

## Development

Run all workspace tests with:

```sh
pnpm test
```

Launch DSH Web with the installed plugins:

```sh
dsh --profile web --no-open
```

Before using that plugin, confirm the local MES CLI is authenticated:

```sh
mes auth status
```

Link the local package into DSH's Web profile once from the workspace root:

```sh
dsh plugin --profile web add "link:$(pwd)/plugins/mes-plan-list"
```

A plugin is only loaded once its package name reaches the profile's
`dsh.profile.bundles` list. `dsh plugin add` appends it when `package.json`
declares `dsh.bundle.patch`; a package without that field installs as a
dependency and is then silently never loaded. A plugin that also needs a
browser half declares `dsh.client` and exports `./client`, and that bundle must
self-register via `window.__ModuleLoader__.load` rather than export ES modules.

`mes-plan-list` is read-only. Its status filter maps `0` to not started, `1` to
in progress, `2` to finished (结束), and `3` to overdue and unfinished
(已逾期未结束). See
[`plugins/mes-plan-list/README.md`](../plugins/mes-plan-list/README.md) for
the complete local workflow.

New plugins should be added under `plugins/*` with their own package metadata,
tests, patch configuration, and usage instructions. Do not add a shared package
until at least two plugins have a stable, tested common need.
