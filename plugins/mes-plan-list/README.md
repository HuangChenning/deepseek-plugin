# MES implementation-plan list

This DSH Web plugin lists MES implementation plans for a selected date range
and status. It is read-only: it does not create, update, delete, export, or
otherwise change MES plans.

## Prerequisites

Authenticate the local MES CLI before using the plugin. This command must
succeed:

```sh
mes auth status
```

The workspace uses pnpm and DSH. Run the following commands from the workspace
root.

Register this local package with the DSH Web profile once before launching it:

```sh
pnpm register
```

DSH only loads a plugin whose package name is in the profile's
`dsh.profile.bundles` list; without that entry the sidebar entry is missing and
both routes return 404. `dsh plugin add` normally writes it, but it also runs a
pnpm install that re-verifies the whole profile lockfile, so one unrelated
package failing a supply-chain policy blocks the registration too. `pnpm
register` writes the dependency, the bundle entry, and the `node_modules`
symlink directly, so it is unaffected. It is idempotent and takes an optional
profile name (`pnpm register -- other-profile`).

## Test

```sh
pnpm test
```

The tests use injected runners and do not query MES production data.

## Run locally

```sh
dsh --profile web --no-open
```

Open <http://127.0.0.1:3080> and click **实施计划** in the sidebar, or open
<http://127.0.0.1:3080/plugins/mes-plan-list> directly. Select a start date and
end date, optionally select a status, and submit the form. A query displays a
plan table, an empty state, or a concise MES error.

## Local cache

Results are cached in a per-machine SQLite database at
`~/.dsh/storages/mes-plan-list/plans.db` (Node's built-in `node:sqlite`, no
dependency). The file is **created lazily**: a machine that has never run a
query has no database. It is local only — never committed, never synced between
machines.

Queries read the cache when a previously synced window covers them, and fall
back to MES otherwise, storing what they fetch. The first query on a machine
therefore behaves exactly like the uncached version — no "sync first" step.
**同步最新数据** re-fetches the current date range and stores it.

The page always shows how current the data is, and says
`已超过 1 天，请及时更新数据` once the sync is older than a day.

### Why the window logic is safe

MES's `--start-date X --end-date Y` is **containment**, not overlap: it returns
only plans with `startDate >= X` and `endDate <= Y`, and it reads both bounds as
midnight — a plan ending `2026-07-31 18:00:00` is outside a window ending
`2026-07-31`. Verified against the live CLI.

That gives window monotonicity: if W1 fits inside W2, `result(W1) ⊆ result(W2)`.
So a wide synced window can serve any narrower query exactly, by re-applying the
same two comparisons locally — the rule is simple enough to reproduce without
guessing at server behaviour. Status filtering is likewise local; syncing always
fetches **all** statuses, because a status-filtered response is not the full
window and would make the cleanup below delete live rows.

### Deletions

MES does not announce deletions, so after syncing window W the store drops rows
inside W that W's response did not contain — precise, because that response is
W's complete set.

A narrow sync would only clean ghosts inside its own window, so **a sync widens
its window to cover everything already cached**: the union of the requested
range and every previously synced window. Ghost rows therefore cannot accumulate
anywhere in the cache, and there is no "incremental vs full" decision to get
wrong — correctness is automatic, and the cost of a wide sync is only paid once
the cache actually spans a wide range. **清空缓存** resets that span.

## Updating the plugin

The settings panel shows the checked-out branch and commit, checks the remote
for newer commits on click, and can update in place.

Updating runs `git pull --ff-only` in the local repository. This works with a
**private** repository without the plugin handling any credentials: whoever runs
it already has access, and git uses their existing credentials. That is why this
does not go through dshmarket or npm, both of which need a publicly installable
source.

The browser cannot influence what gets pulled — remote, branch, and ref are
never taken from the request; it is always the current branch. A dirty working
tree is refused rather than overwritten, and `--ff-only` means a diverged branch
fails loudly instead of auto-merging into a state nobody reviewed.

**Restart DSH after updating** for the new code to load. If a future version
adds a runtime dependency, run `pnpm install` too.

## Settings

The absolute path to the `mes` binary is stored in
`~/.dsh/storages/mes-plan-list/config.json`. Leave it empty to use `mes` from
PATH. Setting it fixes the case where a DSH started from a GUI or launchd
cannot resolve `mes`. The plugin page no longer edits the path, so that it has
a single source of truth once it moves into DSH's own plugin configuration.

