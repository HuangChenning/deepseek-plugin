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

## Settings

The page's **设置** panel configures the absolute path to the `mes` binary.
Leave it empty to use `mes` from PATH. Setting it fixes the case where a DSH
started from a GUI or launchd cannot resolve `mes`.

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
several CLI calls — a full year (958 plans) takes about 5 calls and 7 seconds.
