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

// 筛选值域固定，不能让请求塞进任意数字——它们会直接进 SQL 的 IN 子句。
test('rejects filter codes outside the known set', async () => {
  const { handleQuery } = createHandlers()
  const status = makeResponse()
  const type = makeResponse()

  await handleQuery(makeRequest({ method: 'POST', body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30', statuses: ['9'] }) }), status)
  await handleQuery(makeRequest({ method: 'POST', body: JSON.stringify({ startDate: '2026-09-01', endDate: '2026-09-30', checkTypes: ['nope'] }) }), type)

  assert.equal(JSON.parse(status.body).error, '状态值无效')
  assert.equal(JSON.parse(type.body).error, '类型值无效')
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

test('registers the page, query, config, auth, CLI, cache, and mail routes', async () => {
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
    '/api/plugins/mes-plan-list/mail/settings',
    '/api/plugins/mes-plan-list/mail/settings/test',
    '/api/plugins/mes-plan-list/mail/settings/password',
    '/api/plugins/mes-plan-list/mail/mappings',
    '/api/plugins/mes-plan-list/mail/mappings/template',
    '/api/plugins/mes-plan-list/mail/mappings/import-preview',
    '/api/plugins/mes-plan-list/mail/mappings/import-commit',
    '/api/plugins/mes-plan-list/mail/mappings/export',
    '/api/plugins/mes-plan-list/mail/preview',
    '/api/plugins/mes-plan-list/mail/send',
    '/api/plugins/mes-plan-list/mail/retry',
    '/api/plugins/mes-plan-list/mail/history',
  ])
  assert.equal(routes.every((route) => route.kind === 'exact'), true, '邮件路由必须精确匹配')
})

/*
 * 报工比计划多一个数量级（全年 3.4 万条、约 6 分钟），所以已有覆盖缓存时普通
 * 查询绝不能重复取它；仅当前窗口首次查询或用户主动同步时拉取。
 */
function hoursStore({ cached, onWrite = () => {} }) {
  let covering = cached
  return () => ({
    lastSync: () => '2026-09-02T00:00:00.000Z',
    readPlans: () => [{ id: 18051 }],
    replaceAllPlans: () => '2026-09-02T00:00:00.000Z',
    findCoveringHours: () => covering,
    readHours: () => ({ 18051: 16 }),
    writeHours: (window, records) => { covering = '2026-09-02T00:00:00.000Z'; onWrite(records) },
  })
}

test('a plain query never fetches work hours', async () => {
  let fetched = 0
  const { handleQuery } = createHandlers({
    hours: async () => { fetched += 1; return [] },
    store: hoursStore({ cached: '2026-09-02T00:00:00.000Z' }),
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ method: 'POST', body: JSON.stringify({ startDate: '2026-08-01', endDate: '2026-08-31' }) }), response)

  assert.equal(fetched, 0, '普通查询不该拉报工')
  assert.deepEqual(JSON.parse(response.body).hours, { 18051: 16 }, '已缓存的工时应随查询返回')
})

test('a plain query fills a missing work-hour cache for its date range', async () => {
  let fetched = 0
  const { handleQuery } = createHandlers({
    hours: async () => { fetched += 1; return [] },
    store: hoursStore({ cached: undefined }),
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ method: 'POST', body: JSON.stringify({ startDate: '2026-08-01', endDate: '2026-08-31' }) }), response)

  assert.equal(fetched, 1, '当前窗口没有工时缓存时应自动补齐')
  assert.deepEqual(JSON.parse(response.body).hours, { 18051: 16 }, '补齐后应立即返回工时，不再显示「—」')
})

test('a sync fetches and stores work hours alongside the plans', async () => {
  const written = []
  const { handleQuery } = createHandlers({
    query: async () => [],
    hours: async () => [{ id: 1, planId: 18051, workDate: '2026-08-05', hours: 8 }],
    store: hoursStore({ cached: '2026-09-02T00:00:00.000Z', onWrite: (records) => written.push(records.length) }),
  })
  const response = makeResponse()

  await handleQuery(makeRequest({ method: 'POST', body: JSON.stringify({ startDate: '2026-08-01', endDate: '2026-08-31', refresh: true }) }), response)

  assert.deepEqual(written, [1], '同步应同时写入报工')
})

/*
 * 邮件提醒接口。这些路由触及私有数据（收件地址、模板正文、SMTP 凭据），
 * 因此每条断言都围绕同一个不变量：账号只能由服务端从 mes auth status 现取，
 * 浏览器既不能提交 profileKey，也不该在任何响应里看到真实邮箱或密码。
 */

import { profileKey } from '../src/mail-store.js'

const ACCOUNT = 'tester@example.invalid'
const PROFILE = profileKey(ACCOUNT)
const WORKBOOK_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const mailSettings = {
  senderName: '交付中心',
  senderEmail: 'noreply@example.invalid',
  smtpHost: 'smtp.example.invalid',
  smtpPort: 465,
  securityMode: 'tls',
  smtpUsername: 'noreply@example.invalid',
  subjectTemplate: '{{executorName}}：{{planCount}} 个逾期计划',
  bodyTemplate: '执行人：{{executorName}}\n{{planList}}',
}

const mailMappings = [
  { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
  { executorId: '1002', executorName: '李四', email: 'lisi@example.invalid' },
]

function mailRequest(options = {}) {
  const request = makeRequest(options)
  request.url = options.url ?? '/'
  return request
}

/** 只记录调用，不落盘：路由测试不应创建任何 .db 文件。 */
function fakeMailStore(seed = {}) {
  const state = { settings: new Map(), mappings: new Map(), history: new Map(), calls: [] }
  if (seed.settings) state.settings.set(PROFILE, seed.settings)
  if (seed.mappings) state.mappings.set(PROFILE, seed.mappings)
  if (seed.history) state.history.set(PROFILE, seed.history)
  return {
    state,
    readSettings(profile) { state.calls.push(['readSettings', profile]); return state.settings.get(profile) },
    writeSettings(profile, value) { state.calls.push(['writeSettings', profile]); state.settings.set(profile, value) },
    listMappings(profile) { state.calls.push(['listMappings', profile]); return state.mappings.get(profile) ?? [] },
    replaceMappings(profile, rows) {
      state.calls.push(['replaceMappings', profile])
      if (rows.some((row) => row.email === '')) throw new Error('邮箱映射包含无效行')
      state.mappings.set(profile, rows)
    },
    deleteMapping(profile, executorId) {
      state.calls.push(['deleteMapping', profile])
      const rows = state.mappings.get(profile) ?? []
      state.mappings.set(profile, rows.filter((row) => row.executorId !== executorId))
      return rows.length !== (state.mappings.get(profile) ?? []).length
    },
    writeBatch(profile, batch) { state.calls.push(['writeBatch', profile]); state.history.set(profile, [batch]); return 1 },
    listHistory(profile) { state.calls.push(['listHistory', profile]); return state.history.get(profile) ?? [] },
    clearHistory(profile) {
      state.calls.push(['clearHistory', profile])
      const removed = (state.history.get(profile) ?? []).length
      state.history.delete(profile)
      return removed
    },
  }
}

function mailHandlers(overrides = {}) {
  const passwords = new Map(overrides.passwords ?? [[PROFILE, 'stored-pass']])
  const mailStore = overrides.mailStore ?? fakeMailStore({ settings: mailSettings, mappings: mailMappings })
  const sent = []
  const deps = {
    readAuth: overrides.readAuth ?? (async () => ({ loggedIn: true, account: ACCOUNT })),
    // 姓名 -> ID 的索引来自计划缓存；注入假的，避免测试创建真实 .db 文件。
    store: overrides.store ?? (() => ({
      readPlans: () => [{
        executorList: [
          { executorId: 1001, executorName: '张三' },
          { executorId: 1002, executorName: '李四' },
          { executorId: 1003, executorName: '王五' },
        ],
      }],
    })),
    mailStore: () => mailStore,
    readMailPassword: async (profile) => passwords.get(profile),
    saveMailPassword: async (profile, password) => { passwords.set(profile, password) },
    removeMailPassword: async (profile) => passwords.delete(profile),
    lookupPlan: overrides.lookupPlan ?? (async (id) => ({
      id,
      status: 3,
      companyName: `客户 ${id}`,
      title: `计划 ${id}`,
      checkTypeName: '现场交付',
      endDate: '2026-08-01 18:00:00',
      executorList: [{ executorId: '1001', executorName: '张三' }],
    })),
    makeTransport: overrides.makeTransport ?? (() => ({
      async sendMail(message) { sent.push(message); return { accepted: [message.to] } },
    })),
    sendTest: overrides.sendTest ?? (async () => ({ ok: true })),
    ...overrides.deps,
  }
  return { handlers: createHandlers(deps), mailStore, passwords, sent }
}

async function call(handler, options) {
  const response = makeResponse()
  await handler(mailRequest(options), response)
  return response
}

test('rejects every mail request from a logged-out session', async () => {
  const mailStore = fakeMailStore({ settings: mailSettings })
  const { handlers } = mailHandlers({ mailStore, readAuth: async () => ({ loggedIn: false, account: '' }) })
  const probes = [
    ['handleMailSettings', { method: 'GET' }],
    ['handleMailSettingsTest', { method: 'POST', body: '{}' }],
    ['handleMailPassword', { method: 'DELETE' }],
    ['handleMailMappings', { method: 'GET' }],
    ['handleMailMappingTemplate', { method: 'GET' }],
    ['handleMailMappingExport', { method: 'GET' }],
    ['handleMailImportPreview', { method: 'POST', contentType: WORKBOOK_TYPE, body: 'x' }],
    ['handleMailImportCommit', { method: 'POST', body: '{}' }],
    ['handleMailPreview', { method: 'POST', body: '{}' }],
    ['handleMailSend', { method: 'POST', body: '{}' }],
    ['handleMailRetry', { method: 'POST', body: '{}' }],
    ['handleMailHistory', { method: 'GET' }],
  ]

  for (const [name, options] of probes) {
    const response = await call(handlers[name], options)
    assert.equal(response.statusCode, 401, `${name} 未登录时必须拒绝`)
    assert.deepEqual(JSON.parse(response.body), { ok: false, error: '请先登录 MES 后再使用邮件提醒' })
  }
  // 未登录时连一次读取都不该发生，否则等于用别人的 profileKey 读数据。
  assert.deepEqual(mailStore.state.calls, [])
})

test('reports an unreadable auth probe as a gateway failure, not as logged out', async () => {
  const { handlers } = mailHandlers({ readAuth: async () => { throw new Error('mes 不存在') } })
  const response = await call(handlers.handleMailSettings, { method: 'GET' })

  assert.equal(response.statusCode, 502)
  assert.doesNotMatch(response.body, /mes 不存在/)
})

test('derives the profile key from MES auth and refuses one supplied by the browser', async () => {
  const { handlers, mailStore } = mailHandlers()
  const response = await call(handlers.handleMailSettings, {
    method: 'PUT',
    body: JSON.stringify({ ...mailSettings, profileKey: 'attacker' }),
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '邮件设置包含未知字段' })
  assert.equal(mailStore.state.calls.some(([name]) => name === 'writeSettings'), false)
})

test('scopes every mail read to the authenticated account', async () => {
  const mailStore = fakeMailStore({ settings: mailSettings, mappings: mailMappings })
  const { handlers } = mailHandlers({ mailStore, readAuth: async () => ({ loggedIn: true, account: 'other@example.invalid' }) })

  const response = await call(handlers.handleMailMappings, { method: 'GET' })

  // 换个 MES 账号后看到的是空表，而不是上一个账号的私有映射。
  assert.deepEqual(JSON.parse(response.body), { ok: true, mappings: [] })
  assert.deepEqual(mailStore.state.calls, [['listMappings', profileKey('other@example.invalid')]])
})

test('rejects unsupported methods and content types on mail settings', async () => {
  const { handlers } = mailHandlers()

  const wrongMethod = await call(handlers.handleMailSettings, { method: 'POST', body: '{}' })
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.headers.allow, 'GET, PUT')

  const wrongType = await call(handlers.handleMailSettings, { method: 'PUT', contentType: 'text/plain', body: '{}' })
  assert.equal(wrongType.statusCode, 415)
})

test('rejects a mail settings body over the JSON limit', async () => {
  const { handlers } = mailHandlers()
  const response = await call(handlers.handleMailSettings, {
    method: 'PUT',
    body: JSON.stringify({ ...mailSettings, senderName: 'x'.repeat(17 * 1024) }),
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '请求体不能超过 16 KiB' })
})

test('never returns a stored password, only whether one exists', async () => {
  const { handlers } = mailHandlers()
  const response = await call(handlers.handleMailSettings, { method: 'GET' })

  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  assert.deepEqual(payload, { ok: true, settings: mailSettings, hasPassword: true })
  assert.doesNotMatch(response.body, /stored-pass/)
})

test('saves settings without a password and keeps the stored secret', async () => {
  const { handlers, passwords, mailStore } = mailHandlers()
  const response = await call(handlers.handleMailSettings, {
    method: 'PUT',
    body: JSON.stringify({ ...mailSettings, senderName: '交付二部' }),
  })

  assert.equal(response.statusCode, 200)
  assert.equal(passwords.get(PROFILE), 'stored-pass', '未提交新密码时不得覆盖钥匙串')
  assert.equal(mailStore.state.settings.get(PROFILE).senderName, '交付二部')
})

test('writes a submitted password to the keychain and not to the database', async () => {
  const { handlers, passwords, mailStore } = mailHandlers()
  await call(handlers.handleMailSettings, {
    method: 'PUT',
    body: JSON.stringify({ ...mailSettings, password: 'new-pass' }),
  })

  assert.equal(passwords.get(PROFILE), 'new-pass')
  assert.equal(Object.hasOwn(mailStore.state.settings.get(PROFILE), 'password'), false)
})

test('clears only the current profile password', async () => {
  const { handlers, passwords } = mailHandlers({ passwords: [[PROFILE, 'a'], ['other', 'b']] })
  const response = await call(handlers.handleMailPassword, { method: 'DELETE' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, hasPassword: false })
  assert.equal(passwords.has(PROFILE), false)
  assert.equal(passwords.get('other'), 'b')
})

test('sends a test mail with the submitted settings and a one-off recipient', async () => {
  const calls = []
  const { handlers, mailStore } = mailHandlers({ sendTest: async (input) => { calls.push(input); return { ok: true } } })
  const response = await call(handlers.handleMailSettingsTest, {
    method: 'POST',
    body: JSON.stringify({ ...mailSettings, recipient: 'me@example.invalid' }),
  })

  assert.equal(response.statusCode, 200)
  assert.equal(calls[0].recipient, 'me@example.invalid')
  assert.equal(calls[0].password, 'stored-pass', '未提交密码时用钥匙串里的旧密码')
  // 测试地址仅用于当次请求，绝不写入设置或映射。
  assert.equal(mailStore.state.calls.some(([name]) => name === 'writeSettings'), false)
})

test('reports a redacted SMTP failure from the test endpoint', async () => {
  const { handlers } = mailHandlers({
    sendTest: async () => { throw new Error('SMTP 认证失败，请检查用户名或授权码') },
  })
  const response = await call(handlers.handleMailSettingsTest, {
    method: 'POST',
    body: JSON.stringify({ ...mailSettings, recipient: 'me@example.invalid' }),
  })

  assert.equal(response.statusCode, 502)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'SMTP 认证失败，请检查用户名或授权码' })
})

