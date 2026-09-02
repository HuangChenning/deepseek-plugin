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
  const { handleAuth } = createHandlers({ readAuth: async () => ({ loggedIn: true, account: '测试账号' }) })
  const response = makeResponse()

  await handleAuth(makeRequest(), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, loggedIn: true, account: '测试账号' })
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

// 打开页面不应该悄悄访问外部更新服务器：默认只读本机版本。
test('reads only the local version when no check was requested', async () => {
  let checked = false
  const { handleCli } = createHandlers({
    readCliInfo: async () => ({ version: '0.5.3' }),
    readCliStatus: async () => { checked = true; return { version: '0.5.3', upToDate: true, output: '' } },
  })
  const response = makeResponse()

  await handleCli(makeRequest(), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, version: '0.5.3' })
  assert.equal(checked, false, '未点击检查更新时不应联网')
})

test('checks for updates only when check=1 is requested', async () => {
  let checked = false
  const { handleCli } = createHandlers({
    readCliInfo: async () => ({ version: '0.5.3' }),
    readCliStatus: async () => {
      checked = true
      return { version: '0.5.3', upToDate: false, output: 'a new version is available: 0.6.0' }
    },
  })
  const response = makeResponse()
  const request = makeRequest()
  request.url = '/api/plugins/mes-plan-list/cli?check=1'

  await handleCli(request, response)

  assert.equal(checked, true)
  assert.deepEqual(JSON.parse(response.body), {
    ok: true, version: '0.5.3', upToDate: false, output: 'a new version is available: 0.6.0',
  })
})

test('distinguishes a failed update check from an unreadable binary', async () => {
  const failing = async () => { throw new Error('dial tcp: connection refused') }
  const checkResponse = makeResponse()
  const checkRequest = makeRequest()
  checkRequest.url = '/api/plugins/mes-plan-list/cli?check=1'
  await createHandlers({ readCliStatus: failing }).handleCli(checkRequest, checkResponse)

  const versionResponse = makeResponse()
  await createHandlers({ readCliInfo: failing }).handleCli(makeRequest(), versionResponse)

  assert.equal(JSON.parse(checkResponse.body).error, '检查更新失败，请稍后重试')
  assert.equal(JSON.parse(versionResponse.body).error, '无法读取 mes 版本，请检查 mes 路径配置')
})

// 更新会替换正在使用的二进制；此刻放行查询会以难懂的方式失败。
test('refuses queries while the mes binary is being replaced', async () => {
  const { handleQuery } = createHandlers({
    cliBusy: () => true,
    query: async () => { throw new Error('query should not run during an update') },
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ method: 'POST', body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30' }) }), response)

  assert.equal(response.statusCode, 503)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'mes 正在更新，请稍后重试' })
})

test('refuses a second update while one is already running', async () => {
  const { handleCliUpdate } = createHandlers({
    cliBusy: () => true,
    updateCli: async () => { throw new Error('update should not start twice') },
  })
  const response = makeResponse()

  await handleCliUpdate(makeRequest({ method: 'POST' }), response)

  assert.equal(response.statusCode, 409)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'mes 正在更新，请稍候' })
})

test('reports the version the CLI has after an update', async () => {
  const { handleCliUpdate } = createHandlers({
    cliBusy: () => false,
    updateCli: async () => ({ version: '0.6.0', output: 'updated' }),
  })
  const response = makeResponse()

  await handleCliUpdate(makeRequest({ method: 'POST' }), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, version: '0.6.0', output: 'updated' })
})

test('hides CLI details when an update fails', async () => {
  const { handleCliUpdate } = createHandlers({
    cliBusy: () => false,
    updateCli: async () => { throw new Error('dial tcp: connection refused') },
  })
  const response = makeResponse()

  await handleCliUpdate(makeRequest({ method: 'POST' }), response)

  assert.equal(response.statusCode, 502)
  assert.match(JSON.parse(response.body).error, /mes 更新失败/)
})

// 与 mes CLI 那块同样的原则：打开页面只读本地 git 信息，联网检查要用户点。
test('reads only the local plugin version when no check was requested', async () => {
  let checked = false
  const { handlePlugin } = createHandlers({
    readPlugin: async () => ({ commit: 'abc1234', branch: 'main', at: '2026-09-02T00:00:00Z', subject: 'x' }),
    checkPlugin: async () => { checked = true; return {} },
  })
  const response = makeResponse()

  await handlePlugin(makeRequest(), response)

  assert.equal(JSON.parse(response.body).commit, 'abc1234')
  assert.equal(checked, false, '未点击检查更新时不应联网')
})

test('reports an available plugin update when check=1 is requested', async () => {
  const { handlePlugin } = createHandlers({
    checkPlugin: async () => ({ commit: 'abc1234', branch: 'main', upToDate: false, remoteCommit: 'def5678' }),
  })
  const response = makeResponse()
  const request = makeRequest()
  request.url = '/api/plugins/mes-plan-list/plugin?check=1'

  await handlePlugin(request, response)

  const payload = JSON.parse(response.body)
  assert.equal(payload.upToDate, false)
  assert.equal(payload.remoteCommit, 'def5678')
})

// 更新失败的原因要能被用户看懂并据此行动（例如先提交本地改动），不能吞成通用错误。
test('surfaces why an update was refused', async () => {
  const { handlePluginUpdate } = createHandlers({
    updatePlugin: async () => { throw new Error('仓库有未提交的改动，请先提交或还原后再更新') },
  })
  const response = makeResponse()

  await handlePluginUpdate(makeRequest({ method: 'POST' }), response)

  assert.equal(response.statusCode, 502)
  assert.equal(JSON.parse(response.body).error, '仓库有未提交的改动，请先提交或还原后再更新')
})

test('reports the new commit after a successful plugin update', async () => {
  const { handlePluginUpdate } = createHandlers({
    updatePlugin: async () => ({ commit: 'def5678', branch: 'main', changed: true, previousCommit: 'abc1234' }),
  })
  const response = makeResponse()

  await handlePluginUpdate(makeRequest({ method: 'POST' }), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body),
    { ok: true, commit: 'def5678', branch: 'main', changed: true, previousCommit: 'abc1234' })
})

test('rejects plugin update methods other than POST', async () => {
  const { handlePluginUpdate } = createHandlers()
  const response = makeResponse()

  await handlePluginUpdate(makeRequest({ method: 'GET' }), response)

  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.allow, 'POST')
})

test('registers the page, query, config, auth, CLI, and cache routes', async () => {
  const { apply } = await import('../src/index.js')
  const routes = []

  apply({ webServer: { register: (route) => routes.push(route) } })

  assert.deepEqual(routes.map(({ path }) => path), [
    '/plugins/mes-plan-list',
    '/api/plugins/mes-plan-list/query',
    '/api/plugins/mes-plan-list/config',
    '/api/plugins/mes-plan-list/auth',
    '/api/plugins/mes-plan-list/cli',
    '/api/plugins/mes-plan-list/cli/update',
    '/api/plugins/mes-plan-list/cache',
    '/api/plugins/mes-plan-list/plugin',
    '/api/plugins/mes-plan-list/plugin/update',
  ])
})
