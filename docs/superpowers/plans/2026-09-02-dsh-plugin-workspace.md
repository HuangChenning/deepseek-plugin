# DSH Plugin Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a pnpm DSH-plugin workspace and its first read-only MES implementation-plan list Web plugin.

**Architecture:** The root manages independent plugin packages. `plugins/mes-plan-list` supplies a Cordis host plugin that serves a same-origin HTML page and JSON query endpoint; the host validates three fields and invokes `mes` with fixed argument positions via `execFile`.

**Tech Stack:** Node.js ESM, `node:test`, pnpm workspaces, Cordis/DSH Web, local `mes` CLI.

**Spec:** `docs/superpowers/specs/2026-09-02-dsh-plugin-workspace-design.md`

## Global Constraints

- Every plugin is a separate workspace package with its own dependencies, source, tests, patch configuration, and README.
- Do not create a shared package until two plugins have a stable, tested common need.
- The plugin only accepts `startDate`, `endDate`, and `status`; status is empty or `0` through `3`.
- Invoke `mes` without a shell and always append `--page 1 --page-size 200`.
- Tests must not call MES or access production data.
- Commit each completed task only after its stated verification passes; do not stage the pre-existing untracked `.DS_Store`.

---

## File Structure

- `package.json`: root workspace scripts.
- `pnpm-workspace.yaml`: declares `plugins/*` packages.
- `CHANGELOG.md`: records unreleased user-visible changes.
- `docs/plugins.md`: contributor conventions and commands.
- `plugins/mes-plan-list/package.json`: ESM package metadata and test script.
- `plugins/mes-plan-list/cordis.patch.yml`: inserts the source plugin into a DSH profile overlay.
- `plugins/mes-plan-list/src/plan-query.js`: validates query input, builds fixed MES arguments, runs the CLI, and normalizes list results.
- `plugins/mes-plan-list/src/index.js`: registers the page and query HTTP routes with `webServer`.
- `plugins/mes-plan-list/src/page.js`: returns the static browser UI.
- `plugins/mes-plan-list/test/plan-query.test.js`: pure validation, command, response, and CLI-failure tests.
- `plugins/mes-plan-list/README.md`: installation, testing, and DSH launch instructions.

### Task 1: Establish the workspace contract

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `docs/plugins.md`
- Create: `plugins/mes-plan-list/package.json`
- Create: `plugins/mes-plan-list/cordis.patch.yml`

**Produces:** `pnpm test` delegates to `pnpm --recursive test`; `mes-plan-list` is an ESM package loadable from its patch file.

- [ ] **Step 1: Create the root workspace test command and package declaration.**

```json
{
  "name": "deepseek-plugin-workspace",
  "private": true,
  "packageManager": "pnpm@10.0.0",
  "scripts": { "test": "pnpm --recursive test" }
}
```

- [ ] **Step 2: Declare `plugins/*` as the sole workspace package glob.**

```yaml
packages:
  - 'plugins/*'
```

- [ ] **Step 3: Add the first package and patch entry.**

```yaml
- insert:
    - id: mes-plan-list
      name: ./src/index.js
```

- [ ] **Step 4: Add `docs/plugins.md` with exact `pnpm test` and `dsh web --patch plugins/mes-plan-list/cordis.patch.yml --no-open` commands.**

- [ ] **Step 5: Check the workspace definition.**

Run: `pnpm --recursive list --depth -1`

Expected: lists `mes-plan-list` with no external dependencies installed.

- [ ] **Step 6: Commit the workspace contract.**

```bash
git add package.json pnpm-workspace.yaml docs/plugins.md plugins/mes-plan-list/package.json plugins/mes-plan-list/cordis.patch.yml
git commit -m "chore: add DSH plugin workspace"
```

### Task 2: Implement and test safe MES query execution

**Files:**
- Create: `plugins/mes-plan-list/test/plan-query.test.js`
- Create: `plugins/mes-plan-list/src/plan-query.js`

**Consumes:** no production modules.

**Produces:** `buildPlanListArgs(input)` and `queryPlans(input, run)`.

- [ ] **Step 1: Write failing tests for valid command construction, all-status omission, reverse date rejection, invalid status rejection, empty `list`, and non-zero runner failure.**

