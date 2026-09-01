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

Link this local package into the DSH Web profile once before launching it:

```sh
dsh plugin --profile web add "link:$(pwd)/plugins/mes-plan-list"
```

`package.json` declares `dsh.bundle.patch`, so that command also appends
`mes-plan-list` to the profile's `dsh.profile.bundles` list. Without that entry
DSH never loads the plugin: the sidebar entry is missing and both routes return
404.

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
date range and the plugin always requests the first 200 results; when MES
reports a larger total, the page says so and asks for a narrower range instead
of silently dropping plans.
