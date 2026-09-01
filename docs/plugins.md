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

Launch the MES plan-list plugin with:

```sh
dsh web --patch plugins/mes-plan-list/cordis.patch.yml --no-open
```

Before using that plugin, confirm the local MES CLI is authenticated:

```sh
mes auth status
```

Link the local package into DSH's Web profile once from the workspace root:

```sh
dsh plugin --profile web add "link:$(pwd)/plugins/mes-plan-list"
```

It is read-only. Its status filter maps `0` to not started, `1` to in progress,
`2` to finished, and `3` to overdue and unfinished. See
[`plugins/mes-plan-list/README.md`](../plugins/mes-plan-list/README.md) for
the complete local workflow.

New plugins should be added under `plugins/*` with their own package metadata,
tests, patch configuration, and usage instructions. Do not add a shared package
until at least two plugins have a stable, tested common need.
