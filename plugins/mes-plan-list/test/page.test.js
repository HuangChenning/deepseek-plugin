import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFilterSelection, formatImportError, paginatePlans } from '../src/page.js'

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
  canSend, importSummary, isOverdue, isSettingsView, pageSelectionState,
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

test('formats import errors with their server row number only when one exists', () => {
  assert.equal(
    formatImportError({ rowNumber: 7, message: '同一个执行人姓名出现多行' }),
    '第 7 行：同一个执行人姓名出现多行',
  )
  assert.equal(
    formatImportError({ rowNumber: 0, message: '计划数据中找不到执行人「王五」' }),
    '计划数据中找不到执行人「王五」',
  )
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

test('settings are a dedicated view instead of sharing the plan list', () => {
  const html = renderPage()
  const script = html.split('<script>')[1]
  const settingsStart = html.indexOf('<section id="settings-view"')
  const settingsView = html.slice(settingsStart, html.indexOf('</section>', settingsStart))

  assert.match(settingsView, /id="settings-back"/, '设置页需要提供返回列表的入口')
  for (const id of ['mail-panel', 'mail-settings-form', 'mail-mappings', 'mail-history']) {
    assert.match(settingsView, new RegExp(`id="${id}"`), `#${id} 不在独立设置视图内`)
  }
  assert.match(script, /settingsView\.setAttribute\('data-show', ''\)/, '点击设置必须展示独立设置视图')
  assert.match(script, /settingsView\.removeAttribute\('data-show'\)/, '返回列表必须关闭独立设置视图')
})

test('only the settings hash marks the settings view', () => {
  assert.equal(isSettingsView('#settings'), true)
  for (const hash of ['', '#', '#settings-view', '#mail', undefined]) {
    assert.equal(isSettingsView(hash), false, String(hash))
  }
})

/*
 * 刷新会重建整个页面，点击时设的 data-view 随之丢失。只有把视图挂在 URL hash 上、
 * 并在脚本启动时同步一次，用户刷新后才还停在设置页；hashchange 让前进后退同样有效。
 */
test('the settings view survives a reload because it lives in the URL hash', () => {
  const script = renderPage().split('<script>')[1]

  const written = script.match(/#settings-toggle'\)\.addEventListener\('click', \(\) => \{\s*location\.hash = '([^']*)'/)
  assert.ok(written, '设置按钮必须把视图写进 URL hash')
  assert.equal(isSettingsView(`#${written[1]}`), true, '按钮写入的 hash 必须被认作设置页')

  assert.match(script, /window\.addEventListener\('hashchange', syncSettingsView\)/, 'hash 变化必须重新同步视图')
  assert.match(script, /\n\s*syncSettingsView\(\)\n/, '页面加载时必须按当前 hash 同步一次视图')
  assert.match(script, /#settings-back'\)\.addEventListener\('click', \(\) => \{\s*location\.hash = ''/, '返回列表必须清掉 hash')
})

test('every .panel section has a data-show display path', () => {
  const html = renderPage()
  const script = html.split('<script>')[1]
  const panels = [...html.matchAll(/<section id="([^"]+)"[^>]*class="panel"/g)].map((match) => match[1])

  assert.ok(panels.length > 0, '未找到任何 .panel 区块')
  for (const id of panels) {
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

test('the preview sits directly below the action bar instead of after all plan rows', () => {
  const html = renderPage()
  const actionBar = html.indexOf('id="mail-actionbar"')
  const preview = html.indexOf('id="mail-preview"')
  const results = html.indexOf('id="results"')

  assert.ok(actionBar < preview, '预览必须位于操作栏之后')
  assert.ok(preview < results, '预览不能放在计划结果表之后')
})

test('the confirmation checkbox stays compact beside its label', () => {
  const css = renderPage().split('<style>')[1].split('</style>')[0]

  assert.match(css, /\.panel \.confirm input \{[^}]*min-width:\s*0/)
  assert.match(css, /\.panel \.confirm input \{[^}]*width:\s*16px/)
  assert.match(css, /\.panel \.confirm \{[^}]*font-size:\s*12px/)
})

test('the generated mail preview uses compact 12px text', () => {
  const css = renderPage().split('<style>')[1].split('</style>')[0]

  assert.match(css, /#mail-preview-groups \{[^}]*font-size:\s*12px/)
  assert.match(css, /#mail-preview-groups pre \{[^}]*font:\s*inherit/)
})

test('the row checkboxes neutralize the global input sizing rule', () => {
  const css = renderPage().split('<style>')[1].split('</style>')[0]

  // 全局 `input { min-width: 150px }` 会把表格里的复选框拉成一条扁条，
  // 看不出是可勾选的控件——新增的表内控件必须显式复位。
  assert.match(css, /input\s*,\s*select\s*\{[^}]*min-width:\s*150px/, '全局规则已变，本测试的前提需要复核')
  assert.match(css, /\.pick input \{[^}]*min-width:\s*0/)
  assert.match(css, /\.pick input \{[^}]*width:\s*16px/)
})

test('the plan table uses a single width budget inside a wider page shell', () => {
  const css = renderPage().split('<style>')[1].split('</style>')[0]

  assert.match(css, /\.shell \{[^}]*max-width:\s*1440px/)
  assert.match(css, /table \{[^}]*min-width:\s*1270px/)
  assert.match(css, /table \{[^}]*table-layout:\s*fixed/)
})

test('each plan column stays within the shared layout budget', () => {
  const css = renderPage().split('<style>')[1].split('</style>')[0]

  assert.match(css, /th\.pick, td\.pick \{[^}]*width:\s*44px/)
  assert.match(css, /th:nth-child\(2\), td\.id \{[^}]*width:\s*80px/)
  assert.match(css, /th:nth-child\(3\), td\.title \{[^}]*width:\s*270px/)
  assert.match(css, /th:nth-child\(4\), td\.company \{[^}]*width:\s*300px/)
  assert.match(css, /th:nth-child\(5\), td\.check-type \{[^}]*width:\s*85px/)
  assert.match(css, /th:nth-child\(6\), td\.executors \{[^}]*width:\s*82px/)
  assert.match(css, /th:nth-child\(7\), td\.num \{[^}]*width:\s*78px/)
  assert.match(css, /th:nth-child\(8\), th:nth-child\(9\), td\.date \{[^}]*width:\s*110px/)
  assert.match(css, /th:nth-child\(10\), td:last-child \{[^}]*width:\s*112px/)
  assert.match(css, /td\.title, td\.company \{[^}]*overflow-wrap:\s*anywhere/)
  assert.match(css, /td\.title, td\.company \{[^}]*font-weight:\s*500/)
})

test('a non-selectable row shows a disabled checkbox rather than an empty cell', () => {
  const script = renderPage().split('<script>')[1]
  const cell = script.slice(script.indexOf('const selectCell'), script.indexOf('const renderRow'))

  // 计划列表不按状态排序，逾期行常夹在中间；一整列空白会被读成「功能坏了」。
  assert.match(cell, /disabled title="[^"]*已逾期未结束[^"]*"/, '非逾期行需给出禁用态与原因')
  // 禁用项不带 data-pick，选择逻辑与可选行的查询保持一致。
  const disabledBranch = cell.slice(cell.indexOf('disabled'))
  assert.doesNotMatch(disabledBranch, /data-pick/)
})

test('preview failures report into an element that is visible at the time', () => {
  const html = renderPage()
  const script = html.split('<script>')[1]

  // #mail-result 位于 #mail-preview 内部，而该面板要等预览成功才显示；
  // 把失败反馈写进去，等于让「缺少映射」「计划已结束」这类拦截静默无声。
  const previewPanelStart = html.indexOf('<section id="mail-preview"')
  const previewPanel = html.slice(previewPanelStart, html.indexOf('</section>', previewPanelStart))
  assert.match(previewPanel, /id="mail-result"/, '前提：结果行确实在预览面板内')

  const actionBarStart = html.indexOf('id="mail-actionbar"')
  const actionBar = html.slice(actionBarStart, html.indexOf('</div>', actionBarStart))
  assert.match(actionBar, /id="mail-feedback"/, '操作栏需要一个始终可见的反馈位')

  const handler = script.slice(script.indexOf("#mail-preview-button"))
  const call = handler.slice(0, handler.indexOf('\n', handler.indexOf('exclusive(')))
  assert.match(call, /exclusive\(mailFeedback/, '预览反馈必须写到操作栏，而不是尚未显示的面板')
})
