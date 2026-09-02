import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFilterSelection, paginatePlans } from '../src/page.js'

test('filter selection refreshes valid queries after updating the picker state', () => {
  const events = []
  const form = { reportValidity: () => true }

  applyFilterSelection(form, 'status', (name) => events.push(['sync', name]), (refresh) => events.push(['query', refresh]))

  assert.deepEqual(events, [['sync', 'status'], ['query', false]])
})

test('filter selection does not query while the required date range is invalid', () => {
  let queried = false

  applyFilterSelection({ reportValidity: () => false }, 'checkType', () => {}, () => { queried = true })

  assert.equal(queried, false)
})

test('pagination returns the requested slice and page totals', () => {
  const plans = Array.from({ length: 45 }, (_, index) => ({ id: index + 1 }))

  const result = paginatePlans(plans, 2, 20)

  assert.deepEqual(result.items.map((plan) => plan.id), Array.from({ length: 20 }, (_, index) => index + 21))
  assert.deepEqual({ page: result.page, totalPages: result.totalPages, total: result.total }, { page: 2, totalPages: 3, total: 45 })
})

test('pagination clamps a page beyond the available results', () => {
  const plans = Array.from({ length: 45 }, (_, index) => ({ id: index + 1 }))

  const result = paginatePlans(plans, 9, 20)

  assert.deepEqual(result.items.map((plan) => plan.id), [41, 42, 43, 44, 45])
  assert.equal(result.page, 3)
})
