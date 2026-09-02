import { queryPlans } from './plan-query.js'
import { renderPage } from './page.js'
import { readConfig, writeConfig } from './config.js'
import { isUpdating, readAuthStatus, readCliVersion, readMesVersion, readUpdateStatus, runMesUpdate } from './mes-cli.js'
import { PlanStore } from './plan-store.js'

/** 进程内共用一个 store；懒创建让没查过的机器上不出现 .db 文件。 */
let sharedStore
function defaultStore() {
  sharedStore ??= new PlanStore()
  return sharedStore
}

const MAX_BODY_BYTES = 16 * 1024
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i

class RequestError extends Error {}

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

function validateInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('请求参数无效')
  if (Object.keys(body).some((key) => !['startDate', 'endDate', 'status', 'refresh'].includes(key))) throw new RequestError('请求参数无效')
  if (body.refresh !== undefined && typeof body.refresh !== 'boolean') throw new RequestError('请求参数无效')
  if (body.startDate === undefined || body.startDate === '') throw new RequestError('开始日期不能为空')
  if (typeof body.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) throw new RequestError('开始日期格式错误')
  if (body.endDate === undefined || body.endDate === '') throw new RequestError('结束日期不能为空')
  if (typeof body.endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate)) throw new RequestError('结束日期格式错误')
  if (body.startDate > body.endDate) throw new RequestError('开始日期不能晚于结束日期')
  if (body.status !== undefined && (typeof body.status !== 'string' || !['', '0', '1', '2', '3'].includes(body.status))) throw new RequestError('状态值无效')
  return { startDate: body.startDate, endDate: body.endDate, status: body.status ?? '', refresh: body.refresh === true }
}

/**
 * 读缓存优先：能被已同步窗口覆盖就本地取，否则打 MES 取回并落盘。
 *
 * 同步一律按全状态进行（status 留空），状态过滤在本地做——带状态的返回不是窗口
 * 全集，用它做幽灵行清理会误删。
 */
async function resolvePlans({ startDate, endDate, status, refresh }, query, store) {
  const window = { startDate, endDate }
  if (!refresh) {
    const syncedAt = store.findCoveringSync(window)
    if (syncedAt !== undefined) return { plans: store.readPlans({ startDate, endDate, status }), syncedAt, fromCache: true }
  }
  // 同步范围扩展到覆盖所有缓存过的窗口，否则窄窗口同步只清掉自己窗口内的幽灵行。
  const syncWindow = store.coveringWindow(window)
  const fresh = await query({ ...syncWindow, status: '' })
  const syncedAt = store.writeWindow(syncWindow, fresh)
  return { plans: store.readPlans({ startDate, endDate, status }), syncedAt, fromCache: false }
}

function validateConfigInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('请求参数无效')
  if (Object.keys(body).some((key) => key !== 'mesPath')) throw new RequestError('请求参数无效')
  if (typeof body.mesPath !== 'string') throw new RequestError('mes 路径必须是字符串')
  return body.mesPath
}

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
} = {}) {
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
        writeJson(response, 200, { ok: true, ...(await resolvePlans(input, query, store())) })
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
  }
}

export const inject = ['webServer']

export function apply(ctx) {
  const { handlePage, handleQuery, handleConfig, handleAuth, handleCli, handleCliUpdate, handleCache } = createHandlers()
  ctx.webServer.register({ kind: 'exact', path: '/plugins/mes-plan-list', handler: handlePage })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/query', handler: handleQuery })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/config', handler: handleConfig })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/auth', handler: handleAuth })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/cli', handler: handleCli })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/cli/update', handler: handleCliUpdate })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/cache', handler: handleCache })
}
