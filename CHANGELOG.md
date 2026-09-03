# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- Plugin settings are a page of their own instead of a panel expanding above
  the plan list. The page has its own URL hash (`#settings`), so a reload stays
  on it and browser back/forward moves between the plan list and the settings
  page. Leaving settings does not reload the page, so query results and any
  cross-page plan selection survive the round trip.

## [0.5.0] - 2026-09-03

### Added

- **Overdue risk email reminders.** Plans that are 已逾期未结束 can be selected
  across pages, grouped by executor, previewed, and — after an explicit
  confirmation — sent a plain-text risk-briefing email. The server re-checks
  every plan's status against MES immediately before sending, so a plan closed
  since the preview is never mailed about. Sending is sequential; one failure
  does not stop the batch, a transient network error is retried once, and
  failed recipients can be retried on their own.
- Executor email addresses are managed in the plugin. The workbook has two
  columns — 执行人姓名 and 邮箱地址 — and the template pre-fills the names found
  in your plan cache, so you only supply addresses. MES's internal executor ID
  never appears in it; the server resolves names back to IDs itself. One person
  holding several MES accounts still receives a single merged email per batch.
  The import shows an added/updated/unchanged preview, and a workbook with any
  bad row writes nothing.
- SMTP settings support SSL/TLS and forced STARTTLS only. The password is kept
  in the macOS Keychain, never on disk; **保存** and **发送测试邮件** are
  separate so a profile can be verified before it is stored.

### Notes

- Mail data lives in a new `~/.dsh/storages/mes-plan-list/mail.db`, separate
  from the plan cache, so **清空缓存** does not delete settings, mappings, or
  history. Send history stores masked addresses and an error code only.
- All mail data is scoped to the MES account that is logged in; switching
  accounts shows a different, isolated set.

### Fixed

- A query whose date range has no work-hour cache now fills that cache
  automatically, so the table shows a total or `0` instead of `—`; cached
  ranges remain fast.
- Importing one executor name that resolves to historical MES account IDs no
  longer produces a false duplicate-name error, and import errors retain their
  Excel row number when one exists.
- Mail previews now stay near the selection controls, render plan types in
  Chinese with date-only end dates, and use compact, consistent text styling.
- The plan table now uses a shared column-width budget within a wider page
  shell, keeping the status column visible on desktop screens while retaining
  container-scoped horizontal scrolling on narrow screens.

## [0.4.0] - 2026-09-02

### Added

- Client-side pagination for query results. Pages default to 20 rows, with
  20 / 30 / 40 / 50 / 100-row options; changing the page never re-queries MES.

### Changed

- Status and check-type selections now refresh results immediately, including
  each group's **全部** action. A separate click on **查询** is no longer needed.
- The executor column is narrower and wraps long name lists, while the contract
  type column has more room.
- Removed the internal numeric status/type mapping table from the root README.

### Notes

- Restart DSH after updating so the running process loads the new page code.
  The cache schema is unchanged and no data rebuild is needed.

## [0.3.0] - 2026-09-02

**Queries returned far fewer plans than they should have.** A window that ought
to list hundreds returned six, and 进行中 plans were missing entirely. If you
drew conclusions from an earlier version, re-check them.

### Fixed

- Plans are matched by **overlap** with the queried window, not by falling
  entirely inside it. MES's own filter is containment-only, so a plan running
  May → August was absent from an August query.
- Containment applied to the end date too, which dropped every 进行中 plan as a
  class — their end dates lie in the future, outside any window ending today.

### Changed

- Syncing fetches **every** plan and replaces the table wholesale, instead of
  fetching the queried range. Widening the sync window by a fixed margin was
  tried first and still missed plans, because spans exceed any margin worth
  paying for. The local database is now a complete copy, so any window and
  filter combination is answered locally and instantly, and deletion detection
  is trivial: whatever MES did not return no longer exists.
- 结束 plans are excluded everywhere, and that filter chip is gone.

### Notes

- The cache schema changed again, so existing caches are dropped on first use.
  The next query runs a full sync — around 80 seconds — and after that any
  window answers from the local copy without another fetch.

## [0.2.0] - 2026-09-02

### Added

- Work hours per plan for the queried window, fetched as part of
  **同步最新数据**. The link is the work record's `rid`, which is the plan id;
  the `planId` field on the same record is always null and is unrelated.
- Multi-select status and check type, plus an **全部** chip per group that
  clears it. MES cannot combine values itself, so the filtering runs locally
  against the cache, which holds the whole window.
- **最近 7 / 30 / 90 天** date presets; typing dates still works.
- Chinese README (`README.zh-CN.md`), cross-linked with the English one.

### Changed

- Columns are now 计划ID / 计划标题 / 合同名称 / 合同类型 / 执行人 /
  报工工时(h) / 计划开始 / 计划结束 / 进行状态, with start and end split apart.
- The settings panel shows the release version (`git describe`) instead of a
  bare commit hash, marking how far past a release the checkout is.
- Work-record volume is described qualitatively rather than with real counts.

### Fixed

- `execFile`'s default 1 MiB `maxBuffer` truncated a page of work records and
  surfaced as a bare "命令执行失败"; raised to 64 MiB. The plan query had the
  same latent trap.
- Work-record paging is retried with backoff — the statistics endpoint fails
  intermittently, so a multi-page load rarely completed without it.

### Notes

- The cache schema changed, so existing caches are dropped and rebuilt on first
  use. Plans re-sync in seconds; work hours need one sync to reappear.

## [0.1.0] - 2026-09-02

First tagged version. The plugin is installed from this repository with
`pnpm register` and updated in place from its settings panel; it is not
published to npm or the DSH plugin market.

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

- Plan counts were inflated: MES repeats a few records across page boundaries,
  so results are now de-duplicated by id.
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

[0.1.0]: https://github.com/HuangChenning/deepseek-plugin/releases/tag/v0.1.0
[0.2.0]: https://github.com/HuangChenning/deepseek-plugin/releases/tag/v0.2.0
[0.3.0]: https://github.com/HuangChenning/deepseek-plugin/releases/tag/v0.3.0
[0.4.0]: https://github.com/HuangChenning/deepseek-plugin/releases/tag/v0.4.0
[0.5.0]: https://github.com/HuangChenning/deepseek-plugin/releases/tag/v0.5.0
