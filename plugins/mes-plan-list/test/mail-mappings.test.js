import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import ExcelJS from 'exceljs'

import {
  ImportPreviewStore,
  buildExecutorIndex,
  resolveMappingRows,
  createMappingTemplate,
  exportMappings,
  parseMappingWorkbook,
  previewMappingImport,
} from '../src/mail-mappings.js'

async function workbookBuffer(rows, headers = ['执行人姓名', '邮箱地址']) {
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
    [' 张三 ', ' zhangsan@example.invalid '],
  ]))

  // 表格只收姓名和邮箱：MES 的 executorId 在界面上从不出现，用户填不出来。
  assert.deepEqual(result, {
    rows: [{ executorId: '', executorName: '张三', email: 'zhangsan@example.invalid' }],
    errors: [],
  })
})

test('resolves a name to every MES account that person has', () => {
  // 同名多 ID 是同一个人的历史账号，不是两个人：全部展开并共用一个邮箱。
  const index = buildExecutorIndex([
    { executorList: [{ executorId: 7686, executorName: '杨波' }] },
    { executorList: [{ executorId: 372227, executorName: '杨波' }, { executorId: 15401, executorName: null }] },
  ])
  const resolved = resolveMappingRows({ rows: [{ executorName: '杨波', email: 'yb@example.invalid' }], errors: [] }, index)

  assert.deepEqual(resolved.rows, [
    { executorId: '372227', executorName: '杨波', email: 'yb@example.invalid' },
    { executorId: '7686', executorName: '杨波', email: 'yb@example.invalid' },
  ])
  assert.deepEqual(resolved.errors, [])
})

test('does not treat one Excel name expanded to historical accounts as duplicate rows', () => {
  const resolved = resolveMappingRows(
    { rows: [{ executorName: '杨波', email: 'yb@example.invalid' }], errors: [] },
    new Map([['杨波', ['372227', '7686']]]),
  )

  const preview = previewMappingImport([], resolved)

  // 一行 Excel 记录可对应多个 MES 历史账号；它们共用同一邮箱是正常导入结果。
  assert.equal(preview.canCommit, true)
  assert.deepEqual(preview.errors, [])
  assert.deepEqual(preview.added, [
    { executorId: '372227', executorName: '杨波', email: 'yb@example.invalid' },
    { executorId: '7686', executorName: '杨波', email: 'yb@example.invalid' },
  ])
})

test('a name that appears in no plan is an error rather than a silent drop', () => {
  const index = buildExecutorIndex([{ executorList: [{ executorId: 900, executorName: '张三' }] }])
  const resolved = resolveMappingRows({ rows: [{ executorName: '查无此人', email: 'x@example.invalid' }], errors: [] }, index)

  assert.deepEqual(resolved.rows, [])
  assert.equal(resolved.errors.length, 1)
  assert.match(resolved.errors[0].message, /找不到执行人/)
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

test('reports a repeated person and an invalid email as row errors', async () => {
  const result = await parseMappingWorkbook(await workbookBuffer([
    ['张三', 'zhangsan@example.invalid'],
    ['张三', 'again@example.invalid'],
    ['王五', 'not-an-address'],
  ]))

  // 同一个人写了两行，服务端无从判断该用哪个邮箱，必须让用户自己决定。
  assert.deepEqual(result.rows, [])
  assert.deepEqual(result.errors.map((e) => e.code).sort(), ['duplicate-name', 'duplicate-name', 'invalid-email'])
})

test('reports missing required cells and prevents any import write', async () => {
  const result = await parseMappingWorkbook(await workbookBuffer([
    ['', 'nobody@example.invalid'],
    ['李四', ''],
  ]))

  assert.deepEqual(result.rows, [])
  assert.deepEqual(result.errors.map((e) => e.field).sort(), ['email', 'executorName'])
})

test('creates a template with the two headers and prefills known names', async () => {
  const parsed = await parseMappingWorkbook(await createMappingTemplate(['张三', '杨波']))

  // 预填姓名后用户只需补邮箱列，不必自己回忆有哪些执行人。
  assert.deepEqual(parsed.rows, [])
  assert.deepEqual(parsed.errors.map((e) => e.field), ['email', 'email'])
  const empty = await parseMappingWorkbook(await createMappingTemplate())
  assert.deepEqual(empty, { rows: [], errors: [] })
})

test('exports one row per person and re-imports to the same mappings', async () => {
  const stored = [
    { executorId: '372227', executorName: '杨波', email: 'yb@example.invalid' },
    { executorId: '7686', executorName: '杨波', email: 'yb@example.invalid' },
    { executorId: '900', executorName: '张三', email: 'zs@example.invalid' },
  ]
  const parsed = await parseMappingWorkbook(await exportMappings(stored))

  // 一个人一行，导出再导入应当还原成同样的存储行。
  assert.deepEqual(parsed.rows.map((r) => r.executorName), ['杨波', '张三'])
  const index = buildExecutorIndex([
    { executorList: [{ executorId: 372227, executorName: '杨波' }, { executorId: 7686, executorName: '杨波' }] },
    { executorList: [{ executorId: 900, executorName: '张三' }] },
  ])
  const resolved = resolveMappingRows(parsed, index)
  assert.deepEqual(
    [...resolved.rows].sort((a, b) => a.executorId.localeCompare(b.executorId)),
    [...stored].sort((a, b) => a.executorId.localeCompare(b.executorId)),
  )
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

// 依赖缺失只应弄坏工作簿这一个功能。顶层静态 import 会让 exceljs 解析失败时整个
// 模块加载不了，cordis entry 随之失败，DSH 整个起不来——用户连设置页里那句「请执行
// pnpm install」都看不到。所以这里断言的是爆炸半径，不只是错误文案。
test('a missing workbook dependency does not take down the whole module', async () => {
  const importExcel = async () => { throw new Error("Cannot find package 'exceljs'") }

  // 不碰工作簿的导出照常可用。
  assert.deepEqual(
    buildExecutorIndex([{ executorList: [{ executorId: '1001', executorName: '张三' }] }]).get('张三'),
    ['1001'],
  )

  for (const call of [
    () => parseMappingWorkbook(Buffer.alloc(0), { importExcel }),
    () => createMappingTemplate([], { importExcel }),
    () => exportMappings([], { importExcel }),
  ]) {
    await assert.rejects(call, /在仓库根执行 `pnpm install`/u)
  }

  // 上面的注入点绕不过静态 import——那会在模块解析阶段就失败，测试根本跑不到。
  const source = await readFile(new URL('../src/mail-mappings.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^import .+ from 'exceljs'/mu)
})