```js
assert.deepEqual(buildPlanListArgs({ startDate: '2026-09-01', endDate: '2026-09-30', status: '3' }), [
  '-o', 'json', 'plan', 'list', '--start-date', '2026-09-01', '--end-date', '2026-09-30', '--status', '3', '--page', '1', '--page-size', '200',
])
```

- [ ] **Step 2: Run the test file and verify it fails because `plan-query.js` does not exist.**

Run: `pnpm --filter mes-plan-list test -- test/plan-query.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/plan-query.js`.

- [ ] **Step 3: Implement the minimal query module.**

```js
export function buildPlanListArgs({ startDate, endDate, status = '' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? '')) throw new Error('开始日期不能为空或格式错误')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate ?? '')) throw new Error('结束日期不能为空或格式错误')
  if (startDate > endDate) throw new Error('开始日期不能晚于结束日期')
  if (status !== '' && !['0', '1', '2', '3'].includes(status)) throw new Error('状态值无效')
  return ['-o', 'json', 'plan', 'list', '--start-date', startDate, '--end-date', endDate, ...(status === '' ? [] : ['--status', status]), '--page', '1', '--page-size', '200']
}

export async function queryPlans(input, run = runMes) {
  const output = await run(buildPlanListArgs(input))
  try {
    const payload = JSON.parse(output)
    return Array.isArray(payload.list) ? payload.list : []
  } catch {
    throw new Error('MES 返回的数据不是有效 JSON')
  }
}
```

`runMes` uses `execFile('mes', args, { encoding: 'utf8' })`, never `exec` or shell interpolation. It converts non-zero exits and invalid JSON to `Error` values with Chinese messages.

- [ ] **Step 4: Run the test file and verify it passes.**

Run: `pnpm --filter mes-plan-list test -- test/plan-query.test.js`

Expected: PASS; no command invokes MES.

- [ ] **Step 5: Commit the safe MES query module.**

```bash
git add plugins/mes-plan-list/src/plan-query.js plugins/mes-plan-list/test/plan-query.test.js
git commit -m "feat: add MES plan query module"
```

### Task 3: Add the Web routes and browser page

**Files:**
- Create: `plugins/mes-plan-list/src/index.js`
- Create: `plugins/mes-plan-list/src/page.js`
- Modify: `plugins/mes-plan-list/test/plan-query.test.js`

**Consumes:** `queryPlans(input, run)` from `src/plan-query.js`.

**Produces:** a Cordis plugin with `inject = ['webServer']`, the page route, and the query route.

- [ ] **Step 1: Write failing route-level tests for invalid POST body producing HTTP 400 and a query runner failure producing HTTP 502.**

```js
assert.equal(response.statusCode, 400)
assert.deepEqual(JSON.parse(response.body), { ok: false, error: '开始日期不能为空' })
```

- [ ] **Step 2: Run the tests and verify they fail because route registration is absent.**

Run: `pnpm --filter mes-plan-list test`

Expected: FAIL with missing route factory export.

- [ ] **Step 3: Implement routes and page.**

```js
export const inject = ['webServer']
export function apply(ctx) {
  ctx.webServer.register({ kind: 'exact', path: '/plugins/mes-plan-list', handler: handlePage })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/query', handler: handleQuery })
}
```

The exact page route is `GET /plugins/mes-plan-list`; the exact API route is `POST /api/plugins/mes-plan-list/query`. Parse only a JSON body up to 16 KiB, reject other methods/content types, return `{ ok: true, plans }` on success, and never include a stack trace in an error response. The browser page uses `fetch()` to submit its three form values and renders an empty-state message or a table from returned plans.

- [ ] **Step 4: Run plugin tests.**

Run: `pnpm --filter mes-plan-list test`

Expected: PASS, including safe validation and failure behavior.

- [ ] **Step 5: Commit the Web interface.**

```bash
git add plugins/mes-plan-list/src/index.js plugins/mes-plan-list/src/page.js plugins/mes-plan-list/test/plan-query.test.js
git commit -m "feat: add MES plan list web page"
```

### Task 4: Document and verify the complete plugin

**Files:**
- Create: `plugins/mes-plan-list/README.md`
- Modify: `docs/plugins.md`

