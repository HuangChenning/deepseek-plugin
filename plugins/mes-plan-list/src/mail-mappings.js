import { randomBytes } from 'node:crypto'

// 用到工作簿的三个导出都是 async，exceljs 因此可以惰性加载。顶层静态 import 会让
// 依赖缺失时整个模块解析失败，cordis entry 跟着失败，DSH 整个起不来；惰性化后
// 爆炸半径缩回到导入导出这三个函数。
async function defaultImportExcel() {
  return import('exceljs')
}

async function newWorkbook(importExcel) {
  let module
  try {
    module = await importExcel()
  } catch {
    throw new Error('缺少 exceljs 依赖，请在仓库根执行 `pnpm install` 后重启 DSH')
  }
  return new (module.default ?? module).Workbook()
}

// 用户只填得出姓名和邮箱：MES 的 executorId 在界面上从不出现，要求手工提供它
// 等于要一个拿不到的输入。ID 由服务端从计划缓存反查，一个姓名可能对应同一个人的
// 多个历史账号，全部展开后共用同一个邮箱。
const HEADERS = ['执行人姓名', '邮箱地址']
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const IMPORT_PREVIEW_TTL_MS = 10 * 60 * 1000

function cellText(cell) {
  return String(cell.text ?? cell.value ?? '').trim()
}

function mappingError(rowNumber, code, field, message) {
  return { rowNumber, code, field, message }
}

function validateRows(rows, rowNumbers = [], checkDuplicateNames = true) {
  const normalized = []
  const errors = []
  const ids = new Map()

  for (let index = 0; index < (Array.isArray(rows) ? rows.length : 0); index += 1) {
    const source = rows[index] ?? {}
    const rowNumber = rowNumbers[index] ?? index + 2
    const row = {
      // 服务端反查出来的 ID 要原样带过校验，它才是存储主键。
      executorId: String(source.executorId ?? '').trim(),
      executorName: String(source.executorName ?? '').trim(),
      email: String(source.email ?? '').trim(),
    }
    const rowErrors = []
    if (row.executorName === '') rowErrors.push(mappingError(rowNumber, 'missing-cell', 'executorName', '缺少执行人姓名'))
    if (row.email === '') rowErrors.push(mappingError(rowNumber, 'missing-cell', 'email', '缺少邮箱地址'))
    else if (!EMAIL_PATTERN.test(row.email)) rowErrors.push(mappingError(rowNumber, 'invalid-email', 'email', '邮箱地址格式无效'))
    normalized.push(row)
    errors.push(...rowErrors)
    if (row.executorName !== '') {
      const previous = ids.get(row.executorName) ?? []
      previous.push({ index, rowNumber })
      ids.set(row.executorName, previous)
    }
  }

  if (checkDuplicateNames) {
    for (const occurrences of ids.values()) {
      if (occurrences.length < 2) continue
      for (const occurrence of occurrences) {
        errors.push(mappingError(occurrence.rowNumber, 'duplicate-name', 'executorName', '同一个执行人姓名出现多行'))
      }
    }
  }

  const invalidRows = new Set(errors.map((error) => error.rowNumber))
  return {
    rows: normalized.filter((unused, index) => !invalidRows.has(rowNumbers[index] ?? index + 2)),
    errors,
  }
}

/**
 * 从本地计划缓存建立 姓名 -> executorId[] 的索引。同一个人可能有多个历史账号，
 * 因此值是数组；MES 在计划里只给 ID 不给姓名的条目无法反查，直接跳过。
 */
export function buildExecutorIndex(plans) {
  const index = new Map()
  for (const plan of plans ?? []) {
    for (const executor of plan?.executorList ?? []) {
      const name = String(executor?.executorName ?? '').trim()
      const id = executor?.executorId
      if (name === '' || id === undefined || id === null) continue
      const ids = index.get(name) ?? new Set()
      ids.add(String(id))
      index.set(name, ids)
    }
  }
  return new Map([...index].map(([name, ids]) => [name, [...ids].sort()]))
}

/**
 * 把「姓名 + 邮箱」展开成可存储的「ID + 姓名 + 邮箱」。一个姓名对应多个账号时
 * 全部展开并共用同一个邮箱——那是同一个人的历史账号，不是两个人。
 */
export function resolveMappingRows(parsed, index) {
  const rows = []
  const errors = [...(parsed?.errors ?? [])]
  for (const row of parsed?.rows ?? []) {
    const ids = index?.get(row.executorName)
    if (ids === undefined || ids.length === 0) {
      errors.push(mappingError(0, 'unknown-executor', 'executorName', `计划数据中找不到执行人「${row.executorName}」`))
      continue
    }
    for (const executorId of ids) rows.push({ executorId, executorName: row.executorName, email: row.email })
  }
  return { rows, errors }
}

