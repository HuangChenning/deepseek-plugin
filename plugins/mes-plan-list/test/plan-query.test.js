import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'

import { buildPlanListArgs, queryPlans } from '../src/plan-query.js'
import { apply, createHandlers } from '../src/index.js'

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

  await handleQuery(makeRequest({ body: JSON.stringify({ endDate: '2026-09-30', status: '' }) }), response)

  assert.equal(response.statusCode, 400)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '开始日期不能为空' })
})

test('hides MES runner details when a valid query fails', async () => {
  const { handleQuery } = createHandlers({
    query: async () => { throw new Error('MES command failed: secret stack trace') },
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30', status: '' }) }), response)

  assert.equal(response.statusCode, 502)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'MES 查询失败，请稍后重试' })
})

test('returns plans only for a JSON POST query', async () => {
  const { handleQuery } = createHandlers({
    query: async () => ({ plans: [{ id: 18366, title: '验证计划' }], total: 1 }),
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30', status: '3' }) }), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, plans: [{ id: 18366, title: '验证计划' }], total: 1 })
})

test('reports the MES total so a truncated page can warn instead of silently dropping plans', async () => {
  const { handleQuery } = createHandlers({
    query: async () => ({ plans: [{ id: 1 }], total: 512 }),
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30' }) }), response)

  assert.equal(JSON.parse(response.body).total, 512)
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

test('registers the exact page and query routes', () => {
  const routes = []

  apply({ webServer: { register: (route) => routes.push(route) } })

  assert.deepEqual(routes.map(({ kind, path }) => ({ kind, path })), [
    { kind: 'exact', path: '/plugins/mes-plan-list' },
    { kind: 'exact', path: '/api/plugins/mes-plan-list/query' },
  ])
  assert.equal(typeof routes[0].handler, 'function')
  assert.equal(typeof routes[1].handler, 'function')
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
  const result = await queryPlans(
    { startDate: '2026-09-01', endDate: '2026-09-30' },
    async () => JSON.stringify({ total: 0 }),
  )

  assert.deepEqual(result, { plans: [], total: 0 })
})

test('keeps the MES total even when it exceeds one page, so truncation stays visible', async () => {
  const result = await queryPlans(
    { startDate: '2026-09-01', endDate: '2026-09-30' },
    async () => JSON.stringify({ list: [{ id: 1 }, { id: 2 }], total: 987 }),
  )

  assert.deepEqual(result, { plans: [{ id: 1 }, { id: 2 }], total: 987 })
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