**Consumes:** the completed package layout and routes.

**Produces:** reproducible local setup and launch instructions.

- [ ] **Step 1: Document prerequisites and commands.**

The README must state that `mes auth status` must succeed first, then show `pnpm test` and `dsh web --patch plugins/mes-plan-list/cordis.patch.yml --no-open`. It must also list the four status mappings and declare that the plugin is read-only.

- [ ] **Step 2: Run all workspace tests.**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 3: Check DSH composition without starting a server.**

Run: `dsh web --patch plugins/mes-plan-list/cordis.patch.yml --dump-config`

Expected: the composed tree contains the `mes-plan-list` loader entry and exits successfully.

- [ ] **Step 4: Start the Web profile manually and exercise the page.**

Run: `dsh web --patch plugins/mes-plan-list/cordis.patch.yml --no-open`

Expected: the plugin loads without a module-type or module-resolution warning; opening `http://127.0.0.1:3080/plugins/mes-plan-list` permits a query and displays a result, empty state, or concise MES error.

- [ ] **Step 5: Commit documentation and the implementation plan.**

```bash
git add docs/superpowers/specs/2026-09-02-dsh-plugin-workspace-design.md docs/superpowers/plans/2026-09-02-dsh-plugin-workspace.md docs/plugins.md plugins/mes-plan-list/README.md
git commit -m "docs: document MES plan list plugin"
```

### Task 5: Add the project changelog

**Files:**
- Create: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-09-02-dsh-plugin-workspace-design.md`
- Modify: `docs/superpowers/plans/2026-09-02-dsh-plugin-workspace.md`

**Produces:** a release-neutral record of the workspace and initial read-only MES plan-list plugin.

- [ ] **Step 1: Create a Keep a Changelog document with an unreleased section.**

```markdown
# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- pnpm workspace for independently installable DSH plugins.
- Read-only MES implementation-plan list Web plugin.
```

- [ ] **Step 2: Verify the document only records delivered behavior.**

Run: `rg -n "Unreleased|pnpm workspace|MES implementation-plan" CHANGELOG.md`

Expected: all three strings appear and no version/date is invented.

- [ ] **Step 3: Commit the changelog and its approved design/plan update.**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-09-02-dsh-plugin-workspace-design.md docs/superpowers/plans/2026-09-02-dsh-plugin-workspace.md
git commit -m "docs: add project changelog"
```

### Task 6: Redesign the repository README

**Files:**
- Create: `assets/readme/hero.svg`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-02-dsh-plugin-workspace-design.md`
- Modify: `docs/superpowers/plans/2026-09-02-dsh-plugin-workspace.md`

**Produces:** a concise GitHub homepage with a project-native, static SVG hero and accurate setup documentation.

- [ ] **Step 1: Create `assets/readme/hero.svg` as a 1200-unit-wide, static SVG.**

It must contain a title and description, use only system fonts and local SVG primitives, and show the verified flow `Browser → DSH Web → local mes CLI → plan list`. Essential labels must be at least 20 SVG units; no animation, generated imagery, remote resources, or commands inside the image.

- [ ] **Step 2: Replace the one-line root README with the approved reading order.**

Include the hero with meaningful alt text, then value, `mes-plan-list` capabilities, one-time profile link setup, the patched 3080 launch command, the four MES status mappings, workspace layout, read-only safety boundary, and a link to `CHANGELOG.md`. Do not claim a real MES plan query was executed.

- [ ] **Step 3: Render and inspect the SVG.**

Run: `sips -s format png assets/readme/hero.svg --out /tmp/mes-plan-list-hero.png`

Expected: a readable PNG with no clipped text at 1200 units; also inspect a 360-pixel-wide rendition or confirm required detail remains available in adjacent Markdown.

- [ ] **Step 4: Audit and commit the README.**

Run: `python3 /Users/huangcn/.axon/repo/skills/beautify-github-readme/scripts/audit_readme.py README.md`

Expected: the audit completes without errors.

```bash
git add README.md assets/readme/hero.svg docs/superpowers/specs/2026-09-02-dsh-plugin-workspace-design.md docs/superpowers/plans/2026-09-02-dsh-plugin-workspace.md
git commit -m "docs: redesign repository README"
```
