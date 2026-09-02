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
