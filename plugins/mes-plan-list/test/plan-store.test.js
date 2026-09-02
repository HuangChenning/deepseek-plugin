import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PlanStore } from '../src/plan-store.js'

async function tempStore() {
  return new PlanStore(join(await mkdtemp(join(tmpdir(), 'mes-plan-store-')), 'plans.db'))
}

// 结束时间用 00:00:00，与真实跨天计划一致（如计划 16160 的 `2026-07-25 00:00:00`）：
// MES 把窗口末端也当作当天零点，所以这样的计划落在以该日为末端的窗口内。
function plan(id, startDate, endDate, status = 2) {
  return { id, startDate: `${startDate} 08:00:00`, endDate: `${endDate} 00:00:00`, status, title: `计划 ${id}` }
}

// 没查过的机器上不该出现 .db 文件。
test('does not create the database until something is written', async () => {
  const store = await tempStore()

  assert.equal(existsSync(store.path), false)

  store.writeWindow({ startDate: '2026-07-01', endDate: '2026-07-31' }, [plan(1, '2026-07-05', '2026-07-06')])

  assert.equal(existsSync(store.path), true)
  store.close()
})

// MES 的 --start-date/--end-date 是完全包含（已实测），本地必须复现同样的语义，
// 否则缓存返回的结果会和直接问 MES 不一致。
test('reads back only plans fully inside the requested window', async () => {
  const store = await tempStore()
  store.writeWindow({ startDate: '2026-07-01', endDate: '2026-07-31' }, [
    plan(1, '2026-07-05', '2026-07-06'),
    plan(2, '2026-07-13', '2026-07-25'),
    plan(3, '2026-07-20', '2026-07-30'),
  ])

  const inside = store.readPlans({ startDate: '2026-07-13', endDate: '2026-07-25' })
  const narrower = store.readPlans({ startDate: '2026-07-14', endDate: '2026-07-25' })

  assert.deepEqual(inside.map((row) => row.id), [2])
  assert.deepEqual(narrower.map((row) => row.id), [], '开始日期早于窗口的计划不该返回')
  store.close()
})

test('serves a narrower window from a wider synced window', async () => {
  const store = await tempStore()
  store.writeWindow({ startDate: '2026-07-01', endDate: '2026-08-31' }, [plan(1, '2026-07-05', '2026-07-06')])

  assert.notEqual(store.findCoveringSync({ startDate: '2026-07-01', endDate: '2026-07-31' }), undefined)
  assert.equal(store.findCoveringSync({ startDate: '2026-06-01', endDate: '2026-07-31' }), undefined,
    '未被覆盖的窗口必须回源，不能拿部分数据冒充完整结果')
  store.close()
})

/*
 * MES 把 `--end-date 2026-07-31` 解释为 `2026-07-31 00:00:00`，所以当天带时间的
 * 结束日期（18:00 等）会被它排除。本地比较若截断到日期就会多算——实测中这让一个
 * 窄窗口本地返回 11 条而 MES 只有 6 条。缓存必须与直接问 MES 完全一致，否则不可信。
 */
test('excludes plans ending later in the day than the window boundary, as MES does', async () => {
  const store = await tempStore()
  store.writeWindow({ startDate: '2026-07-01', endDate: '2026-08-31' }, [
    { id: 1, startDate: '2026-07-05 08:00:00', endDate: '2026-07-06 18:00:00', status: 2 },
    { id: 2, startDate: '2026-07-01 08:30:00', endDate: '2026-07-31 18:00:00', status: 2 },
    { id: 3, startDate: '2026-07-10 08:00:00', endDate: '2026-07-31 00:00:00', status: 2 },
  ])

  const july = store.readPlans({ startDate: '2026-07-01', endDate: '2026-07-31' })

  assert.deepEqual(july.map((row) => row.id), [1, 3], '结束于 07-31 18:00 的计划超出了窗口边界')
  store.close()
})

test('includes a plan starting later in the day than the window start, as MES does', async () => {
  const store = await tempStore()
  store.writeWindow({ startDate: '2026-07-01', endDate: '2026-08-31' }, [
    { id: 1, startDate: '2026-07-01 12:40:55', endDate: '2026-07-07 12:40:55', status: 2 },
  ])

  assert.deepEqual(store.readPlans({ startDate: '2026-07-01', endDate: '2026-07-31' }).map((r) => r.id), [1])
  store.close()
})

test('filters by status locally', async () => {
  const store = await tempStore()
  store.writeWindow({ startDate: '2026-07-01', endDate: '2026-07-31' }, [
    plan(1, '2026-07-05', '2026-07-06', 2),
    plan(2, '2026-07-07', '2026-07-08', 3),
  ])

  assert.deepEqual(store.readPlans({ startDate: '2026-07-01', endDate: '2026-07-31', status: '3' }).map((r) => r.id), [2])
  store.close()
})

// MES 侧删掉的计划不会主动通知；同步该窗口时必须把它清掉，否则会留下幽灵行。
test('drops plans that disappeared from MES on the next sync of that window', async () => {
  const store = await tempStore()
  const window = { startDate: '2026-07-01', endDate: '2026-07-31' }
  store.writeWindow(window, [plan(1, '2026-07-05', '2026-07-06'), plan(2, '2026-07-07', '2026-07-08')])

  store.writeWindow(window, [plan(1, '2026-07-05', '2026-07-06')])

  assert.deepEqual(store.readPlans(window).map((row) => row.id), [1])
  store.close()
})

