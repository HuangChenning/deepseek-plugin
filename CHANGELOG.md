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
- Plugin self-update from the settings panel: shows the checked-out branch and
  commit, checks the remote on demand, and updates with `git pull --ff-only`.
  Works with a private repository without the plugin handling credentials.
- Settings panel for the `mes` binary path, stored host-side. A submitted path
  is verified with `<path> --version` before it is stored, so an arbitrary
  executable cannot be configured as `mes`.
- Login-state banner: the page reads `mes auth status` on load and names the
  command to run when the CLI is not logged in.
- mes CLI version panel: shows the installed version, checks for updates on
  demand, and runs `mes update`. The check contacts the update server only
  when the user asks for it; opening the page stays local. Queries are refused
  while the binary is being replaced.
- Workspace CI running the tests and a whitespace check.

- Per-machine SQLite cache (`node:sqlite`, created lazily on the first query)
  with a manual **同步最新数据** action, a visible sync time, and a prompt once
  the data is over a day old. A sync widens its window to cover everything
  already cached, so deleted plans cannot linger anywhere in the cache;
  **清空缓存** resets that span.

### Fixed

- Plan counts were inflated: MES repeats a few records across page boundaries
  (5 duplicate ids in a 958-row year), so results are now de-duplicated by id.
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
