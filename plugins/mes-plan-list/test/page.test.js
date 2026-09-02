import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFilterSelection, paginatePlans } from '../src/page.js'

test('filter selection refreshes valid queries after updating the picker state', () => {
  const events = []
  const form = { reportValidity: () => true }

  applyFilterSelection(form, 'status', (name) => events.push(['sync', name]), (refresh) => events.push(['query', refresh]))

  assert.deepEqual(events, [['sync', 'status'], ['query', false]])
})

test('filter selection does not query while the required date range is invalid', () => {
  let queried = false

  applyFilterSelection({ reportValidity: () => false }, 'checkType', () => {}, () => { queried = true })

  assert.equal(queried, false)
})

test('pagination returns the requested slice and page totals', () => {
  const plans = Array.from({ length: 45 }, (_, index) => ({ id: index + 1 }))

  const result = paginatePlans(plans, 2, 20)

  assert.deepEqual(result.items.map((plan) => plan.id), Array.from({ length: 20 }, (_, index) => index + 21))
  assert.deepEqual({ page: result.page, totalPages: result.totalPages, total: result.total }, { page: 2, totalPages: 3, total: 45 })
})

test('pagination clamps a page beyond the available results', () => {
  const plans = Array.from({ length: 45 }, (_, index) => ({ id: index + 1 }))

  const result = paginatePlans(plans, 9, 20)

  assert.deepEqual(result.items.map((plan) => plan.id), [41, 42, 43, 44, 45])
  assert.equal(result.page, 3)
})

/*
 * 邮件提醒的选择模型。跨页选择的状态活在渲染之外的 Set 里，因此每条规则都必须
 * 独立成立：只有已逾期计划可选、表头只管当前页、刷新后必须对账。
 */

import {
  canSend, importSummary, isOverdue, pageSelectionState,
  reconcileSelection, renderPage, sendSummary, setPageSelection, toggleSelection,
} from '../src/page.js'

const overdue = (id) => ({ id, status: 3 })
const running = (id) => ({ id, status: 1 })

test('only an overdue plan can be selected for a reminder', () => {
  assert.equal(isOverdue({ status: 3 }), true)
  assert.equal(isOverdue({ status: '3' }), true)
  for (const status of [0, 1, 2, undefined, null]) assert.equal(isOverdue({ status }), false, String(status))
})

test('selection survives paging because it is keyed by plan id', () => {
  const selected = new Set()

  toggleSelection(selected, 1, true)
  toggleSelection(selected, 42, true)
  toggleSelection(selected, 1, false)

  assert.deepEqual([...selected], [42])
})

test('the header checkbox selects only the current page and skips ineligible rows', () => {
  const selected = new Set([99])

  setPageSelection(selected, [overdue(1), running(2), overdue(3)], true)

  // 99 来自其他页，必须原样保留；2 不是逾期计划，不能被全选带进来。
  assert.deepEqual([...selected].sort((a, b) => a - b), [1, 3, 99])
})

test('clearing the header checkbox releases only the current page', () => {
  const selected = new Set([1, 3, 99])

  setPageSelection(selected, [overdue(1), overdue(3)], false)

  assert.deepEqual([...selected], [99])
})

test('the header checkbox reports partial selection on the current page', () => {
  const plans = [overdue(1), running(2), overdue(3)]

  assert.equal(pageSelectionState(new Set(), plans), 'none')
  assert.equal(pageSelectionState(new Set([1]), plans), 'partial')
  assert.equal(pageSelectionState(new Set([1, 3]), plans), 'all')
  // 当前页没有可选行时不该显示成「已全选」。
  assert.equal(pageSelectionState(new Set([1]), [running(2)]), 'none')
})

test('a refresh drops plans that vanished or are no longer overdue', () => {
  const selected = new Set([1, 2, 3])

  const reconciled = reconcileSelection(selected, [overdue(1), running(2)])

  // 3 已从结果里消失，2 已不再逾期：留着它们等于带着一个看不见却仍会发信的选中项。
  assert.deepEqual([...reconciled], [1])
})

test('sending requires a token, an explicit confirmation, and no in-flight request', () => {
  assert.equal(canSend({ token: 't', confirmed: true, busy: false }), true)
  assert.equal(canSend({ token: 't', confirmed: false, busy: false }), false, '未勾选确认不得发送')
  assert.equal(canSend({ token: 't', confirmed: true, busy: true }), false, '请求进行中不得重复提交')
  assert.equal(canSend({ token: '', confirmed: true, busy: false }), false)
})

test('an import with row errors offers no commit', () => {
  const summary = importSummary({ added: [{}], updated: [], unchanged: [], errors: [{ row: 2 }], canCommit: false })

  assert.deepEqual(summary, { added: 1, updated: 0, unchanged: 0, errors: 1, canCommit: false })
})

test('an import that changes nothing offers no commit either', () => {
  const summary = importSummary({ added: [], updated: [], unchanged: [{}, {}], errors: [], canCommit: true })

  assert.equal(summary.unchanged, 2)
  assert.equal(summary.canCommit, false, '零变更的提交只会白写一次全表')
})

test('a partially failed batch offers a failed-only retry', () => {
  const summary = sendSummary({ totalMessages: 3, succeeded: 2, failed: 1, retryToken: 'retry-token' })

  assert.equal(summary.canRetry, true)
  assert.equal(summary.retryToken, 'retry-token')
  assert.match(summary.text, /2/)
  assert.match(summary.text, /1/)
})

