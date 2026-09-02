# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- pnpm workspace for independently installable DSH plugins.
- Read-only MES implementation-plan list Web plugin.
- Browser half (`dsh.client`) that adds an **实施计划** sidebar entry to DSH Web
  and opens the plugin page over the center column.
- `pnpm register`, which registers every workspace plugin with a DSH profile
  without `dsh plugin add`'s full-profile pnpm install.
- Workspace CI running the tests and a whitespace check.

### Fixed

- Plugin was never loaded by DSH: `package.json` declared no `dsh.bundle.patch`,
  so `dsh plugin add` installed it as a dependency without registering it in the
  profile bundle list, and both routes returned 404.
- Status labels now match what MES returns (`结束`, `已逾期未结束`).
- Documented `dsh --profile web`; the previously documented `dsh web --patch`
  invocation does not exist.

### Changed

- Redesigned the plugin page: filter card, status badges, contract subtitles,
  executor column, empty/error states, and light/dark themes synced from the
  DSH shell.
- Queries now return every matching plan; the host pages through the MES CLI
  instead of capping the result at the first 200 rows.