// 清理必须限定在本次同步的窗口内，不能波及窗口外已缓存的数据。
test('keeps plans outside the synced window when cleaning up', async () => {
  const store = await tempStore()
  store.writeWindow({ startDate: '2026-06-01', endDate: '2026-06-30' }, [plan(9, '2026-06-10', '2026-06-11')])

  store.writeWindow({ startDate: '2026-07-01', endDate: '2026-07-31' }, [plan(1, '2026-07-05', '2026-07-06')])

  assert.deepEqual(store.readPlans({ startDate: '2026-06-01', endDate: '2026-06-30' }).map((r) => r.id), [9])
  store.close()
})

/*
 * 幽灵行的根源是「同步窗口比缓存过的范围窄」。coveringWindow 把同步范围扩展到
 * 覆盖所有缓存过的窗口，用户因此不必判断该做增量还是全量——正确性是自动的。
 */
test('expands a sync window to cover everything already cached', async () => {
  const store = await tempStore()
  store.writeWindow({ startDate: '2026-01-01', endDate: '2026-12-31' }, [])
  store.writeWindow({ startDate: '2025-06-01', endDate: '2025-06-30' }, [])

  const expanded = store.coveringWindow({ startDate: '2026-08-01', endDate: '2026-08-31' })

  assert.deepEqual(expanded, { startDate: '2025-06-01', endDate: '2026-12-31' })
  store.close()
})

test('leaves the window untouched when nothing is cached yet', async () => {
  const store = await tempStore()

  const window = { startDate: '2026-08-01', endDate: '2026-08-31' }
  assert.deepEqual(store.coveringWindow(window), window, '首次查询不该被扩大')
  store.close()
})

test('still widens the window when the request reaches beyond what is cached', async () => {
  const store = await tempStore()
  store.writeWindow({ startDate: '2026-06-01', endDate: '2026-06-30' }, [])

  assert.deepEqual(store.coveringWindow({ startDate: '2026-01-01', endDate: '2026-12-31' }),
    { startDate: '2026-01-01', endDate: '2026-12-31' })
  store.close()
})

// 扩展后的同步会连带清掉此前窄窗口同步够不到的幽灵行。
test('an expanded sync clears ghost rows left outside an earlier narrow sync', async () => {
  const store = await tempStore()
  const year = { startDate: '2026-01-01', endDate: '2026-12-31' }
  store.writeWindow(year, [plan(1, '2026-03-05', '2026-03-06'), plan(2, '2026-08-05', '2026-08-06')])

  // 计划 1 在 MES 侧被删除。用户只想同步 8 月，但同步范围被扩展到覆盖全年。
  const asked = store.coveringWindow({ startDate: '2026-08-01', endDate: '2026-08-31' })
  store.writeWindow(asked, [plan(2, '2026-08-05', '2026-08-06')])

  assert.deepEqual(store.readPlans(year).map((row) => row.id), [2], '3 月的幽灵行也被清掉了')
  store.close()
})

test('clearing the cache resets both the rows and the synced range', async () => {
  const store = await tempStore()
  store.writeWindow({ startDate: '2026-01-01', endDate: '2026-12-31' }, [plan(1, '2026-03-05', '2026-03-06')])

  store.clear()

  assert.deepEqual(store.summary(), { count: 0, startDate: '', endDate: '', syncedAt: '' })
  assert.deepEqual(store.coveringWindow({ startDate: '2026-08-01', endDate: '2026-08-31' }),
    { startDate: '2026-08-01', endDate: '2026-08-31' }, '清空后同步范围回到只覆盖当前查询')
  store.close()
})

test('summarizes the cached span and row count', async () => {
  const store = await tempStore()
  store.writeWindow({ startDate: '2026-01-01', endDate: '2026-12-31' },
    [plan(1, '2026-03-05', '2026-03-06'), plan(2, '2026-08-05', '2026-08-06')], '2026-09-02T00:00:00.000Z')

  assert.deepEqual(store.summary(),
    { count: 2, startDate: '2026-01-01', endDate: '2026-12-31', syncedAt: '2026-09-02T00:00:00.000Z' })
  store.close()
})

test('updates a plan in place when MES returns a changed version', async () => {
  const store = await tempStore()
  const window = { startDate: '2026-07-01', endDate: '2026-07-31' }
  store.writeWindow(window, [plan(1, '2026-07-05', '2026-07-06', 1)])

  store.writeWindow(window, [{ ...plan(1, '2026-07-05', '2026-07-06', 2), title: '改过的标题' }])

  const rows = store.readPlans(window)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, '改过的标题')
  assert.equal(rows[0].status, 2)
  store.close()
})

test('records a newer sync time when a window is re-synced', async () => {
  const store = await tempStore()
  const window = { startDate: '2026-07-01', endDate: '2026-07-31' }
  store.writeWindow(window, [], '2026-07-01T00:00:00.000Z')

  store.writeWindow(window, [], '2026-07-02T00:00:00.000Z')

  assert.equal(store.findCoveringSync(window), '2026-07-02T00:00:00.000Z')
  store.close()
})