The path decides which binary the host executes, so a submitted value is only
stored after it passes all of: absolute path, no control characters, and a
`<path> --version` that prints `mes version <semver>`. Checking the path shape
alone would let any program be configured as `mes`.

Config lives at `~/.dsh/storages/mes-plan-list/config.json`. A corrupt file
falls back to PATH rather than breaking the plugin.

## Login state

The page checks `mes -o json auth status` on load and shows a banner when the
CLI is not logged in, naming the `mes auth login` command to run. The plugin
never handles credentials itself. A logged-out CLI can exit non-zero while
still printing its JSON, so that is read as "logged out", not as a failure.

## mes CLI version

The settings panel shows the CLI version, checks for updates, and can run
`mes update`. `mes update --check` **ignores `-o json`** — its output is text
only — so the plugin does not parse it into a decision beyond one deliberately
loose test: output matching `up to date` means current, anything else is
treated as "possibly out of date" and the raw output is shown next to an
update button. That failure direction is intentional: if MES changes the
wording, the user sees one extra button, rather than being told they are
current when they are not.

**The update check runs only when the user clicks 检查更新.** Opening the page
reads the installed version with `mes --version`, which is local; nothing
contacts the update server unprompted. `GET …/cli` returns the version alone,
and only `GET …/cli?check=1` runs the check.

`mes update` replaces the binary in use, so queries are refused with 503 while
one is running and a second update is refused with 409.

## Two halves

`package.json` declares `dsh.client`, so DSH serves the browser half at
`/plugins/mes-plan-list/client.js`. That half injects the sidebar entry and
hosts the page in an iframe over the center column; DSH exposes no sidebar slot
to external plugins, so the entry row is plain DOM re-inserted by a
`MutationObserver` after shell re-renders. The host half owns the page and the
query endpoint. The client bundle self-registers through
`window.__ModuleLoader__.load` — DSH rejects a plain ES module.

## Overdue risk email reminders

Plans that are **overdue and unfinished** (status `3`) can be grouped by
executor and sent a plain-text risk-briefing email. This is the one part of the
plugin that leaves your machine, so it is gated behind an explicit preview and
confirmation: nothing is ever sent in the background, and the plugin never
closes a plan or reads a mailbox.

### Prerequisites

- macOS. The SMTP password is stored in the login Keychain via the `security`
  CLI; there is no other password store and none is written to disk by the
  plugin.
- An SMTP account that issues a client-specific password (an app password).
  Your normal login password will usually be rejected by the provider.

### SMTP security modes

Only two modes exist, and neither can fall back to plaintext:

| Mode | Meaning | Typical port |
| --- | --- | --- |
| `tls` | The connection is encrypted from the start (implicit SSL/TLS). | 465 |
| `starttls` | The session must upgrade to TLS; the plugin aborts if the upgrade fails. | 587 |

There is deliberately no plaintext option. **保存** and **发送测试邮件** are
separate actions, so a profile can be verified before it is stored; the test
recipient is used for that one request only and is never persisted.

Saving without filling in the password field keeps the password already in the
Keychain, so settings can be edited without retyping it. **清除已存密码**
removes it.

### Executor email mapping

MES does not carry executor email addresses, so they are supplied as a
workbook with exactly two columns:

| 执行人姓名 | 邮箱地址 |
| --- | --- |

**下载导入模板** pre-fills the name column with every executor that appears in
your cached plans, so you only fill in addresses. MES's internal `executorId`
never appears in the workbook — it is not shown anywhere in the UI, so asking
you to supply it would be asking for something you cannot obtain. The server
resolves each name back to an ID from the plan cache.

One person can hold several MES accounts (an old and a current one), so a name
may resolve to several IDs. For the same reason a stored mapping is matched by
executor ID **first and by name second**: when MES issues someone a new account
the ID changes while the name does not, and an ID-only match would let the
mapping fail silently until the workbook was imported again. This fallback relies on one
organisational guarantee: **no two different employees share a name** — when a
name would collide it is disambiguated in the employee name itself. If that ever
stops holding, the fallback must be narrowed to unique names only, because two
same-named people would otherwise share one address. All of them are stored against the same address,
and the preview merges them: **one person receives one email per batch**, no
matter how many accounts their overdue plans are spread across.