test('a fully successful batch offers no retry', () => {
  assert.equal(sendSummary({ totalMessages: 2, succeeded: 2, failed: 0 }).canRetry, false)
  // 有失败但服务端没给令牌时同样不能重试，否则按钮点了必然 400。
  assert.equal(sendSummary({ totalMessages: 2, succeeded: 1, failed: 1 }).canRetry, false)
})

test('the page ships the mail settings, mapping, and history panels', () => {
  const html = renderPage()

  for (const id of [
    'mail-settings-form', 'mail-password', 'save-mail-settings', 'test-mail', 'clear-mail-password',
    'mail-mappings', 'mapping-template', 'mapping-export', 'mapping-import-file',
    'mail-history', 'clear-mail-history',
    'mail-actionbar', 'mail-selected-count', 'mail-clear-selection', 'mail-preview-button',
    'mail-preview', 'mail-confirm', 'mail-send', 'mail-result', 'mail-retry',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`)
  }
})

test('the password field is write-only and never carries a rendered value', () => {
  const field = renderPage().match(/<input[^>]*id="mail-password"[^>]*>/)[0]

  assert.match(field, /type="password"/)
  assert.doesNotMatch(field, /value=/, '页面不得回显钥匙串里的密码')
})

test('the export control warns about private data before it is used', () => {
  const html = renderPage()
  const warning = html.indexOf('导出文件包含真实邮箱')
  const button = html.indexOf('id="mapping-export"')

  assert.notEqual(warning, -1, '缺少导出前的隐私提示')
  assert.ok(warning < button, '提示必须出现在导出按钮之前')
})

test('confirmation is a separate opt-in that starts unchecked and un-sendable', () => {
  const html = renderPage()
  const confirm = html.match(/<input[^>]*id="mail-confirm"[^>]*>/)[0]
  const send = html.match(/<button[^>]*id="mail-send"[^>]*>/)[0]

  assert.match(confirm, /type="checkbox"/)
  assert.doesNotMatch(confirm, /checked/)
  assert.match(send, /disabled/, '未确认前发送按钮必须是禁用的')
})

test('mail content is rendered through text nodes rather than innerHTML', () => {
  const script = renderPage().split('<script>')[1]
  const start = script.indexOf('const renderMailPreview')
  assert.notEqual(start, -1, '缺少邮件预览渲染函数')
  const mailSection = script.slice(start)

  // 邮件正文、收件人和映射都来自服务端，一律走 textContent，不拼 HTML。
  assert.doesNotMatch(mailSection, /\.innerHTML\s*=(?!\s*'')/)
})

/*
 * 可达性。`.panel` 默认 display:none，只有 [data-show] 才显示，而「设置」开关只给
 * #settings 加这个属性。一个新增的 .panel 兄弟节点因此会永久不可见——光断言
 * id 存在于标记里抓不到这种问题，必须断言它真的能被显示出来。
 */

test('the mail configuration lives inside the settings drawer that the toggle opens', () => {
  const html = renderPage()
  const start = html.indexOf('<section id="settings"')
  const drawer = html.slice(start, html.indexOf('</section>', start))

  // 设置开关只作用于 #settings，所以邮件配置必须在它内部才打得开。
  for (const id of ['mail-panel', 'mail-settings-form', 'mail-mappings', 'mail-history']) {
    assert.match(drawer, new RegExp(`id="${id}"`), `#${id} 不在设置抽屉内，将永久不可见`)
  }
})

test('every .panel section is either the settings drawer or shown via data-show', () => {
  const html = renderPage()
  const script = html.split('<script>')[1]
  const panels = [...html.matchAll(/<section id="([^"]+)"[^>]*class="panel"/g)].map((match) => match[1])

  assert.ok(panels.length > 0, '未找到任何 .panel 区块')
  for (const id of panels) {
    if (id === 'settings') continue
    // hidden 属性对 display:none 的元素无效，必须走 data-show。
    assert.match(script, new RegExp(`setAttribute\\('data-show'`), `#${id} 缺少 data-show 显示路径`)
  }
})

test('the preview panel is toggled with data-show rather than the hidden attribute', () => {
  const script = renderPage().split('<script>')[1]
  const mailSection = script.slice(script.indexOf('const renderMailPreview'))

  assert.doesNotMatch(mailSection, /mailPanel\.hidden/, '.panel 的 display:none 会盖过 hidden')
  assert.match(mailSection, /mailPanel\.setAttribute\('data-show', ''\)/)
  assert.match(mailSection, /mailPanel\.removeAttribute\('data-show'\)/)
})

test('the row checkboxes neutralize the global input sizing rule', () => {
  const css = renderPage().split('<style>')[1].split('</style>')[0]

  // 全局 `input { min-width: 150px }` 会把表格里的复选框拉成一条扁条，
  // 看不出是可勾选的控件——新增的表内控件必须显式复位。
  assert.match(css, /input\s*,\s*select\s*\{[^}]*min-width:\s*150px/, '全局规则已变，本测试的前提需要复核')
  assert.match(css, /\.pick input \{[^}]*min-width:\s*0/)
  assert.match(css, /\.pick input \{[^}]*width:\s*16px/)
})