test('replaces and deletes executor mappings for the current profile', async () => {
  const { handlers, mailStore } = mailHandlers()

  const replaced = await call(handlers.handleMailMappings, {
    method: 'PUT',
    body: JSON.stringify({ mappings: [{ executorId: 1001, executorName: ' 张三 ', email: ' zhangsan@example.invalid ' }] }),
  })
  assert.equal(replaced.statusCode, 200)
  assert.deepEqual(mailStore.state.mappings.get(PROFILE), [
    { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
  ])

  const deleted = await call(handlers.handleMailMappings, { method: 'DELETE', url: '/x?executorId=1001' })
  assert.equal(deleted.statusCode, 200)
  assert.deepEqual(mailStore.state.mappings.get(PROFILE), [])
})

test('rejects unknown fields inside a mapping row', async () => {
  const { handlers, mailStore } = mailHandlers()
  const response = await call(handlers.handleMailMappings, {
    method: 'PUT',
    body: JSON.stringify({ mappings: [{ executorId: '1', executorName: 'a', email: 'a@example.invalid', note: 'x' }] }),
  })

  assert.equal(response.statusCode, 400)
  assert.equal(mailStore.state.calls.some(([name]) => name === 'replaceMappings'), false)
})

test('serves the mapping template and export as no-store attachments', async () => {
  const { handlers } = mailHandlers()

  for (const name of ['handleMailMappingTemplate', 'handleMailMappingExport']) {
    const response = await call(handlers[name], { method: 'GET' })
    assert.equal(response.statusCode, 200, name)
    assert.equal(response.headers['content-type'], WORKBOOK_TYPE, name)
    assert.match(response.headers['content-disposition'], /^attachment; filename="[^"]+\.xlsx"$/, name)
    // 导出内容含真实邮箱，不允许被任何中间层缓存。
    assert.equal(response.headers['cache-control'], 'no-store', name)
  }
})

test('bounds a workbook upload separately from the JSON limit', async () => {
  const { handlers } = mailHandlers()
  const response = await call(handlers.handleMailImportPreview, {
    method: 'POST',
    contentType: WORKBOOK_TYPE,
    body: Buffer.alloc(2 * 1024 * 1024 + 1),
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '上传文件不能超过 2 MiB' })
})

test('imports a workbook only through a one-time preview token', async () => {
  const { exportMappings } = await import('../src/mail-mappings.js')
  const mailStore = fakeMailStore({ settings: mailSettings, mappings: mailMappings })
  const { handlers } = mailHandlers({ mailStore })
  const workbook = Buffer.from(await exportMappings([
    { executorId: '1003', executorName: '王五', email: 'wangwu@example.invalid' },
  ]))

  const preview = await call(handlers.handleMailImportPreview, { method: 'POST', contentType: WORKBOOK_TYPE, body: workbook })
  assert.equal(preview.statusCode, 200)
  const { token, added, canCommit } = JSON.parse(preview.body)
  assert.equal(canCommit, true)
  assert.equal(added.length, 1)
  assert.equal(mailStore.state.calls.some(([name]) => name === 'replaceMappings'), false, '预览阶段零写入')

  const commit = await call(handlers.handleMailImportCommit, { method: 'POST', body: JSON.stringify({ token }) })
  assert.equal(commit.statusCode, 200)
  // 合并而非整表替换：文件里没有的执行人不该被静默删除。
  assert.deepEqual(mailStore.state.mappings.get(PROFILE).map((row) => row.executorId), ['1001', '1002', '1003'])

  const replay = await call(handlers.handleMailImportCommit, { method: 'POST', body: JSON.stringify({ token }) })
  assert.equal(replay.statusCode, 400)
})

test('refuses to commit an import whose preview reported row errors', async () => {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('邮箱映射')
  sheet.addRow(['执行人 ID', '执行人姓名', '邮箱地址'])
  sheet.addRow(['1003', '王五', 'not-an-address'])
  const mailStore = fakeMailStore({ settings: mailSettings, mappings: mailMappings })
  const { handlers } = mailHandlers({ mailStore })

  const preview = await call(handlers.handleMailImportPreview, {
    method: 'POST',
    contentType: WORKBOOK_TYPE,
    body: Buffer.from(await workbook.xlsx.writeBuffer()),
  })

  assert.equal(preview.statusCode, 200)
  const payload = JSON.parse(preview.body)
  assert.equal(payload.canCommit, false)
  assert.equal(payload.errors.length, 1)
  assert.equal(payload.token, undefined, '有错误时不得签发导入令牌')
  // 一行非法就整份零写入，不允许「导入成功 3 行、失败 1 行」。
  assert.equal(mailStore.state.calls.some(([name]) => name === 'replaceMappings'), false)
})

test('returns a preview token and only masked recipients', async () => {
  const { handlers } = mailHandlers()
  const response = await call(handlers.handleMailPreview, { method: 'POST', body: JSON.stringify({ planIds: [1, 2] }) })

  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  assert.equal(typeof payload.token, 'string')
  assert.equal(payload.groups.length, 1)
  assert.equal(payload.groups[0].maskedEmail, 'z***@example.invalid')
  // 真实收件地址永远不出现在响应里。
  assert.doesNotMatch(response.body, /zhangsan@example\.invalid/)
})

test('reports a MES lookup failure during preview as a gateway error', async () => {
  const { handlers } = mailHandlers({
    lookupPlan: async () => { throw new Error('MES 查询计划失败，请稍后重试') },
  })
  const response = await call(handlers.handleMailPreview, { method: 'POST', body: JSON.stringify({ planIds: [1] }) })

  assert.equal(response.statusCode, 502)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'MES 查询计划失败，请稍后重试' })
})

