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

// 默认给「进行中」：默认数据不该落在会被过滤掉的「结束」上。
function plan(id, startDate, endDate, status = 1) {
  return { id, startDate: `${startDate} 08:00:00`, endDate: `${endDate} 00:00:00`, status, title: `计划 ${id}` }
}

const ids = (rows) => rows.map((row) => row.id).sort((a, b) => a - b)

// 没查过的机器上不该出现 .db 文件。
test('does not create the database until something is written', async () => {
  const store = await tempStore()

  assert.equal(existsSync(store.path), false)

  store.replaceAllPlans([plan(1, '2026-07-05', '2026-07-06')])

  assert.equal(existsSync(store.path), true)
  store.close()
})

/*
 * 查询按区间重叠返回，而不是 MES 那种「整个落在窗口内」——否则一个 5 月开始、
 * 8 月结束的计划不会出现在 8 月的查询里，而使用者期望看到它。下面覆盖一个计划
 * 相对窗口的全部位置关系。
 */
test('returns every plan whose dates overlap the window', async () => {
  const store = await tempStore()
  store.replaceAllPlans([
    plan(1, '2026-08-10', '2026-08-20'),  // 完全落在窗口内
    plan(2, '2026-07-01', '2026-08-10'),  // 左跨界：结束在窗口内
    plan(3, '2026-08-20', '2026-10-01'),  // 右跨界：开始在窗口内
    plan(4, '2026-07-01', '2026-10-01'),  // 反包含：计划覆盖整个窗口
    plan(5, '2026-06-01', '2026-08-04'),  // 结束正好等于窗口开始
    plan(6, '2026-09-02', '2026-11-01'),  // 开始正好等于窗口结束
    plan(7, '2026-07-01', '2026-08-03'),  // 完全在窗口之前
    plan(8, '2026-09-03', '2026-09-10'),  // 完全在窗口之后
  ])

  const rows = store.readPlans({ startDate: '2026-08-04', endDate: '2026-09-02' })

  assert.deepEqual(ids(rows), [1, 2, 3, 4, 5, 6], '与窗口有交集的都要返回，边界相接也算')
  store.close()
})

// 比较按日粒度：当天几点开始或结束都不影响命中，否则「结束于 07-31 18:00」这类
// 计划会莫名其妙地被排除在 7 月之外。
test('ignores the time of day when matching window boundaries', async () => {
  const store = await tempStore()
  store.replaceAllPlans([
    { id: 1, startDate: '2026-07-05 08:00:00', endDate: '2026-07-06 18:00:00', status: 1 },
    { id: 2, startDate: '2026-07-01 08:30:00', endDate: '2026-07-31 18:00:00', status: 1 },
    { id: 3, startDate: '2026-07-10 08:00:00', endDate: '2026-07-31 00:00:00', status: 1 },
  ])

  assert.deepEqual(ids(store.readPlans({ startDate: '2026-07-01', endDate: '2026-07-31' })), [1, 2, 3])
  store.close()
})

// 已结束的计划一律不显示，界面上也没有这个筛选项，所以这条不能靠调用方来保证。
test('never returns finished plans', async () => {
  const store = await tempStore()
  store.replaceAllPlans([
    plan(1, '2026-07-05', '2026-07-06', 1),
    plan(2, '2026-07-07', '2026-07-08', 2),
    plan(3, '2026-07-09', '2026-07-10', 3),
  ])

  assert.deepEqual(ids(store.readPlans({ startDate: '2026-07-01', endDate: '2026-07-31' })), [1, 3])
  store.close()
})

/*
 * MES 的 --status / --check-type 只接受单值（实测 `--status 2,3` 返回 0 条），
 * 多选因此只能靠本地缓存实现——本地存着全量，任意组合都能筛。
 */
