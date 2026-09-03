import Schema from '@deepseek-ai/schemastery'

import { queryPlans } from './plan-query.js'
import { renderPage } from './page.js'
import { readConfig, writeConfig } from './config.js'
import { isUpdating, readAuthStatus, readCliVersion, readMesVersion, readUpdateStatus, runMesUpdate, setHostMesPath } from './mes-cli.js'
import { PlanStore } from './plan-store.js'
import { queryWorkHours } from './work-hours.js'
import { checkPluginUpdate, pullPluginUpdate, readPluginVersion } from './self-update.js'
import { queryPlanById } from './plan-query.js'
import { MailStore, profileKey } from './mail-store.js'
import { validateMailSettings } from './mail-settings.js'
import { deletePassword, readPassword, writePassword } from './keychain.js'
import {
  buildExecutorIndex, createMappingTemplate, exportMappings, ImportPreviewStore,
  parseMappingWorkbook, previewMappingImport, resolveMappingRows,
} from './mail-mappings.js'
import { MailPreviewStore, revalidateAndBuildMailPreview } from './mail-preview.js'
import { createTransport, sendTestMail } from './mailer.js'
import { retryFailedBatch, sendPreviewBatch } from './mail-service.js'

/** 进程内共用一个 store；懒创建让没查过的机器上不出现 .db 文件。 */
let sharedStore
function defaultStore() {
  sharedStore ??= new PlanStore()
  return sharedStore
}

/** 邮件数据独立于可重建的 plans.db，清缓存不会碰它。 */
let sharedMailStore
function defaultMailStore() {
  sharedMailStore ??= new MailStore()
  return sharedMailStore
}

const MAX_BODY_BYTES = 16 * 1024
// Excel 走独立的、比 JSON 宽的上限，两者互不放宽对方。
const MAX_WORKBOOK_BYTES = 2 * 1024 * 1024
const WORKBOOK_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const WORKBOOK_CONTENT_TYPE = /^application\/(?:vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream)(?:\s*;|$)/i
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i

class RequestError extends Error {}
/** 上游（MES、SMTP、钥匙串）失败：文案已在各模块脱敏，可以原样回给用户。 */
class GatewayError extends Error {}
class AuthError extends Error {}

function writeJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(payload))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk)
      if (size > MAX_BODY_BYTES) throw new RequestError('请求体不能超过 16 KiB')
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof RequestError) throw error
    throw new RequestError('请求体读取失败')
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RequestError('请求体必须是有效 JSON')
  }
}

/** 多选筛选项：空数组表示不限；值域固定，不接受任意数字。 */
function validateCodes(value, allowed, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new RequestError(`${label}无效`)
  if (value.some((code) => typeof code !== 'string' || !allowed.includes(code))) throw new RequestError(`${label}无效`)
  return [...new Set(value)]
}

function validateInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('请求参数无效')
  if (Object.keys(body).some((key) => !['startDate', 'endDate', 'statuses', 'checkTypes', 'refresh'].includes(key))) throw new RequestError('请求参数无效')
  if (body.refresh !== undefined && typeof body.refresh !== 'boolean') throw new RequestError('请求参数无效')
  if (body.startDate === undefined || body.startDate === '') throw new RequestError('开始日期不能为空')
  if (typeof body.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) throw new RequestError('开始日期格式错误')
  if (body.endDate === undefined || body.endDate === '') throw new RequestError('结束日期不能为空')
  if (typeof body.endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate)) throw new RequestError('结束日期格式错误')
  if (body.startDate > body.endDate) throw new RequestError('开始日期不能晚于结束日期')
  return {
    startDate: body.startDate,
    endDate: body.endDate,
    statuses: validateCodes(body.statuses, ['0', '1', '3'], '状态值'),
    checkTypes: validateCodes(body.checkTypes, ['0', '1', '2', '3', '4', '5', '6'], '类型值'),
    refresh: body.refresh === true,
  }
}