A name that appears in no cached plan is reported as a row error rather than
silently dropped, and writing the same person on two rows is an error too —
the server cannot know which address you meant.

When a preview is blocked, it names **every** blocker at once rather than one
per attempt, and separates the two cases because they are fixed differently:

- *执行人还没有邮箱映射* — add the address in the mapping panel and retry.
- *执行人在 MES 中没有姓名* — MES sometimes stores an `executorId` with no name.
  Such a person can never be matched by a name-keyed workbook, so the message
  names the plan and the ID: either fill the name in MES, or unselect that plan.

Import is two-phase. The upload is parsed in memory and shown as a preview
classified into added / updated / unchanged / errors. **A workbook with any row
error commits nothing** — the preview simply offers no confirm button, so a
partial import cannot happen. Confirming merges by 执行人 ID: an executor absent
from the workbook keeps their stored address rather than being silently
deleted.

**导出映射 produces a file containing real email addresses.** Treat it as
private: do not commit it, attach it to a ticket, or forward it.

### Sending

1. Query plans, then tick the ones to send. Only status `3` rows have a
   checkbox. Selection is keyed by plan ID, so it survives paging; the header
   checkbox only selects the current page.
2. **生成邮件预览** submits plan IDs only. The server re-reads every selected
   plan from MES, groups them per executor, and renders the templates. If any
   plan is no longer overdue, or any executor has no mapped address, the whole
   batch stops — there is no partial preview.
3. Review each expanded group, tick the confirmation box, then **确认发送**.
   The server re-checks plan status a second time before the first message
   leaves, because minutes may have passed since the preview.
4. Messages are sent one at a time. A single failure does not stop the rest. A
   transient network failure is retried once; an authentication failure or a
   rejected recipient is not retried, because neither improves on a second
   attempt. Failed groups can be retried on their own afterwards.

The preview token is random, bound to the current MES account, single-use, and
held only in memory — restarting DSH invalidates it.

Templates accept exactly three variables: `{{executorName}}`, `{{planCount}}`,
and `{{planList}}`. Anything else is rejected rather than sent literally.

### Per-account isolation

Every mail request derives its identity from `mes auth status` on the server
side and keys storage by the SHA-256 of that account. The browser cannot submit
an identity and never receives one. Switching MES accounts therefore shows a
different set of settings, mappings, and history; one account cannot read
another's rows.

### Where the private data lives

| What | Where |
| --- | --- |
| SMTP password | macOS Keychain, service `mes-plan-list.smtp`, account = the hashed MES account |
| Settings, mappings, send history | `~/.dsh/storages/mes-plan-list/mail.db` |
| Plan cache | `~/.dsh/storages/mes-plan-list/plans.db` |

Mail data is a **separate database from the plan cache on purpose**: clearing
the cache rebuilds `plans.db` from MES and must never take your mappings with
it.

### Privacy checklist

Never committed, never logged, never in a release archive:

- SMTP passwords — they exist only in the Keychain.
- Real email addresses. Send history stores masked addresses (`z***@example.invalid`)
  and an error code, never a full address or a message body.
- Message bodies and template text.
- Uploaded workbook contents. The buffer is parsed in memory and not retained.
- Test fixtures in this repository use `example.invalid` addresses only.

Each store is cleared independently, so you can drop one without losing the
others:

| To clear | Do this |
| --- | --- |
| SMTP password | **清除已存密码** in the mail settings panel |
| One executor's address | **删除** on that row of the mapping table |
| Send history | **清空历史** |
| Plan cache | **清空缓存** in the settings panel — this does not touch `mail.db` |
| Everything | Delete `~/.dsh/storages/mes-plan-list/` and the `mes-plan-list.smtp` Keychain items |

## Status values

| Value | MES status |
| --- | --- |
| `0` | Not started (未开始) |
| `1` | In progress (进行中) |
| `2` | Finished (结束) |
| `3` | Overdue and unfinished (已逾期未结束) |

Leaving status empty queries all statuses. Queries are limited to the supplied
date range and return every matching plan: MES answers in pages, so the host
pages through them until the result is complete. A wide range therefore costs
several CLI calls, so it takes proportionally longer.
