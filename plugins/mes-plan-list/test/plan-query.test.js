import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPlanListArgs, queryPlans } from '../src/plan-query.js'
import { createHandlers } from '../src/index.js'
import { PlanStore } from '../src/plan-store.js'

function makeRequest({ method = 'POST', contentType = 'application/json', body = '' } = {}) {
  const request = Readable.from(body === '' ? [] : [Buffer.from(body)])
  request.method = method
  request.headers = { 'content-type': contentType }
  return request
}

function makeResponse() {
  return {
    headers: {},
    statusCode: undefined,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(body = '') {
      this.body = body
    },
  }
}

function makeFailingRequest() {
  const request = Readable.from((async function* () {
    throw new Error('socket reset: internal transport detail')
  })())
  request.method = 'POST'
  request.headers = { 'content-type': 'application/json' }
  return request
}

test('rejects a JSON query without a start date before it reaches MES', async () => {
  const { handleQuery } = createHandlers({
    query: async () => { throw new Error('query runner should not execute') },
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ body: JSON.stringify({ endDate: '2026-09-30' }) }), response)

  assert.equal(response.statusCode, 400)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '开始日期不能为空' })
})

test('hides MES runner details when a valid query fails', async () => {
  const store = new PlanStore(join(await mkdtemp(join(tmpdir(), 'mes-plan-query-')), 'plans.db'))
  const { handleQuery } = createHandlers({
    query: async () => { throw new Error('MES command failed: secret stack trace') },
    store: () => store,
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30' }) }), response)

  assert.equal(response.statusCode, 502)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'MES 查询失败，请稍后重试' })
})

test('returns plans only for a JSON POST query', async () => {
  const store = new PlanStore(join(await mkdtemp(join(tmpdir(), 'mes-plan-query-')), 'plans.db'))
  const { handleQuery } = createHandlers({
    query: async () => [{ id: 18366, title: '验证计划', startDate: '2026-09-10 08:00:00', endDate: '2026-09-11 18:00:00', status: 3 }],
    store: () => store,
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30', statuses: ['3'] }) }), response)

  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.plans.map((row) => row.id), [18366])
  assert.equal(payload.fromCache, false, '首次查询没有缓存，应回源 MES')
  assert.match(payload.syncedAt, /^\d{4}-\d{2}-\d{2}T/)
  store.close()
})

// 首次查询必须像没有缓存一样直接出结果，缓存是顺带的副作用，不打断用户。
test('serves a repeat query from the local cache without touching MES', async () => {
  const store = new PlanStore(join(await mkdtemp(join(tmpdir(), 'mes-plan-query-')), 'plans.db'))
  let calls = 0
  const { handleQuery } = createHandlers({
    query: async () => {
      calls += 1
      return [{ id: 1, startDate: '2026-09-10 08:00:00', endDate: '2026-09-11 18:00:00', status: 2 }]
    },
    store: () => store,
  })
  const body = JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30' })

  await handleQuery(makeRequest({ body }), makeResponse())
  const second = makeResponse()
  await handleQuery(makeRequest({ body }), second)

  assert.equal(calls, 1, '第二次查询应命中缓存')
  assert.equal(JSON.parse(second.body).fromCache, true)
  store.close()
})

test('refresh forces a resync even when the window is cached', async () => {
  const store = new PlanStore(join(await mkdtemp(join(tmpdir(), 'mes-plan-query-')), 'plans.db'))
  let calls = 0
  const { handleQuery } = createHandlers({
    query: async () => {
      calls += 1
      return [{ id: 1, startDate: '2026-09-10 08:00:00', endDate: '2026-09-11 18:00:00', status: 2 }]
    },
    // 同步会连报工一起拉，不注入就会真的去调用 mes CLI。
    hours: async () => [],
    store: () => store,
  })

  await handleQuery(makeRequest({ body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30' }) }), makeResponse())
  const forced = makeResponse()
  await handleQuery(makeRequest({ body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30', refresh: true }) }), forced)

  assert.equal(calls, 2)
  assert.equal(JSON.parse(forced.body).fromCache, false)
  store.close()
})

// 同步范围必须覆盖已缓存的一切，否则窄窗口同步只清掉自己窗口内的幽灵行。
test('syncs a window wide enough to cover everything already cached', async () => {
  const store = new PlanStore(join(await mkdtemp(join(tmpdir(), 'mes-plan-query-')), 'plans.db'))
  const asked = []
  const { handleQuery } = createHandlers({
    query: async (input) => {
      asked.push(`${input.startDate}~${input.endDate}`)
      return []
    },
    hours: async () => [],
    store: () => store,
  })

  await handleQuery(makeRequest({ body: JSON.stringify({ startDate: '2026-01-01', endDate: '2026-12-31' }) }), makeResponse())
  await handleQuery(makeRequest({ body: JSON.stringify({ startDate: '2026-08-01', endDate: '2026-08-31', refresh: true }) }), makeResponse())

  assert.deepEqual(asked, ['2026-01-01~2026-12-31', '2026-01-01~2026-12-31'],
    '第二次只想同步 8 月，但范围被扩展到覆盖已缓存的全年')
  store.close()
})

// 落盘一律全状态，状态过滤在本地做：带状态的返回不是窗口全集，拿它清理幽灵行会误删。
test('syncs the whole window regardless of the status filter', async () => {
  const store = new PlanStore(join(await mkdtemp(join(tmpdir(), 'mes-plan-query-')), 'plans.db'))
  const asked = []
  const { handleQuery } = createHandlers({
    query: async (input) => {
      asked.push(input.status)
      return [
        { id: 1, startDate: '2026-09-10 08:00:00', endDate: '2026-09-11 18:00:00', status: 2 },
        { id: 2, startDate: '2026-09-12 08:00:00', endDate: '2026-09-13 18:00:00', status: 3 },
      ]
    },
    store: () => store,
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30', statuses: ['3'] }) }), response)

  assert.deepEqual(asked, [''], '向 MES 要的是全状态')
  assert.deepEqual(JSON.parse(response.body).plans.map((row) => row.id), [2], '状态过滤在本地完成')
  store.close()
})

test('rejects a non-JSON query request', async () => {
  const { handleQuery } = createHandlers()
  const response = makeResponse()

  await handleQuery(makeRequest({ contentType: 'text/plain', body: '{}' }), response)

  assert.equal(response.statusCode, 415)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '仅支持 JSON 请求' })
})

test('hides stream read details when a JSON request disconnects', async () => {
  const { handleQuery } = createHandlers()
  const response = makeResponse()

  await handleQuery(makeFailingRequest(), response)

  assert.equal(response.statusCode, 400)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '请求体读取失败' })
})

test('rejects query methods other than POST', async () => {
  const { handleQuery } = createHandlers()
  const response = makeResponse()

  await handleQuery(makeRequest({ method: 'GET' }), response)

  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.allow, 'POST')
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '仅支持 POST 请求' })
})

test('rejects a JSON body larger than 16 KiB', async () => {
  const { handleQuery } = createHandlers()
  const response = makeResponse()

  await handleQuery(makeRequest({ body: 'x'.repeat(16 * 1024 + 1) }), response)

  assert.equal(response.statusCode, 400)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '请求体不能超过 16 KiB' })
})