test('filters by several statuses at once, which MES itself cannot do', async () => {
  const store = await tempStore()
  store.replaceAllPlans([
    plan(1, '2026-07-05', '2026-07-06', 0),
    plan(2, '2026-07-07', '2026-07-08', 1),
    plan(3, '2026-07-09', '2026-07-10', 3),
  ])

  const window = { startDate: '2026-07-01', endDate: '2026-07-31' }
  assert.deepEqual(ids(store.readPlans({ ...window, statuses: ['1', '3'] })), [2, 3])
  store.close()
})

test('filters by several check types at once', async () => {
  const store = await tempStore()
  store.replaceAllPlans([
    { ...plan(1, '2026-07-05', '2026-07-06'), checkType: 0 },
    { ...plan(2, '2026-07-07', '2026-07-08'), checkType: 5 },
    { ...plan(3, '2026-07-09', '2026-07-10'), checkType: 1 },
  ])

  const window = { startDate: '2026-07-01', endDate: '2026-07-31' }
  assert.deepEqual(ids(store.readPlans({ ...window, checkTypes: ['0', '1'] })), [1, 3])
  store.close()
})

test('combines status and check type filters', async () => {
  const store = await tempStore()
  store.replaceAllPlans([
    { ...plan(1, '2026-07-05', '2026-07-06', 1), checkType: 5 },
    { ...plan(2, '2026-07-07', '2026-07-08', 3), checkType: 5 },
    { ...plan(3, '2026-07-09', '2026-07-10', 1), checkType: 0 },
  ])

  const rows = store.readPlans({
    startDate: '2026-07-01', endDate: '2026-07-31', statuses: ['1'], checkTypes: ['5'],
  })

  assert.deepEqual(ids(rows), [1])
  store.close()
})

/*
 * 全量同步让删除检测变得平凡：MES 这次没返回的计划就是已删除的。这正是选择全量
 * 而非按窗口增量的主要理由——窗口方案要靠「同步范围比查询范围更宽」的启发式，
 * 边界很难说清，还容易漏。
 */
test('drops plans that no longer exist in MES', async () => {
  const store = await tempStore()
  store.replaceAllPlans([plan(1, '2026-07-05', '2026-07-06'), plan(2, '2026-07-07', '2026-07-08')])

  store.replaceAllPlans([plan(1, '2026-07-05', '2026-07-06')])

  assert.deepEqual(ids(store.readPlans({ startDate: '2026-01-01', endDate: '2026-12-31' })), [1])
  store.close()
})

test('updates a plan in place when MES returns a changed version', async () => {
  const store = await tempStore()
  store.replaceAllPlans([plan(1, '2026-07-05', '2026-07-06', 1)])

  store.replaceAllPlans([{ ...plan(1, '2026-07-05', '2026-07-06', 3), title: '改过的标题' }])

  const rows = store.readPlans({ startDate: '2026-07-01', endDate: '2026-07-31' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, '改过的标题')
  assert.equal(rows[0].status, 3)
  store.close()
})

test('reports when the last full sync happened', async () => {
  const store = await tempStore()

  assert.equal(store.lastSync(), undefined, '从未同步过')

  store.replaceAllPlans([], '2026-09-02T00:00:00.000Z')
  assert.equal(store.lastSync(), '2026-09-02T00:00:00.000Z')

  store.replaceAllPlans([], '2026-09-03T00:00:00.000Z')
  assert.equal(store.lastSync(), '2026-09-03T00:00:00.000Z')
  store.close()
})

test('clearing the cache resets both the rows and the sync time', async () => {
  const store = await tempStore()
  store.replaceAllPlans([plan(1, '2026-03-05', '2026-03-06')])

  store.clear()

  assert.deepEqual(store.summary(), { count: 0, syncedAt: '' })
  assert.equal(store.lastSync(), undefined)
  store.close()
})

test('summarizes the cached row count and sync time', async () => {
  const store = await tempStore()
  store.replaceAllPlans(
    [plan(1, '2026-03-05', '2026-03-06'), plan(2, '2026-08-05', '2026-08-06')],
    '2026-09-02T00:00:00.000Z',
  )

  assert.deepEqual(store.summary(), { count: 2, syncedAt: '2026-09-02T00:00:00.000Z' })
  store.close()
})
