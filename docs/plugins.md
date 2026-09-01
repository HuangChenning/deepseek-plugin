# DSH Web plugins

This workspace contains independently installable DSH Web plugins. Each plugin
keeps its source, tests, patch configuration, and README in its own package.

## Development

Run all workspace tests with:

```sh
pnpm test
```

Launch the MES plan-list plugin with:

```sh
dsh web --patch plugins/mes-plan-list/cordis.patch.yml --no-open
```

New plugins should be added under `plugins/*` with their own package metadata,
tests, patch configuration, and usage instructions. Do not add a shared package
until at least two plugins have a stable, tested common need.