/** Parse the first worksheet of an executor mapping workbook without retaining its buffer. */
export async function parseMappingWorkbook(buffer, { importExcel = defaultImportExcel } = {}) {
  const workbook = await newWorkbook(importExcel)
  await workbook.xlsx.load(buffer)
  const sheet = workbook.worksheets[0]
  if (sheet === undefined) return { rows: [], errors: [mappingError(1, 'missing-sheet', '', '工作簿缺少工作表')] }

  const header = HEADERS.map((unused, index) => cellText(sheet.getRow(1).getCell(index + 1)))
  if (header.some((value, index) => value !== HEADERS[index])) {
    return { rows: [], errors: [mappingError(1, 'invalid-headers', '', '邮箱映射表头必须为执行人 ID、执行人姓名、邮箱地址')] }
  }

  const rows = []
  const rowNumbers = []
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const values = [cellText(row.getCell(1)), cellText(row.getCell(2))]
    if (values.every((value) => value === '')) continue
    rows.push({ executorName: values[0], email: values[1] })
    rowNumbers.push(rowNumber)
  }
  return validateRows(rows, rowNumbers)
}

/** Compare incoming rows with current rows, retaining errors so callers can avoid all writes. */
export function previewMappingImport(current, incoming) {
  const currentRows = validateRows(Array.isArray(current) ? current : [], [], false).rows
  const incomingResult = Array.isArray(incoming) ? { rows: incoming, errors: [] } : (incoming ?? { rows: [], errors: [] })
  const checkedIncoming = validateRows(incomingResult.rows, incomingResult.rows?.map((unused, index) => index + 2), false)
  const errors = [...(Array.isArray(incomingResult.errors) ? incomingResult.errors : []), ...checkedIncoming.errors]
  const currentById = new Map(currentRows.map((row) => [row.executorId, row]))
  const added = []
  const updated = []
  const unchanged = []

  if (errors.length === 0) {
    for (const row of checkedIncoming.rows) {
      const previous = currentById.get(row.executorId)
      if (previous === undefined) added.push(row)
      else if (previous.executorName === row.executorName && previous.email === row.email) unchanged.push(row)
      else updated.push({ before: previous, after: row })
    }
  }

  return { added, updated, unchanged, errors, canCommit: errors.length === 0 }
}

function validateExportRows(rows) {
  const result = validateRows(rows, (rows ?? []).map((unused, index) => index + 2))
  if (result.errors.length > 0 || !Array.isArray(rows)) throw new Error('邮箱映射包含无效行')
  return result.rows
}

/** Create a blank workbook containing the fixed import headers. */
export async function createMappingTemplate(names = [], { importExcel = defaultImportExcel } = {}) {
  const workbook = await newWorkbook(importExcel)
  const sheet = workbook.addWorksheet('邮箱映射')
  sheet.addRow(HEADERS)
  // 预填计划里出现过的姓名，用户只需补邮箱列，不必自己回忆有哪些执行人。
  for (const name of names) sheet.addRow([name, ''])
  return workbook.xlsx.writeBuffer()
}

/** Export the supplied private mapping rows as an Excel workbook. */
export async function exportMappings(rows, { importExcel = defaultImportExcel } = {}) {
  const workbook = await newWorkbook(importExcel)
  const sheet = workbook.addWorksheet('邮箱映射')
  sheet.addRow(HEADERS)
  // 同一个人的多个账号在导出里合成一行，导出再导入应当得到同样的结果。
  // 先按人去重再校验：「同名多行」是导入侧的歧义规则，存储里那是合法的历史账号。
  const byName = new Map()
  for (const row of rows ?? []) {
    if (!byName.has(row?.executorName)) byName.set(row?.executorName, row)
  }
  for (const row of validateExportRows([...byName.values()])) sheet.addRow([row.executorName, row.email])
  return workbook.xlsx.writeBuffer()
}

function timeValue(now) {
  return now instanceof Date ? now.getTime() : new Date(now).getTime()
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** In-memory, profile-bound, one-time storage for import previews. */
export class ImportPreviewStore {
  #tokens = new Map()

  create(profileKey, preview, now = new Date()) {
    const token = randomBytes(32).toString('base64url')
    const snapshot = deepFreeze(structuredClone(preview))
    this.#tokens.set(token, { profileKey, preview: snapshot, expiresAt: timeValue(now) + IMPORT_PREVIEW_TTL_MS })
    return token
  }

  consume(token, profileKey, now = new Date()) {
    const entry = this.#tokens.get(token)
    if (entry === undefined || entry.profileKey !== profileKey || timeValue(now) >= entry.expiresAt) {
      if (entry !== undefined && timeValue(now) >= entry.expiresAt) this.#tokens.delete(token)
      throw new Error('导入令牌无效或已过期')
    }
    this.#tokens.delete(token)
    return entry.preview
  }
}