/**
 * 计划全量缓存在本地，查询只读本地。
 *
 * 同步一次把 MES 上的计划全部取回并整表替换，因此本地就是完整副本：任意日期窗口、
 * 任意状态与类型组合都能直接筛，不需要判断「缓存范围是否覆盖这次查询」，也不会因为
 * 同步窗口比查询窗口窄而漏掉跨界的计划。删除检测同样是平凡的——这次没返回的就是
 * 已删除的。
 */
const FULL_RANGE = { startDate: '2000-01-01', endDate: '2099-12-31', status: '' }

async function resolvePlans({ startDate, endDate, statuses, checkTypes, refresh }, query, store, hours) {
  const window = { startDate, endDate }
  const filter = { startDate, endDate, statuses, checkTypes }
  const cached = store.lastSync()
  const cachedHours = store.findCoveringHours(window)

  // 从未同步过的机器上，第一次查询顺带把全量取回来，不打断用户。
  if (refresh || cached === undefined) {
    store.replaceAllPlans(await query(FULL_RANGE))
  }
  // 报工按查询窗口取：它比计划多一个数量级，全量会是几十分钟。已有覆盖缓存
  // 时不重复请求；首次查询某个窗口则补齐，避免表格长期显示「—」。
  if (refresh || cachedHours === undefined) store.writeHours(window, await hours(window))

  return {
    plans: store.readPlans(filter),
    syncedAt: store.lastSync(),
    fromCache: !refresh && cached !== undefined,
    hours: store.readHours(window),
  }
}

function validateConfigInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('请求参数无效')
  if (Object.keys(body).some((key) => key !== 'mesPath')) throw new RequestError('请求参数无效')
  if (typeof body.mesPath !== 'string') throw new RequestError('mes 路径必须是字符串')
  return body.mesPath
}

async function readWorkbook(request) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk)
      if (size > MAX_WORKBOOK_BYTES) throw new RequestError('上传文件不能超过 2 MiB')
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof RequestError) throw error
    throw new RequestError('请求体读取失败')
  }
  if (chunks.length === 0) throw new RequestError('请选择要导入的 Excel 文件')
  return Buffer.concat(chunks)
}

function writeWorkbook(response, buffer, filename) {
  const body = Buffer.from(buffer)
  response.writeHead(200, {
    'content-type': WORKBOOK_MEDIA_TYPE,
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': String(body.length),
    // 导出内容含真实邮箱，不允许被任何中间层缓存。
    'cache-control': 'no-store',
  })
  response.end(body)
}

function allowFields(body, fields, label = '请求参数无效') {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(label)
  if (Object.keys(body).some((key) => !fields.includes(key))) throw new RequestError(label)
  return body
}

function queryParam(request, name) {
  const url = request.url ?? ''
  const separator = url.indexOf('?')
  return separator === -1 ? '' : (new URLSearchParams(url.slice(separator + 1)).get(name) ?? '')
}

/** 把同步校验器抛出的领域错误统一变成 400。 */
function validated(run) {
  try {
    return run()
  } catch (error) {
    throw new RequestError(error.message)
  }
}

function requireToken(body) {
  return validated(() => {
    const input = allowFields(body, ['token'])
    if (typeof input.token !== 'string' || input.token.trim() === '') throw new Error('令牌无效或已过期')
    return input.token
  })
}