test('rejects a preview selection that is not a list of positive plan ids', async () => {
  const { handlers } = mailHandlers()

  for (const planIds of [[], ['1'], [0], [1.5]]) {
    const response = await call(handlers.handleMailPreview, { method: 'POST', body: JSON.stringify({ planIds }) })
    assert.equal(response.statusCode, 400, JSON.stringify(planIds))
  }
})

test('sends a confirmed preview and records it in history', async () => {
  const { handlers, mailStore, sent } = mailHandlers()
  const preview = await call(handlers.handleMailPreview, { method: 'POST', body: JSON.stringify({ planIds: [1] }) })
  const { token } = JSON.parse(preview.body)

  const response = await call(handlers.handleMailSend, { method: 'POST', body: JSON.stringify({ token }) })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(sent.map((message) => message.to), ['zhangsan@example.invalid'])
  const payload = JSON.parse(response.body)
  assert.equal(payload.succeeded, 1)
  assert.equal(payload.failed, 0)
  assert.equal(mailStore.state.calls.some(([name, profile]) => name === 'writeBatch' && profile === PROFILE), true)
})

test('retries only the failed groups with the returned retry token', async () => {
  let attempts = 0
  const { handlers, sent } = mailHandlers({
    makeTransport: () => ({
      async sendMail(message) {
        attempts += 1
        // 首封认证失败（不重试），重试那一封放行。
        if (attempts === 1) throw Object.assign(new Error('down'), { code: 'EAUTH' })
        sent.push(message)
        return { accepted: [message.to] }
      },
    }),
  })
  const preview = await call(handlers.handleMailPreview, { method: 'POST', body: JSON.stringify({ planIds: [1] }) })
  const send = await call(handlers.handleMailSend, { method: 'POST', body: JSON.stringify({ token: JSON.parse(preview.body).token }) })
  const { retryToken, failed } = JSON.parse(send.body)

  assert.equal(failed, 1)
  assert.equal(typeof retryToken, 'string')

  const retry = await call(handlers.handleMailRetry, { method: 'POST', body: JSON.stringify({ token: retryToken }) })
  assert.equal(retry.statusCode, 200)
  assert.equal(JSON.parse(retry.body).succeeded, 1)
})

test('refuses to send when the profile has no stored password', async () => {
  const { handlers, sent } = mailHandlers({ passwords: [] })
  const response = await call(handlers.handleMailPreview, { method: 'POST', body: JSON.stringify({ planIds: [1] }) })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: '请先在邮件设置中保存 SMTP 密码' })
  assert.deepEqual(sent, [])
})

test('lists and clears profile-scoped send history', async () => {
  const mailStore = fakeMailStore({
    settings: mailSettings,
    mappings: mailMappings,
    history: [{ createdAt: '2026-09-02T10:00:00.000Z', totalMessages: 1, succeeded: 1, failed: 0, results: [] }],
  })
  const { handlers } = mailHandlers({ mailStore })

  const listed = await call(handlers.handleMailHistory, { method: 'GET' })
  assert.equal(JSON.parse(listed.body).history.length, 1)

  const cleared = await call(handlers.handleMailHistory, { method: 'DELETE' })
  assert.equal(cleared.statusCode, 200)
  assert.deepEqual(JSON.parse(cleared.body), { ok: true, removed: 1, history: [] })
})
