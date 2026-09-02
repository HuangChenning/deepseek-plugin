import assert from 'node:assert/strict'
import test from 'node:test'

import ExcelJS from 'exceljs'

import {
  ImportPreviewStore,
  createMappingTemplate,
  exportMappings,
  parseMappingWorkbook,
  previewMappingImport,
} from '../src/mail-mappings.js'

async function workbookBuffer(rows, headers = ['执行人 ID', '执行人姓名', '邮箱地址']) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('映射')
  sheet.addRow(headers)
  for (const row of rows) sheet.addRow(row)
  return workbook.xlsx.writeBuffer()
}

const current = [
  { executorId: '1001', executorName: '张三', email: 'old@example.invalid' },
  { executorId: '1002', executorName: '李四', email: 'lisi@example.invalid' },
]

test('parses the fixed Chinese mapping headers and normalizes cell values', async () => {
  const result = await parseMappingWorkbook(await workbookBuffer([
    [1001, ' 张三 ', ' zhangsan@example.invalid '],
  ]))

  assert.deepEqual(result, {
    rows: [{ executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' }],
    errors: [],
  })
})

test('classifies incoming mappings as added, updated, and unchanged', () => {
  const preview = previewMappingImport(current, [
    { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
    { executorId: '1002', executorName: '李四', email: 'lisi@example.invalid' },
    { executorId: '1003', executorName: '王五', email: 'wangwu@example.invalid' },
  ])

  assert.deepEqual(preview, {
    added: [{ executorId: '1003', executorName: '王五', email: 'wangwu@example.invalid' }],
    updated: [{
      before: current[0],
      after: { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
    }],
    unchanged: [current[1]],
    errors: [],
    canCommit: true,
  })
})

test('reports duplicate IDs and invalid emails as row errors', async () => {
  const result = await parseMappingWorkbook(await workbookBuffer([
    ['1001', '张三', 'zhangsan@example.invalid'],
    [' 1001 ', '李四', 'lisi@example.invalid'],
    ['1002', '王五', 'not-an-email'],
  ]))

  assert.deepEqual(result.rows, [])
  assert.equal(result.errors.length, 3)
  assert.ok(result.errors.some((error) => error.code === 'duplicate-id' && error.rowNumber === 2))
  assert.ok(result.errors.some((error) => error.code === 'duplicate-id' && error.rowNumber === 3))
  assert.ok(result.errors.some((error) => error.code === 'invalid-email' && error.rowNumber === 4))
})

test('reports missing required cells and prevents any import write', async () => {
  const parsed = await parseMappingWorkbook(await workbookBuffer([
    ['', '无 ID', 'noid@example.invalid'],
    ['1002', '', 'noname@example.invalid'],
    ['1003', '无邮箱', ''],
  ]))
  const preview = previewMappingImport(current, parsed)

  assert.equal(preview.canCommit, false)
  assert.equal(preview.added.length, 0)
  assert.equal(preview.updated.length, 0)
  assert.equal(preview.unchanged.length, 0)
  assert.equal(preview.errors.length, 3)
})

test('creates a template with exactly the required Chinese headers', async () => {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await createMappingTemplate())
  assert.deepEqual(workbook.worksheets[0].getRow(1).values.slice(1), ['执行人 ID', '执行人姓名', '邮箱地址'])
  assert.equal(workbook.worksheets[0].rowCount, 1)
})

test('exports mappings that can be imported without changing rows', async () => {
  const rows = [
    { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
    { executorId: '1002', executorName: '李四', email: 'lisi@example.invalid' },
  ]
  const parsed = await parseMappingWorkbook(await exportMappings(rows))
  assert.deepEqual(parsed, { rows, errors: [] })
})

test('consumes an import preview token only once and only for its profile', () => {
  const store = new ImportPreviewStore()
  const now = new Date('2026-09-02T00:00:00.000Z')
  const preview = { added: [{ executorId: '1001' }], errors: [], canCommit: true }
  const token = store.create('profile-a', preview, now)

  assert.match(token, /^[A-Za-z0-9_-]+$/)
  assert.throws(() => store.consume(token, 'profile-b', now), /导入令牌无效或已过期/)
  assert.deepEqual(store.consume(token, 'profile-a', now), preview)
  assert.throws(() => store.consume(token, 'profile-a', now), /导入令牌无效或已过期/)
})

test('expires import previews and stores an immutable snapshot', () => {
  const store = new ImportPreviewStore()
  const now = new Date('2026-09-02T00:00:00.000Z')
  const preview = { added: [{ executorId: '1001' }], errors: [], canCommit: true }
  const token = store.create('profile-a', preview, now)
  preview.added[0].executorId = 'changed'

  assert.throws(() => store.consume(token, 'profile-a', new Date(now.getTime() + 10 * 60 * 1000)), /导入令牌无效或已过期/)
  const second = store.create('profile-a', { added: [{ executorId: '1001' }] }, now)
  const consumed = store.consume(second, 'profile-a', now)
  assert.throws(() => { consumed.added[0].executorId = 'changed' }, TypeError)
})
