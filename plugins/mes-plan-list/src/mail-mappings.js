import { randomBytes } from 'node:crypto'

import ExcelJS from 'exceljs'

const HEADERS = ['执行人 ID', '执行人姓名', '邮箱地址']
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const IMPORT_PREVIEW_TTL_MS = 10 * 60 * 1000

function cellText(cell) {
  return String(cell.text ?? cell.value ?? '').trim()
}

function mappingError(rowNumber, code, field, message) {
  return { rowNumber, code, field, message }
}

function validateRows(rows, rowNumbers = []) {
  const normalized = []
  const errors = []
  const ids = new Map()

  for (let index = 0; index < (Array.isArray(rows) ? rows.length : 0); index += 1) {
    const source = rows[index] ?? {}
    const rowNumber = rowNumbers[index] ?? index + 2
    const row = {
      executorId: String(source.executorId ?? '').trim(),
      executorName: String(source.executorName ?? '').trim(),
      email: String(source.email ?? '').trim(),
    }
    const rowErrors = []
    if (row.executorId === '') rowErrors.push(mappingError(rowNumber, 'missing-cell', 'executorId', '缺少执行人 ID'))
    if (row.executorName === '') rowErrors.push(mappingError(rowNumber, 'missing-cell', 'executorName', '缺少执行人姓名'))
    if (row.email === '') rowErrors.push(mappingError(rowNumber, 'missing-cell', 'email', '缺少邮箱地址'))
    else if (!EMAIL_PATTERN.test(row.email)) rowErrors.push(mappingError(rowNumber, 'invalid-email', 'email', '邮箱地址格式无效'))
    normalized.push(row)
    errors.push(...rowErrors)
    if (row.executorId !== '') {
      const previous = ids.get(row.executorId) ?? []
      previous.push({ index, rowNumber })
      ids.set(row.executorId, previous)
    }
  }

  for (const occurrences of ids.values()) {
    if (occurrences.length < 2) continue
    for (const occurrence of occurrences) {
      errors.push(mappingError(occurrence.rowNumber, 'duplicate-id', 'executorId', '执行人 ID 重复'))
    }
  }

  const invalidRows = new Set(errors.map((error) => error.rowNumber))
  return {
    rows: normalized.filter((unused, index) => !invalidRows.has(rowNumbers[index] ?? index + 2)),
    errors,
  }
}

/** Parse the first worksheet of an executor mapping workbook without retaining its buffer. */
export async function parseMappingWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook()
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
    const values = [cellText(row.getCell(1)), cellText(row.getCell(2)), cellText(row.getCell(3))]
    if (values.every((value) => value === '')) continue
    rows.push({ executorId: values[0], executorName: values[1], email: values[2] })
    rowNumbers.push(rowNumber)
  }
  return validateRows(rows, rowNumbers)
}

/** Compare incoming rows with current rows, retaining errors so callers can avoid all writes. */
export function previewMappingImport(current, incoming) {
  const currentRows = validateRows(Array.isArray(current) ? current : []).rows
  const incomingResult = Array.isArray(incoming) ? { rows: incoming, errors: [] } : (incoming ?? { rows: [], errors: [] })
  const checkedIncoming = validateRows(incomingResult.rows, incomingResult.rows?.map((unused, index) => index + 2))
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
export async function createMappingTemplate() {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('邮箱映射')
  sheet.addRow(HEADERS)
  return workbook.xlsx.writeBuffer()
}

/** Export the supplied private mapping rows as an Excel workbook. */
export async function exportMappings(rows) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('邮箱映射')
  sheet.addRow(HEADERS)
  for (const row of validateExportRows(rows)) sheet.addRow([row.executorId, row.executorName, row.email])
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
