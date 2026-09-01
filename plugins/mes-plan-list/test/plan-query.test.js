import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPlanListArgs, queryPlans } from '../src/plan-query.js'

test('builds a bounded MES plan list command with status', () => {
  assert.deepEqual(buildPlanListArgs({ startDate: '2026-09-01', endDate: '2026-09-30', status: '3' }), [
    '-o', 'json', 'plan', 'list', '--start-date', '2026-09-01', '--end-date', '2026-09-30', '--status', '3', '--page', '1', '--page-size', '200',
  ])
})

test('omits status when querying all statuses', () => {
  assert.deepEqual(buildPlanListArgs({ startDate: '2026-09-01', endDate: '2026-09-30' }), [
    '-o', 'json', 'plan', 'list', '--start-date', '2026-09-01', '--end-date', '2026-09-30', '--page', '1', '--page-size', '200',
  ])
})

test('rejects a reverse date range', () => {
  assert.throws(
    () => buildPlanListArgs({ startDate: '2026-09-30', endDate: '2026-09-01' }),
    { message: '开始日期不能晚于结束日期' },
  )
})

test('rejects an invalid status', () => {
  assert.throws(
    () => buildPlanListArgs({ startDate: '2026-09-01', endDate: '2026-09-30', status: '4' }),
    { message: '状态值无效' },
  )
})

test('returns an empty list when MES has no list', async () => {
  const plans = await queryPlans(
    { startDate: '2026-09-01', endDate: '2026-09-30' },
    async () => JSON.stringify({ total: 0 }),
  )

  assert.deepEqual(plans, [])
})

test('surfaces a non-zero runner failure', async () => {
  await assert.rejects(
    queryPlans(
      { startDate: '2026-09-01', endDate: '2026-09-30' },
      async () => { throw new Error('MES command failed') },
    ),
    { message: 'MES command failed' },
  )
})