test('serves the query form on a GET page request', async () => {
  const { handlePage } = createHandlers()
  const response = makeResponse()

  await handlePage(makeRequest({ method: 'GET' }), response)

  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8')
  assert.match(response.body, /<form id="query-form"/)
})

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

test('pages through MES so a result larger than one page is returned whole', async () => {
  const requested = []
  const plans = await queryPlans({ startDate: '2026-09-01', endDate: '2026-09-30' }, async (args) => {
    const page = Number(args[args.indexOf('--page') + 1])
    requested.push(page)
    const size = Number(args[args.indexOf('--page-size') + 1])
    const all = Array.from({ length: 450 }, (unused, index) => ({ id: index + 1 }))
    return JSON.stringify({ list: all.slice((page - 1) * size, page * size), total: all.length })
  })

  assert.deepEqual(requested, [1, 2, 3])
  assert.equal(plans.length, 450)
  assert.deepEqual(plans.at(-1), { id: 450 })
})

// MES 的分页会在页边界上重复返回少量记录（已实测）。不去重的话条数和表格行都会
// 偏多；终止判断必须用原始条数，否则永远够不到 total。
test('de-duplicates plans that MES returns on more than one page', async () => {
  const plans = await queryPlans({ startDate: '2026-01-01', endDate: '2026-12-31' }, async (args) => {
    const page = Number(args[args.indexOf('--page') + 1])
    const pages = {
      1: [{ id: 1 }, { id: 2 }, { id: 3 }],
      2: [{ id: 3 }, { id: 4 }],
    }
    return JSON.stringify({ list: pages[page] ?? [], total: 5 })
  })

  assert.deepEqual(plans.map((row) => row.id), [1, 2, 3, 4])
})

test('stops paging on an empty page even when MES reports an unreachable total', async () => {
  const plans = await queryPlans({ startDate: '2026-09-01', endDate: '2026-09-30' }, async (args) => {
    const page = Number(args[args.indexOf('--page') + 1])
    return JSON.stringify({ list: page === 1 ? [{ id: 1 }] : [], total: 9999 })
  })

  assert.deepEqual(plans, [{ id: 1 }])
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
