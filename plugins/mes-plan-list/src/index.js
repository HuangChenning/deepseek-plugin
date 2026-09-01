import { queryPlans } from './plan-query.js'
import { renderPage } from './page.js'

const MAX_BODY_BYTES = 16 * 1024
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i

function writeJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(payload))
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > MAX_BODY_BYTES) throw new Error('请求体不能超过 16 KiB')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体必须是有效 JSON')
  }
}

function validateInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求参数无效')
  if (Object.keys(body).some((key) => !['startDate', 'endDate', 'status'].includes(key))) throw new Error('请求参数无效')
  if (body.startDate === undefined || body.startDate === '') throw new Error('开始日期不能为空')
  if (typeof body.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) throw new Error('开始日期格式错误')
  if (body.endDate === undefined || body.endDate === '') throw new Error('结束日期不能为空')
  if (typeof body.endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate)) throw new Error('结束日期格式错误')
  if (body.startDate > body.endDate) throw new Error('开始日期不能晚于结束日期')
  if (body.status !== undefined && (typeof body.status !== 'string' || !['', '0', '1', '2', '3'].includes(body.status))) throw new Error('状态值无效')
  return { startDate: body.startDate, endDate: body.endDate, status: body.status ?? '' }
}

export function createHandlers({ query = queryPlans } = {}) {
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
      let input
      try {
        input = validateInput(await readJson(request))
      } catch (error) {
        writeJson(response, 400, { ok: false, error: error.message })
        return
      }
      try {
        const plans = await query(input)
        writeJson(response, 200, { ok: true, plans })
      } catch {
        writeJson(response, 502, { ok: false, error: 'MES 查询失败，请稍后重试' })
      }
    },
  }
}

export const inject = ['webServer']

export function apply(ctx) {
  const { handlePage, handleQuery } = createHandlers()
  ctx.webServer.register({ kind: 'exact', path: '/plugins/mes-plan-list', handler: handlePage })
  ctx.webServer.register({ kind: 'exact', path: '/api/plugins/mes-plan-list/query', handler: handleQuery })
}
