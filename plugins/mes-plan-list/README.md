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

## Test

```sh
pnpm test
```

The tests use injected runners and do not query MES production data.

## Run locally

```sh
dsh web --patch plugins/mes-plan-list/cordis.patch.yml --no-open
```

Open <http://127.0.0.1:3080/plugins/mes-plan-list>, select a start date and
end date, optionally select a status, and submit the form. A query displays a
plan table, an empty state, or a concise MES error.

## Status values

| Value | MES status |
| --- | --- |
| `0` | Not started (未开始) |
| `1` | In progress (进行中) |
| `2` | Finished (已完成) |
| `3` | Overdue and unfinished (逾期未完成) |

Leaving status empty queries all statuses. Queries are limited to the supplied
date range and the plugin always requests the first 200 results.
