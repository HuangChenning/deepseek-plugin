import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'

import { createHandlers } from '../src/index.js'

function makeRequest({ method = 'GET', contentType = 'application/json', body = '' } = {}) {
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

test('serves the stored mes path', async () => {
  const { handleConfig } = createHandlers({ loadConfig: async () => ({ mesPath: '/opt/homebrew/bin/mes' }) })
  const response = makeResponse()

  await handleConfig(makeRequest(), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, mesPath: '/opt/homebrew/bin/mes' })
})

// 只校验路径格式等于允许把任意程序配成 mes，所以保存前必须先跑通 --version。
test('refuses to store a path that is not the mes CLI', async () => {
  let saved = false
  const { handleConfig } = createHandlers({
    readVersion: async () => { throw new Error('该路径不是 mes CLI') },
    saveConfig: async () => { saved = true; return { mesPath: '/bin/sh' } },
  })
  const response = makeResponse()

  await handleConfig(makeRequest({ method: 'PUT', body: JSON.stringify({ mesPath: '/bin/sh' }) }), response)

  assert.equal(response.statusCode, 400)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '该路径不是 mes CLI' })
  assert.equal(saved, false, '校验失败时不应写入配置')
})

test('stores a verified mes path and reports the detected version', async () => {
  const { handleConfig } = createHandlers({
    readVersion: async () => '0.5.3',
    saveConfig: async ({ mesPath }) => ({ mesPath }),
  })
  const response = makeResponse()

  await handleConfig(makeRequest({ method: 'PUT', body: JSON.stringify({ mesPath: '/opt/homebrew/bin/mes' }) }), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, mesPath: '/opt/homebrew/bin/mes', version: '0.5.3' })
})

// 清空路径是「改回用 PATH」，不该被当成一个待验证的二进制。
test('clears the mes path without running a version check', async () => {
  let verified = false
  const { handleConfig } = createHandlers({
    readVersion: async () => { verified = true; return '0.5.3' },
    saveConfig: async ({ mesPath }) => ({ mesPath }),
  })
  const response = makeResponse()

  await handleConfig(makeRequest({ method: 'PUT', body: JSON.stringify({ mesPath: '' }) }), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, mesPath: '', version: '' })
  assert.equal(verified, false)
})

test('rejects config fields other than mesPath', async () => {
  const { handleConfig } = createHandlers()
  const response = makeResponse()

  await handleConfig(makeRequest({ method: 'PUT', body: JSON.stringify({ mesPath: '', shell: true }) }), response)

  assert.equal(response.statusCode, 400)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '请求参数无效' })
})

test('rejects config methods other than GET and PUT', async () => {
  const { handleConfig } = createHandlers()
  const response = makeResponse()

  await handleConfig(makeRequest({ method: 'DELETE' }), response)

  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.allow, 'GET, PUT')
})

test('reports a logged-in MES account', async () => {
  const { handleAuth } = createHandlers({ readAuth: async () => ({ loggedIn: true, account: '心静自然凉' }) })
  const response = makeResponse()

  await handleAuth(makeRequest(), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, loggedIn: true, account: '心静自然凉' })
})

test('reports a logged-out CLI as a normal answer, not an error', async () => {
  const { handleAuth } = createHandlers({ readAuth: async () => ({ loggedIn: false, account: '' }) })
  const response = makeResponse()

  await handleAuth(makeRequest(), response)

  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).loggedIn, false)
})

test('hides CLI details when the auth probe itself fails', async () => {
  const { handleAuth } = createHandlers({
    readAuth: async () => { throw new Error('spawn /nope ENOENT') },
  })
  const response = makeResponse()

  await handleAuth(makeRequest(), response)

  assert.equal(response.statusCode, 502)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '无法读取 MES 登录状态，请检查 mes 路径配置' })
})

test('registers the page, query, config, and auth routes', async () => {
  const { apply } = await import('../src/index.js')
  const routes = []

  apply({ webServer: { register: (route) => routes.push(route) } })

  assert.deepEqual(routes.map(({ path }) => path), [
    '/plugins/mes-plan-list',
    '/api/plugins/mes-plan-list/query',
    '/api/plugins/mes-plan-list/config',
    '/api/plugins/mes-plan-list/auth',
  ])
})