function requirePlanIds(body) {
  const input = allowFields(body, ['planIds'])
  if (!Array.isArray(input.planIds) || input.planIds.length === 0) throw new RequestError('请选择至少一条计划')
  if (input.planIds.length > 500) throw new RequestError('单次最多选择 500 条计划')
  if (input.planIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new RequestError('计划 ID 无效')
  return [...new Set(input.planIds)]
}

/**
 * 邮件接口的统一前置。账号一律现取自 mes auth status 再派生 profileKey：浏览器既不能
 * 提交它，也不会在任何响应里看到它——这是不同 MES 账号数据互不可见的唯一依据。
 */
function mailRoute({ methods, contentType = JSON_CONTENT_TYPE, gatewayError }, readAuth, handler) {
  const allow = methods.join(', ')
  return async (request, response) => {
    if (!methods.includes(request.method)) {
      writeJson(response, 405, { ok: false, error: `仅支持 ${allow} 请求` }, { allow })
      return
    }
    const carriesBody = request.method !== 'GET' && request.method !== 'DELETE'
    if (carriesBody && !contentType.test(request.headers['content-type'] ?? '')) {
      writeJson(response, 415, { ok: false, error: '请求类型不受支持' })
      return
    }
    let profile
    try {
      const auth = await readAuth()
      if (auth?.loggedIn !== true || typeof auth.account !== 'string' || auth.account.trim() === '') {
        throw new AuthError('请先登录 MES 后再使用邮件提醒')
      }
      profile = profileKey(auth.account)
    } catch (error) {
      if (error instanceof AuthError) writeJson(response, 401, { ok: false, error: error.message })
      else writeJson(response, 502, { ok: false, error: '无法读取 MES 登录状态，请检查 mes 路径配置' })
      return
    }
    try {
      await handler({ request, response, profile })
    } catch (error) {
      if (error instanceof RequestError) writeJson(response, 400, { ok: false, error: error.message })
      else if (error instanceof GatewayError) writeJson(response, 502, { ok: false, error: error.message })
      else writeJson(response, 502, { ok: false, error: gatewayError })
    }
  }
}

/**
 * Harness「设置 → 插件 → 插件配置」表单的模式。
 *
 * 只放非机密的 mes 路径：SMTP 密码、邮箱映射和发送历史都不能写进 Harness 的
 * 配置文件，它们分别属于钥匙串和插件自己的 mail.db。
 */
export const Config = Schema.object({
  mesPath: Schema.string().default('').description('mes CLI 的绝对路径；留空则使用 PATH。'),
})

export function createHandlers({
  query = queryPlans,
  loadConfig = readConfig,
  saveConfig = writeConfig,
  readVersion = readMesVersion,
  readAuth = readAuthStatus,
  readCliStatus = readUpdateStatus,
  readCliInfo = readCliVersion,
  updateCli = runMesUpdate,
  cliBusy = isUpdating,
  store = defaultStore,
  hours = queryWorkHours,
  readPlugin = readPluginVersion,
  checkPlugin = checkPluginUpdate,
  updatePlugin = pullPluginUpdate,
  mailStore = defaultMailStore,
  readMailPassword = readPassword,
  saveMailPassword = writePassword,
  removeMailPassword = deletePassword,
  lookupPlan = queryPlanById,
  makeTransport = createTransport,
  sendTest = sendTestMail,
  sendBatch = sendPreviewBatch,
  retryBatch = retryFailedBatch,
  buildPreview = revalidateAndBuildMailPreview,
  previewStore = new MailPreviewStore(),
  importStore = new ImportPreviewStore(),
} = {}) {
  /** MES 故障与「选择不合法」必须分开：前者 502，后者 400。 */
  const lookup = async (id) => {
    try {
      return await lookupPlan(id)
    } catch (error) {
      throw new GatewayError(error.message || 'MES 查询计划失败，请稍后重试')
    }
  }

  /** 姓名 -> executorId[]：由本地计划缓存反查，用户因此不必知道 MES 的内部 ID。 */
  function executorIndex() {
    return buildExecutorIndex(store().readPlans({ startDate: FULL_RANGE.startDate, endDate: FULL_RANGE.endDate }))
  }

  async function passwordOf(profile) {
    try {
      return await readMailPassword(profile)
    } catch {
      throw new GatewayError('无法读取 SMTP 密码')
    }
  }

  /** 发送与重试只差一个编排函数，其余前置完全一致。 */
  async function runBatch(run, { request, response, profile }) {
    const token = requireToken(await readJson(request))
    const settings = mailStore().readSettings(profile)
    if (settings === undefined) throw new RequestError('请先完成邮件设置')
    const password = await passwordOf(profile)
    if (password === undefined) throw new RequestError('请先在邮件设置中保存 SMTP 密码')
    const transport = validated(() => makeTransport(settings, password))
    const result = await run({
      profileKey: profile,
      token,
      previewStore,
      mappings: mailStore().listMappings(profile),
      settings,
      store: mailStore(),
      transport,
      query: lookup,
    })
    writeJson(response, 200, { ok: true, ...result })
  }

  return {
    async handlePage(request, response) {
      if (request.method !== 'GET') {
        writeJson(response, 405, { ok: false, error: '仅支持 GET 请求' }, { allow: 'GET' })
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(renderPage())
    },
    async handleQuery(request, response) {
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: '仅支持 POST 请求' }, { allow: 'POST' })
        return
      }
      if (!JSON_CONTENT_TYPE.test(request.headers['content-type'] ?? '')) {
        writeJson(response, 415, { ok: false, error: '仅支持 JSON 请求' })
        return
      }
      // 更新会替换正在使用的二进制，此刻发起查询会以难懂的方式失败。
      if (cliBusy()) {
        writeJson(response, 503, { ok: false, error: 'mes 正在更新，请稍后重试' })
        return
      }
      let input
      try {
        input = validateInput(await readJson(request))
      } catch (error) {
        writeJson(response, 400, { ok: false, error: error instanceof RequestError ? error.message : '请求参数无效' })
        return
      }
      try {
        writeJson(response, 200, { ok: true, ...(await resolvePlans(input, query, store(), hours)) })
      } catch {
        writeJson(response, 502, { ok: false, error: 'MES 查询失败，请稍后重试' })
      }
    },
    async handleConfig(request, response) {
      if (request.method === 'GET') {
        writeJson(response, 200, { ok: true, ...(await loadConfig()) })
        return
      }
      if (request.method !== 'PUT') {
        writeJson(response, 405, { ok: false, error: '仅支持 GET 或 PUT 请求' }, { allow: 'GET, PUT' })
        return
      }
      if (!JSON_CONTENT_TYPE.test(request.headers['content-type'] ?? '')) {
        writeJson(response, 415, { ok: false, error: '仅支持 JSON 请求' })
        return
      }
      let mesPath
      try {
        mesPath = validateConfigInput(await readJson(request))
      } catch (error) {
        writeJson(response, 400, { ok: false, error: error instanceof RequestError ? error.message : '请求参数无效' })
        return
      }
      // 保存前先确认这个路径确实是 mes：这个字段决定 Host 执行哪个二进制，
      // 只检查路径格式等于允许把任意程序配成 mes。留空表示改回用 PATH。
      let version = ''
      try {
        if (mesPath.trim() !== '') version = await readVersion(mesPath.trim())
      } catch (error) {
        writeJson(response, 400, { ok: false, error: error.message })
        return
      }
      try {
        writeJson(response, 200, { ok: true, ...(await saveConfig({ mesPath })), version })
      } catch (error) {
        writeJson(response, 400, { ok: false, error: error.message })
      }
    },
    async handleAuth(request, response) {
      if (request.method !== 'GET') {
        writeJson(response, 405, { ok: false, error: '仅支持 GET 请求' }, { allow: 'GET' })
        return
      }
      try {
        writeJson(response, 200, { ok: true, ...(await readAuth()) })
      } catch {
        writeJson(response, 502, { ok: false, error: '无法读取 MES 登录状态，请检查 mes 路径配置' })
      }
    },
    async handlePlugin(request, response) {
      if (request.method !== 'GET') {
        writeJson(response, 405, { ok: false, error: '仅支持 GET 请求' }, { allow: 'GET' })
        return
      }
      // 与 mes 那块一致：打开页面只读本地版本，联网检查要用户点。
      const check = request.url !== undefined && request.url.includes('check=1')
      try {
        writeJson(response, 200, { ok: true, ...(await (check ? checkPlugin() : readPlugin())) })
      } catch (error) {
        writeJson(response, 502, {
          ok: false,
          error: check ? (error.message || '检查插件更新失败') : '无法读取插件版本，仓库可能不是 git 工作区',
        })
      }
    },
    async handlePluginUpdate(request, response) {
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: '仅支持 POST 请求' }, { allow: 'POST' })
        return
      }
      try {
        writeJson(response, 200, { ok: true, ...(await updatePlugin()) })
      } catch (error) {
        writeJson(response, 502, { ok: false, error: error.message || '插件更新失败' })
      }
    },
    async handleCache(request, response) {
      if (request.method === 'GET') {
        try {
          writeJson(response, 200, { ok: true, ...store().summary() })
        } catch {
          writeJson(response, 500, { ok: false, error: '无法读取缓存状态' })
        }
        return
      }
      if (request.method !== 'DELETE') {
        writeJson(response, 405, { ok: false, error: '仅支持 GET 或 DELETE 请求' }, { allow: 'GET, DELETE' })
        return
      }
      try {
        store().clear()
        writeJson(response, 200, { ok: true, ...store().summary() })
      } catch {
        writeJson(response, 500, { ok: false, error: '清空缓存失败' })
      }
    },
    async handleCli(request, response) {
      if (request.method !== 'GET') {
        writeJson(response, 405, { ok: false, error: '仅支持 GET 请求' }, { allow: 'GET' })
        return
      }
      // 默认只读本机版本；只有显式 check=1（用户点了「检查更新」）才联网。
      const check = request.url !== undefined && request.url.includes('check=1')
      try {
        writeJson(response, 200, { ok: true, ...(await (check ? readCliStatus() : readCliInfo())) })
      } catch {
        writeJson(response, 502, {
          ok: false,
          error: check ? '检查更新失败，请稍后重试' : '无法读取 mes 版本，请检查 mes 路径配置',
        })
      }
    },
    async handleCliUpdate(request, response) {
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: '仅支持 POST 请求' }, { allow: 'POST' })
        return
      }
      if (cliBusy()) {
        writeJson(response, 409, { ok: false, error: 'mes 正在更新，请稍候' })
        return
      }
      try {
        writeJson(response, 200, { ok: true, ...(await updateCli()) })
      } catch {
        writeJson(response, 502, { ok: false, error: 'mes 更新失败，请在终端执行 mes update 查看详情' })
      }
    },
    handleMailSettings: mailRoute({ methods: ['GET', 'PUT'], gatewayError: '保存邮件设置失败' }, readAuth, async ({ request, response, profile }) => {
      if (request.method === 'GET') {
        writeJson(response, 200, {
          ok: true,
          settings: mailStore().readSettings(profile) ?? null,
          hasPassword: (await passwordOf(profile)) !== undefined,
        })
        return
      }
      const body = await readJson(request)
      // validateMailSettings 自带字段白名单，浏览器提交的 profileKey 会在这里被拒。
      const settings = validated(() => validateMailSettings(body))
      // 未提交新密码即保留钥匙串里的旧密码，这是「改配置不必重输密码」的依据。
      if (typeof body.password === 'string' && body.password !== '') {
        try {
          await saveMailPassword(profile, body.password)
        } catch (error) {
          throw new GatewayError(error.message || '保存 SMTP 密码失败')
        }
      }
      mailStore().writeSettings(profile, settings)
      writeJson(response, 200, { ok: true, settings, hasPassword: (await passwordOf(profile)) !== undefined })
    }),
    handleMailSettingsTest: mailRoute({ methods: ['POST'], gatewayError: 'SMTP 发送失败' }, readAuth, async ({ request, response, profile }) => {
      const body = await readJson(request)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('请求参数无效')
      // 测试用当次提交的配置，让用户能在保存前先验证；收件地址只用于这一次请求。
      const { recipient, ...rest } = body
      const settings = validated(() => validateMailSettings(rest))
      const password = typeof rest.password === 'string' && rest.password !== '' ? rest.password : await passwordOf(profile)
      if (password === undefined) throw new RequestError('请先在邮件设置中保存 SMTP 密码')
      try {
        await sendTest({ settings, password, recipient }, {})
      } catch (error) {
        if (/地址无效|安全模式/.test(error.message)) throw new RequestError(error.message)
        throw new GatewayError(error.message || 'SMTP 发送失败')
      }
      writeJson(response, 200, { ok: true })
    }),
    handleMailPassword: mailRoute({ methods: ['DELETE'], gatewayError: '清除 SMTP 密码失败' }, readAuth, async ({ response, profile }) => {
      await removeMailPassword(profile)
      writeJson(response, 200, { ok: true, hasPassword: false })
    }),
    handleMailMappings: mailRoute({ methods: ['GET', 'PUT', 'DELETE'], gatewayError: '保存邮箱映射失败' }, readAuth, async ({ request, response, profile }) => {
      if (request.method === 'GET') {
        writeJson(response, 200, { ok: true, mappings: mailStore().listMappings(profile) })
        return
      }
      if (request.method === 'DELETE') {
        const executorId = queryParam(request, 'executorId').trim()
        if (executorId === '') throw new RequestError('执行人 ID 不能为空')
        const deleted = mailStore().deleteMapping(profile, executorId)
        writeJson(response, 200, { ok: true, deleted, mappings: mailStore().listMappings(profile) })
        return
      }
      const input = allowFields(await readJson(request), ['mappings'])
      if (!Array.isArray(input.mappings)) throw new RequestError('邮箱映射必须是数组')
      if (input.mappings.length > 5000) throw new RequestError('邮箱映射不能超过 5000 行')
      const rows = input.mappings.map((row) => {
        const fields = allowFields(row, ['executorId', 'executorName', 'email'], '邮箱映射字段无效')
        return {
          executorId: String(fields.executorId ?? '').trim(),
          executorName: String(fields.executorName ?? '').trim(),
          email: String(fields.email ?? '').trim(),
        }
      })
      validated(() => mailStore().replaceMappings(profile, rows))
      writeJson(response, 200, { ok: true, mappings: mailStore().listMappings(profile) })
    }),
    handleMailMappingTemplate: mailRoute({ methods: ['GET'], gatewayError: '生成导入模板失败' }, readAuth, async ({ response }) => {
      writeWorkbook(response, await createMappingTemplate([...executorIndex().keys()].sort()), 'mes-plan-list-email-template.xlsx')
    }),
    handleMailMappingExport: mailRoute({ methods: ['GET'], gatewayError: '导出邮箱映射失败' }, readAuth, async ({ response, profile }) => {
      writeWorkbook(response, await exportMappings(mailStore().listMappings(profile)), 'mes-plan-list-emails.xlsx')
    }),
    handleMailImportPreview: mailRoute({ methods: ['POST'], contentType: WORKBOOK_CONTENT_TYPE, gatewayError: '解析导入文件失败' }, readAuth, async ({ request, response, profile }) => {
      const buffer = await readWorkbook(request)
      let parsed
      try {
        parsed = await parseMappingWorkbook(buffer)
      } catch {
        throw new RequestError('无法解析该 Excel 文件')
      }
      const resolved = resolveMappingRows(parsed, executorIndex())
      const preview = previewMappingImport(mailStore().listMappings(profile), resolved)
      // 有任何行错误就不签发令牌，导入因此天然是零写入的。
      writeJson(response, 200, {
        ok: true,
        ...preview,
        token: preview.canCommit ? importStore.create(profile, preview) : undefined,
      })
    }),
    handleMailImportCommit: mailRoute({ methods: ['POST'], gatewayError: '写入邮箱映射失败' }, readAuth, async ({ request, response, profile }) => {
      const token = requireToken(await readJson(request))
      const preview = validated(() => importStore.consume(token, profile))
      // 按执行人 ID 合并：导入文件里没有的执行人不该被静默删除。
      const merged = new Map(mailStore().listMappings(profile).map((row) => [row.executorId, row]))
      for (const row of [...preview.added, ...preview.updated.map((change) => change.after), ...preview.unchanged]) {
        merged.set(row.executorId, row)
      }
      validated(() => mailStore().replaceMappings(profile, [...merged.values()]))
      writeJson(response, 200, { ok: true, mappings: mailStore().listMappings(profile) })
    }),
    handleMailPreview: mailRoute({ methods: ['POST'], gatewayError: '生成邮件预览失败' }, readAuth, async ({ request, response, profile }) => {
      const planIds = requirePlanIds(await readJson(request))
      const settings = mailStore().readSettings(profile)
      if (settings === undefined) throw new RequestError('请先完成邮件设置')
      if ((await passwordOf(profile)) === undefined) throw new RequestError('请先在邮件设置中保存 SMTP 密码')
      let preview
      try {
        preview = await buildPreview({ profileKey: profile, planIds, mappings: mailStore().listMappings(profile), settings }, lookup)
      } catch (error) {
        if (error instanceof GatewayError) throw error
        throw new RequestError(error.message)
      }
      // 响应只带掩码地址：真实收件人始终由服务端在发送时解析。
      writeJson(response, 200, { ok: true, token: previewStore.create(profile, preview), groups: preview.groups })
    }),
    handleMailSend: mailRoute({ methods: ['POST'], gatewayError: '邮件发送失败' }, readAuth, (context) => runBatch(sendBatch, context)),
    handleMailRetry: mailRoute({ methods: ['POST'], gatewayError: '邮件重试失败' }, readAuth, (context) => runBatch(retryBatch, context)),
    handleMailHistory: mailRoute({ methods: ['GET', 'DELETE'], gatewayError: '读取发送历史失败' }, readAuth, async ({ request, response, profile }) => {
      if (request.method === 'GET') {
        writeJson(response, 200, { ok: true, history: mailStore().listHistory(profile) })
        return
      }
      const removed = mailStore().clearHistory(profile)
      writeJson(response, 200, { ok: true, removed, history: mailStore().listHistory(profile) })
    }),
  }
}

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  // Harness 已按 Config 校验过类型，路径形状仍要再验一次：它决定执行哪个二进制。
  setHostMesPath(config.mesPath ?? '')
  const {
    handlePage, handleQuery, handleConfig, handleAuth,
    handleCli, handleCliUpdate, handleCache, handlePlugin, handlePluginUpdate,
    handleMailSettings, handleMailSettingsTest, handleMailPassword,
    handleMailMappings, handleMailMappingTemplate, handleMailMappingExport,
    handleMailImportPreview, handleMailImportCommit,
    handleMailPreview, handleMailSend, handleMailRetry, handleMailHistory,
  } = createHandlers()
  ctx.webServer.register({ kind: 'exact', path: '/plugins/mes-plan-list', handler: handlePage })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/query', handler: handleQuery })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/config', handler: handleConfig })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/auth', handler: handleAuth })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/cli', handler: handleCli })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/cli/update', handler: handleCliUpdate })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/cache', handler: handleCache })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/plugin', handler: handlePlugin })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/plugin/update', handler: handlePluginUpdate })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/settings', handler: handleMailSettings })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/settings/test', handler: handleMailSettingsTest })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/settings/password', handler: handleMailPassword })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/mappings', handler: handleMailMappings })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/mappings/template', handler: handleMailMappingTemplate })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/mappings/import-preview', handler: handleMailImportPreview })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/mappings/import-commit', handler: handleMailImportCommit })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/mappings/export', handler: handleMailMappingExport })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/preview', handler: handleMailPreview })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/send', handler: handleMailSend })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/retry', handler: handleMailRetry })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/mail/history', handler: handleMailHistory })
}
