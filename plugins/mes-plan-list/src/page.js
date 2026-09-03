/**
 * 插件页面。既能独立访问（跟随系统明暗），也能嵌在 DSH 中央列的 iframe 里，
 * 由 client.js 通过 postMessage 推送 DSH 的明暗主题。
 */
export function applyFilterSelection(form, pickerName, syncAllChip, runQuery) {
  syncAllChip(pickerName)
  if (form.reportValidity()) runQuery(false)
}

export function paginatePlans(plans, requestedPage, pageSize) {
  const total = plans.length
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(1, requestedPage), totalPages)
  const start = (page - 1) * pageSize
  return { items: plans.slice(start, start + pageSize), page, totalPages, total }
}

/** 只有「已逾期未结束」(status 3) 的计划能进入风险交底邮件。 */
export function isOverdue(plan) {
  return Number(plan?.status) === 3
}

/** 设置页由 URL hash 标记，刷新后据此回到用户当时看的那一页。 */
export function isSettingsView(hash) {
  return hash === '#settings'
}

export function toggleSelection(selected, id, checked) {
  if (checked) selected.add(id)
  else selected.delete(id)
  return selected
}

/** 表头全选只作用于当前页，并跳过不可选的行。 */
export function setPageSelection(selected, plans, checked) {
  for (const plan of plans) {
    if (!isOverdue(plan)) continue
    if (checked) selected.add(plan.id)
    else selected.delete(plan.id)
  }
  return selected
}

export function pageSelectionState(selected, plans) {
  const selectable = plans.filter(isOverdue)
  const chosen = selectable.filter((plan) => selected.has(plan.id)).length
  if (selectable.length === 0 || chosen === 0) return 'none'
  return chosen === selectable.length ? 'all' : 'partial'
}

/**
 * 刷新后对账。计划可能已被关闭，或根本不在新结果里；这些 ID 必须立刻退出选择，
 * 否则用户会带着一个「看不见却仍会发信」的选中项去点确认。
 */
export function reconcileSelection(selected, plans) {
  const eligible = new Set(plans.filter(isOverdue).map((plan) => plan.id))
  return new Set([...selected].filter((id) => eligible.has(id)))
}

/** 发送的三个前置：拿到令牌、显式勾选确认、当前没有进行中的请求。 */
export function canSend({ token, confirmed, busy }) {
  return typeof token === 'string' && token !== '' && confirmed === true && busy !== true
}

export function importSummary(preview) {
  const added = preview.added.length
  const updated = preview.updated.length
  return {
    added,
    updated,
    unchanged: preview.unchanged.length,
    errors: preview.errors.length,
    // 零变更也不提交：那只会白写一次全表。
    canCommit: preview.canCommit === true && added + updated > 0,
  }
}

export function formatImportError(error) {
  const message = String(error?.message ?? '')
  return Number.isInteger(error?.rowNumber) && error.rowNumber > 0
    ? `第 ${error.rowNumber} 行：${message}`
    : message
}

export function sendSummary(result) {
  return {
    text: '共 ' + result.totalMessages + ' 封，成功 ' + result.succeeded + ' 封，失败 ' + result.failed + ' 封。',
    canRetry: result.failed > 0 && typeof result.retryToken === 'string' && result.retryToken !== '',
    retryToken: result.retryToken,
  }
}

export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MES 实施计划</title>
  <style>
    :root {
      --bg: #faf9f7;
      --surface: #ffffff;
      --surface-sunken: #f4f2ef;
      --border: #e5e1db;
      --text: #2b2723;
      --muted: #7a736b;
      --accent: #c96442;
      --shadow: 0 1px 2px rgb(43 39 35 / .06), 0 1px 8px rgb(43 39 35 / .04);
      --ok-bg: #e8f3ec; --ok-fg: #1f6b42;
      --run-bg: #e7eefb; --run-fg: #24528f;
      --idle-bg: #eeecea; --idle-fg: #6b645c;
      --late-bg: #fdeceb; --late-fg: #a32f26;
      --warn-bg: #fdf3e3; --warn-fg: #8a5a1a;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --bg: #1b1917; --surface: #232120; --surface-sunken: #1f1d1b; --border: #35322f;
        --text: #ece8e3; --muted: #a09890; --accent: #e08a68;
        --shadow: 0 1px 2px rgb(0 0 0 / .3);
        --ok-bg: #16301f; --ok-fg: #7fca9c;
        --run-bg: #172438; --run-fg: #8fb3e8;
        --idle-bg: #2a2725; --idle-fg: #a09890;
        --late-bg: #3a1d1a; --late-fg: #ec9086;
        --warn-bg: #35291a; --warn-fg: #e3b273;
      }
    }
    :root[data-theme="dark"] {
      --bg: #1b1917; --surface: #232120; --surface-sunken: #1f1d1b; --border: #35322f;
      --text: #ece8e3; --muted: #a09890; --accent: #e08a68;
      --shadow: 0 1px 2px rgb(0 0 0 / .3);
      --ok-bg: #16301f; --ok-fg: #7fca9c;
      --run-bg: #172438; --run-fg: #8fb3e8;
      --idle-bg: #2a2725; --idle-fg: #a09890;
      --late-bg: #3a1d1a; --late-fg: #ec9086;
      --warn-bg: #35291a; --warn-fg: #e3b273;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .shell { max-width: 1440px; margin: 0 auto; padding: 28px 24px 48px; }

    header { margin-bottom: 20px; }
    h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; letter-spacing: .01em; }
    .lede { margin: 0; color: var(--muted); font-size: 13px; }

    .filters {
      display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-end;
      background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
      padding: 16px; box-shadow: var(--shadow);
    }
    .field { display: grid; gap: 6px; }
    .field > span { font-size: 12px; font-weight: 500; color: var(--muted); }
    input, select {
      font: inherit; color: var(--text); background: var(--surface);
      border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; min-width: 150px;
    }
    input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
    button {
      font: inherit; font-weight: 500; color: #fff; background: var(--accent);
      border: none; border-radius: 8px; padding: 8px 20px; cursor: pointer;
    }
    button:hover { filter: brightness(1.06); }
    button:disabled { opacity: .55; cursor: progress; }

    /* 多选筛选：MES 只接受单值，多选靠本地缓存筛，所以这里用复选片而非下拉。 */
    .picker { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .picker-label { font-size: 12px; font-weight: 500; color: var(--muted); margin-right: 4px; min-width: 28px; }
    .picker label {
      display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
      border: 1px solid var(--border); border-radius: 999px; padding: 3px 11px;
      font-size: 12px; color: var(--muted); user-select: none;
    }
    .picker label:hover { border-color: var(--accent); color: var(--text); }
    .picker input { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
    .picker label:has(input:checked) {
      background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500;
    }
    .picker label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
    .chip {
      background: transparent; border: 1px solid var(--border); border-radius: 999px;
      padding: 3px 11px; font-size: 12px; font-weight: 400; color: var(--muted); cursor: pointer;
    }
    .chip:hover { background: var(--surface-sunken); border-color: var(--accent); color: var(--text); filter: none; }
    .chip[data-active] {
      background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500;
    }
    .chip[data-active]:hover { background: var(--accent); color: #fff; }

    .status { margin: 18px 0 12px; min-height: 20px; font-size: 13px; color: var(--muted); }
    .status[data-tone="error"] {
      color: var(--late-fg); background: var(--late-bg); border-radius: 8px;
      padding: 10px 12px; margin-bottom: 0;
    }
    .status[data-tone="stale"] {
      color: var(--warn-fg); background: var(--warn-bg); border-radius: 8px;
      padding: 10px 12px;
    }

    .table-wrap {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; box-shadow: var(--shadow); overflow-x: auto;
    }
    table { border-collapse: collapse; width: 100%; min-width: 1270px; table-layout: fixed; font-size: 13px; }
    th, td { padding: 10px 14px; text-align: left; vertical-align: top; }
    th {
      background: var(--surface-sunken); color: var(--muted);
      font-weight: 500; font-size: 12px; white-space: nowrap;
      border-bottom: 1px solid var(--border);
    }
    tbody tr + tr td { border-top: 1px solid var(--border); }
    tbody tr:hover td { background: var(--surface-sunken); }
    /* 十列合计 1270px：所有宽度在这里统一预算，避免单列扩张挤出右侧内容。 */
    th:nth-child(2), td.id { width: 80px; }
    th:nth-child(3), td.title { width: 270px; }
    th:nth-child(4), td.company { width: 300px; }
    th:nth-child(5), td.check-type { width: 85px; }
    th:nth-child(6), td.executors { width: 82px; overflow-wrap: anywhere; }
    th:nth-child(7), td.num { width: 78px; }
    th:nth-child(7) { white-space: normal; }
    th:nth-child(8), th:nth-child(9), td.date { width: 110px; }
    th:nth-child(10), td:last-child { width: 112px; }
    td.title, td.company { font-family: inherit; font-weight: 500; overflow-wrap: anywhere; }
    td.id, td.num, td.date { white-space: nowrap; font-variant-numeric: tabular-nums; }
    /* 全局的 input{min-width:150px;padding:7px 10px} 会把复选框拉成一条 150px 的扁条，
       在表格里完全认不出是可勾选的控件，所以这里必须逐项复位。 */
    th.pick, td.pick { width: 44px; padding-left: 14px; padding-right: 0; }
    .pick input { min-width: 0; width: 16px; height: 16px; padding: 0; margin: 0; border-radius: 4px; accent-color: var(--accent); cursor: pointer; }
    .pick input:disabled { opacity: 0.3; cursor: not-allowed; }
    .mail-actionbar .feedback { margin: 0; font-size: 12px; color: var(--muted); }
    td.id, td.date { color: var(--muted); }
    td.num { text-align: right; }

    .pagination {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
      margin-top: 12px; color: var(--muted); font-size: 13px;
    }
    .pagination-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .pagination label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
    .pagination select { min-width: 0; padding: 5px 8px; }
    .pagination .ghost { padding: 5px 12px; }
    .pagination button:disabled { cursor: not-allowed; }

    .badge {
      display: inline-block; white-space: nowrap; border-radius: 999px;
      padding: 2px 9px; font-size: 12px; font-weight: 500;
      background: var(--idle-bg); color: var(--idle-fg);
    }
    .badge[data-status="1"] { background: var(--run-bg); color: var(--run-fg); }
    .badge[data-status="2"] { background: var(--ok-bg); color: var(--ok-fg); }
    .badge[data-status="3"] { background: var(--late-bg); color: var(--late-fg); }

    .empty {
      background: var(--surface); border: 1px dashed var(--border); border-radius: 12px;
      padding: 44px 20px; text-align: center; color: var(--muted);
    }

    .head-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .ghost {
      background: transparent; color: var(--muted); border: 1px solid var(--border);
      font-weight: 400; padding: 6px 14px;
    }
    .ghost:hover { background: var(--surface); color: var(--text); filter: none; }

    .banner {
      display: none; align-items: baseline; gap: 8px; flex-wrap: wrap;
      background: var(--warn-bg); color: var(--warn-fg);
      border-radius: 10px; padding: 11px 14px; margin-bottom: 16px; font-size: 13px;
    }
    .banner[data-show] { display: flex; }
    .banner code {
      background: var(--surface); color: var(--text); border-radius: 5px;
      padding: 1px 6px; font-size: 12px;
    }

    .panel {
      display: none; background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: var(--shadow);
    }
    .panel[data-show] { display: block; }
    body[data-view="settings"] .shell > :not(#settings-view) { display: none; }
    #settings-view { margin-top: 16px; }
    .settings-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
    .settings-head h1 { margin: 0; font-size: 20px; }
    .panel h2 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
    .panel .hint { margin: 0 0 12px; color: var(--muted); font-size: 12px; }
    .panel .row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
    .panel .field { flex: 1 1 380px; }
    .panel input { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    .panel .confirm { display: inline-flex; align-items: center; gap: 8px; margin: 16px 0 12px; cursor: pointer; white-space: nowrap; font-size: 12px; }
    .panel .confirm input { min-width: 0; width: 16px; height: 16px; padding: 0; margin: 0; accent-color: var(--accent); }
    #mail-preview-groups { font-size: 12px; }
    #mail-preview-groups pre { font: inherit; white-space: pre-wrap; }
    .panel .feedback { margin: 10px 0 0; font-size: 12px; color: var(--muted); min-height: 16px; }
    .panel .feedback[data-tone="error"] { color: var(--late-fg); }
    .panel .feedback[data-tone="ok"] { color: var(--ok-fg); }
    .panel .rule { border: none; border-top: 1px solid var(--border); margin: 18px 0 14px; }
    .panel .version {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
      color: var(--muted); margin-right: auto;
    }
    .panel .output {
      margin: 12px 0 0; padding: 10px 12px; border-radius: 8px;
      background: var(--surface-sunken); color: var(--muted);
      font-size: 12px; white-space: pre-wrap; overflow-x: auto;
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="head-row">
      <div>
        <h1>MES 实施计划</h1>
        <p class="lede">通过本机 mes CLI 只读查询。</p>
      </div>
      <button type="button" id="settings-toggle" class="ghost">设置</button>
    </header>

    <p id="auth-banner" class="banner" role="status"></p>

    <section id="settings-view" class="panel">
      <div class="settings-head">
        <h1>插件设置</h1>
        <button type="button" id="settings-back" class="ghost">返回列表</button>
      </div>
      <h2>插件版本</h2>
      <p class="hint">更新会在本机仓库执行 <code>git pull --ff-only</code>，凭据由 <code>gh</code> 或 ssh-agent 持有，插件不经手；工作区有未提交改动时会拒绝。更新后需重启 DSH 才生效。</p>
      <div class="row">
        <span id="plugin-version" class="version">读取中…</span>
        <button type="button" id="check-plugin" class="ghost">检查更新</button>
        <button type="button" id="update-plugin" hidden>更新插件</button>
      </div>
      <p id="plugin-feedback" class="feedback" role="status"></p>
      <p id="github-auth" class="feedback" role="status"></p>

      <hr class="rule">
      <h2>mes CLI 版本</h2>
      <p class="hint">检查更新会访问 mes 的更新服务器，只在点击时发生。更新会替换本机的 mes 二进制，期间查询会被暂时拒绝。</p>
      <div class="row">
        <span id="cli-version" class="version">读取中…</span>
        <button type="button" id="check-cli" class="ghost">检查更新</button>
        <button type="button" id="update-cli" hidden>更新 mes</button>
      </div>
      <pre id="cli-output" class="output" hidden></pre>
      <p id="cli-feedback" class="feedback" role="status"></p>

      <hr class="rule">
      <h2>本地缓存</h2>
      <p class="hint">查询结果保存在本机数据库里，不会上传。同步时会自动覆盖此前缓存过的全部日期范围，因此不会残留已在 MES 侧删除的计划——缓存范围越大，同步越慢。清空缓存可把范围重置。</p>
      <div class="row">
        <span id="cache-info" class="version">读取中…</span>
        <button type="button" id="clear-cache" class="ghost">清空缓存</button>
      </div>
      <p id="cache-feedback" class="feedback" role="status"></p>

      <h2 id="mail-panel">逾期风险邮件提醒</h2>
      <p class="hint">只有「已逾期未结束」的计划可以发送。密码保存在 macOS 钥匙串，邮箱映射与发送历史保存在本机独立数据库，清空计划缓存不会删除它们。</p>

      <form id="mail-settings-form" class="mail-form">
        <label class="field"><span>发件人名称</span><input id="mail-sender-name" type="text" autocomplete="off"></label>
        <label class="field"><span>发件邮箱</span><input id="mail-sender-email" type="email" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>SMTP 主机</span><input id="mail-host" type="text" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>端口</span><input id="mail-port" type="number" min="1" max="65535"></label>
        <label class="field"><span>安全模式</span><select id="mail-security"><option value="tls">SSL/TLS</option><option value="starttls">强制 STARTTLS</option></select></label>
        <label class="field"><span>SMTP 用户名</span><input id="mail-username" type="text" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>客户端专用密码</span><input id="mail-password" type="password" autocomplete="new-password" placeholder="留空则保留已保存的密码"></label>
        <label class="field wide"><span>邮件主题</span><input id="mail-subject" type="text"></label>
        <label class="field wide"><span>邮件正文</span><textarea id="mail-body" rows="5"></textarea></label>
        <p class="hint">模板变量仅支持 {{executorName}}、{{planCount}}、{{planList}}。</p>
        <div class="row">
          <button type="button" id="save-mail-settings">保存设置</button>
          <input id="mail-test-recipient" type="email" placeholder="测试收件地址" spellcheck="false">
          <button type="button" id="test-mail" class="ghost">发送测试邮件</button>
          <button type="button" id="clear-mail-password" class="ghost">清除已存密码</button>
        </div>
        <p id="mail-settings-feedback" class="feedback" role="status"></p>
      </form>

      <h3>执行人邮箱映射</h3>
      <div class="row">
        <button type="button" id="mapping-template" class="ghost">下载导入模板</button>
        <label class="ghost file"><span>导入 Excel</span><input id="mapping-import-file" type="file" accept=".xlsx"></label>
      </div>
      <p class="hint">导出文件包含真实邮箱，属于私有数据，请勿提交到仓库或转发。</p>
      <div class="row">
        <button type="button" id="mapping-export" class="ghost">导出映射</button>
      </div>
      <div id="mapping-import-preview" hidden>
        <p id="mapping-import-summary" class="feedback" role="status"></p>
        <ul id="mapping-import-errors" class="mail-errors"></ul>
        <button type="button" id="mapping-import-commit" disabled>确认导入</button>
      </div>
      <table id="mail-mappings" class="mail-table"><tbody></tbody></table>
      <p id="mail-mappings-feedback" class="feedback" role="status"></p>

      <h3>发送历史</h3>
      <div class="row">
        <button type="button" id="clear-mail-history" class="ghost">清空历史</button>
      </div>
      <div id="mail-history"></div>
    </section>

    <form id="query-form" class="filters">
      <label class="field"><span>开始日期</span><input name="startDate" type="date" required></label>
      <label class="field"><span>结束日期</span><input name="endDate" type="date" required></label>
      <button type="submit">查询</button>
      <button type="button" id="sync" class="ghost">同步最新数据</button>

      <div class="picker" data-picker="range">
        <span class="picker-label">快捷</span>
        <button type="button" class="chip" data-days="7">最近 7 天</button>
        <button type="button" class="chip" data-days="30">最近 30 天</button>
        <button type="button" class="chip" data-days="90">最近 90 天</button>
      </div>

      <div class="picker" data-picker="status">
        <span class="picker-label">状态</span>
        <button type="button" class="chip" data-clear="status">全部</button>
        <label><input type="checkbox" value="0"><span>未开始</span></label>
        <label><input type="checkbox" value="1"><span>进行中</span></label>
        <label><input type="checkbox" value="3"><span>已逾期未结束</span></label>
      </div>
      <div class="picker" data-picker="checkType">
        <span class="picker-label">类型</span>
        <button type="button" class="chip" data-clear="checkType">全部</button>
        <label><input type="checkbox" value="0"><span>巡检</span></label>
        <label><input type="checkbox" value="1"><span>培训</span></label>
        <label><input type="checkbox" value="2"><span>现场人天</span></label>
        <label><input type="checkbox" value="3"><span>驻场</span></label>
        <label><input type="checkbox" value="4"><span>售前POC</span></label>
        <label><input type="checkbox" value="5"><span>维保</span></label>
        <label><input type="checkbox" value="6"><span>内部事项</span></label>
      </div>
    </form>

    <p id="status" class="status" role="status"></p>
    <div id="mail-actionbar" class="mail-actionbar" hidden>
      <span id="mail-selected-count">已选 0 条</span>
      <button type="button" id="mail-clear-selection" class="ghost">清空选择</button>
      <button type="button" id="mail-preview-button">生成邮件预览</button>
      <span id="mail-feedback" class="feedback" role="status"></span>
    </div>
    <section id="mail-preview" class="panel">
      <h2>邮件预览</h2>
      <div id="mail-preview-groups"></div>
      <label class="confirm"><input id="mail-confirm" type="checkbox"> 我已逐封核对上述内容，确认发送</label>
      <div class="row">
        <button type="button" id="mail-send" disabled>确认发送</button>
        <button type="button" id="mail-cancel" class="ghost">取消</button>
        <button type="button" id="mail-retry" hidden>重试失败项</button>
      </div>
      <p id="mail-result" class="feedback" role="status"></p>
    </section>
    <div id="results"></div>
  </div>

  <script>
    const form = document.querySelector('#query-form')
    const submit = form.querySelector('button')
    const status = document.querySelector('#status')
    const results = document.querySelector('#results')
    const applyFilterSelection = ${applyFilterSelection}
    const paginatePlans = ${paginatePlans}
    const isOverdue = ${isOverdue}
    const isSettingsView = ${isSettingsView}
    const toggleSelection = ${toggleSelection}
    const setPageSelection = ${setPageSelection}
    const pageSelectionState = ${pageSelectionState}
    const reconcileSelection = ${reconcileSelection}
    const canSend = ${canSend}
    const importSummary = ${importSummary}
    const formatImportError = ${formatImportError}
    const sendSummary = ${sendSummary}

    /** 跨页选择的唯一真相，活在表格渲染之外，因此翻页不会丢。 */
    let selectedPlanIds = new Set()

    // 面板嵌在 DSH 中央列时跟随外壳主题；独立打开时保持 prefers-color-scheme。
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return
      const mode = event.data && event.data.mesPlanTheme
      if (mode === 'dark' || mode === 'light') document.documentElement.dataset.theme = mode
    })

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

    const banner = document.querySelector('#auth-banner')
    const settingsView = document.querySelector('#settings-view')
    const githubAuth = document.querySelector('#github-auth')
    let githubAuthRequested = false

    /*
     * hint 来自后端，先 escapeHtml 再把反引号里的命令包成 <code>。顺序不能反：转义在
     * 前，<code> 就只可能是这一行本地加的，后端字符串没有任何机会带出标签。
     */
    const showGithubAuth = (payload) => {
      if (payload.state === 'ready') {
        githubAuth.textContent = '更新所需的 GitHub 授权已就绪。'
        githubAuth.dataset.tone = 'ok'
        return
      }
      githubAuth.innerHTML = escapeHtml(payload.hint).replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      // 本机看得见私钥不代表 GitHub 接受它，但那也不是故障。既不报错也不报绿，保持中性。
      if (payload.state === 'ssh-unverified') delete githubAuth.dataset.tone
      else githubAuth.dataset.tone = 'error'
    }

    /*
     * 后端要跑 git 和 gh 两条子进程才答得出这个问题，而计划列表页用不到它——所以挂在
     * 进入设置视图时请求，只看列表的人不必付这笔开销。探针跑的全是本地命令，不联网。
     * 成功后不再重复请求；失败则允许下次进入设置页时重试。
     */
    const loadGithubAuth = async () => {
      if (githubAuthRequested) return
      githubAuthRequested = true
      try {
        const response = await fetch('/api/plugins/mes-plan-list/github-auth')
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '无法读取 GitHub 授权状态')
        showGithubAuth(payload)
      } catch (error) {
        githubAuthRequested = false
        githubAuth.textContent = error.message || '无法读取 GitHub 授权状态'
        githubAuth.dataset.tone = 'error'
      }
    }

    // 视图由 URL hash 决定，刷新或前进后退都会回到用户当时看的那一页。
    const syncSettingsView = () => {
      if (isSettingsView(location.hash)) {
        document.body.dataset.view = 'settings'
        settingsView.setAttribute('data-show', '')
        loadGithubAuth()
      } else {
        delete document.body.dataset.view
        settingsView.removeAttribute('data-show')
      }
    }
    window.addEventListener('hashchange', syncSettingsView)
    syncSettingsView()

    document.querySelector('#settings-toggle').addEventListener('click', () => {
      location.hash = 'settings'
    })
    document.querySelector('#settings-back').addEventListener('click', () => {
      location.hash = ''
    })

    const showBanner = (html) => {
      banner.innerHTML = html
      banner.setAttribute('data-show', '')
    }

    // 登录状态是查询能否成功的前提，页面一打开就查，不等用户先失败一次。
    const refreshAuth = async () => {
      banner.removeAttribute('data-show')
      try {
        const response = await fetch('/api/plugins/mes-plan-list/auth')
        const payload = await response.json()
        if (!response.ok || !payload.ok) {
          showBanner(escapeHtml(payload.error || '无法读取 MES 登录状态。'))
          return
        }
        if (!payload.loggedIn) {
          showBanner('本机 mes CLI 未登录，查询会失败。请在终端执行 <code>mes auth login</code> 后重试。')
        }
      } catch {
        showBanner('无法读取 MES 登录状态。')
      }
    }

    const day = (value) => String(value ?? '').slice(0, 10)
    const executors = (plan) => (plan.executorList ?? []).map((row) => row.executorName).filter(Boolean).join('、')

    const setStatus = (text, tone) => {
      status.textContent = text
      if (tone) status.dataset.tone = tone
      else delete status.dataset.tone
    }

    const selectCell = (plan) => isOverdue(plan)
      ? '<td class="pick"><input type="checkbox" data-pick="' + escapeHtml(plan.id) + '"'
        + (selectedPlanIds.has(plan.id) ? ' checked' : '') + ' aria-label="选择计划 ' + escapeHtml(plan.id) + '"></td>'
      // 非逾期计划渲染为禁用复选框而不是留空。列表不按状态排序，逾期行常被夹在
      // 中间，一整列空白读起来像功能坏了；禁用态才说明「这一行本来就不能选」。
      : '<td class="pick"><input type="checkbox" disabled title="仅「已逾期未结束」的计划可以发送风险提醒"></td>'

    const renderRow = (plan) => '<tr>'
      + selectCell(plan)
      + '<td class="id">' + escapeHtml(plan.id) + '</td>'
      + '<td class="title">' + escapeHtml(plan.title) + '</td>'
      + '<td class="company">' + escapeHtml(plan.contractName) + '</td>'
      + '<td class="check-type">' + escapeHtml(plan.checkTypeDesc) + '</td>'
      + '<td class="executors">' + escapeHtml(executors(plan)) + '</td>'
      + '<td class="num">' + escapeHtml(plan.windowHours ?? '—') + '</td>'
      + '<td class="date">' + escapeHtml(day(plan.startDate)) + '</td>'
      + '<td class="date">' + escapeHtml(day(plan.endDate)) + '</td>'
      + '<td><span class="badge" data-status="' + escapeHtml(plan.status) + '">' + escapeHtml(plan.statusDesc) + '</span></td>'
      + '</tr>'

    const renderPlans = (plans) => {
      if (plans.length === 0) {
        results.innerHTML = '<p class="empty">没有符合条件的实施计划。</p>'
        return
      }
      const paged = paginatePlans(plans, currentPage, pageSize)
      currentPage = paged.page
      const state = pageSelectionState(selectedPlanIds, paged.items)
      const header = '<th class="pick"><input type="checkbox" id="pick-page"'
        + (state === 'all' ? ' checked' : '') + ' aria-label="选择本页全部逾期计划"></th>'
      const labels = ['计划ID', '计划标题', '合同名称', '合同类型', '执行人', '报工工时(h)', '计划开始', '计划结束', '进行状态']
      results.innerHTML = '<div class="table-wrap"><table><thead><tr>'
        + header
        + labels.map((label) => '<th>' + label + '</th>').join('')
        + '</tr></thead><tbody>' + paged.items.map(renderRow).join('') + '</tbody></table></div>'
        + '<div class="pagination"><span>共 ' + paged.total + ' 条，第 ' + paged.page + ' / ' + paged.totalPages + ' 页</span>'
        + '<div class="pagination-controls"><label>每页 <select id="page-size" aria-label="每页条数">'
        + [20, 30, 40, 50, 100].map((size) => '<option value="' + size + '"' + (size === pageSize ? ' selected' : '') + '>' + size + ' 条</option>').join('')
        + '</select></label><button type="button" class="ghost" data-page="previous"' + (paged.page === 1 ? ' disabled' : '') + '>上一页</button>'
        + '<button type="button" class="ghost" data-page="next"' + (paged.page === paged.totalPages ? ' disabled' : '') + '>下一页</button></div></div>'
      const pickPage = results.querySelector('#pick-page')
      if (pickPage !== null) pickPage.indeterminate = state === 'partial'
      updateMailActionBar()
    }

    results.addEventListener('change', (event) => {
      const target = event.target
      if (target.id === 'pick-page') {
        setPageSelection(selectedPlanIds, paginatePlans(lastPlans, currentPage, pageSize).items, target.checked)
        renderPlans(lastPlans)
        return
      }
      if (target.dataset === undefined || target.dataset.pick === undefined) return
      toggleSelection(selectedPlanIds, Number(target.dataset.pick), target.checked)
      const pickPage = results.querySelector('#pick-page')
      if (pickPage !== null) {
        const state = pageSelectionState(selectedPlanIds, paginatePlans(lastPlans, currentPage, pageSize).items)
        pickPage.checked = state === 'all'
        pickPage.indeterminate = state === 'partial'
      }
      updateMailActionBar()
    })

    const DAY_MS = 24 * 60 * 60 * 1000
    const sync = document.querySelector('#sync')

    /** 最近一次查询的结果，供分页和选择状态重绘。 */
    let lastPlans = []
    let currentPage = 1
    let pageSize = 20

    results.addEventListener('click', (event) => {
      const direction = event.target.dataset.page
      if (direction === 'previous') currentPage -= 1
      else if (direction === 'next') currentPage += 1
      else return
      renderPlans(lastPlans)
    })

    results.addEventListener('change', (event) => {
      if (event.target.id !== 'page-size') return
      pageSize = Number(event.target.value)
      currentPage = 1
      renderPlans(lastPlans)
    })

    /** 「全部」按钮的选中态：该组一个都没勾时，就是「全部」。 */
    const syncAllChip = (name) => {
      const chip = document.querySelector('.chip[data-clear="' + name + '"]')
      if (chip !== null) chip.toggleAttribute('data-active', picked(name).length === 0)
    }

    /** 某个多选组里被勾中的值；空数组表示不限。 */
    const picked = (name) => Array.from(
      document.querySelectorAll('[data-picker="' + name + '"] input:checked'),
      (input) => input.value,
    )

    /** 数据是本地缓存，必须让用户看见它有多新，否则会拿陈旧数据做判断。 */
    const describeFreshness = (syncedAt) => {
      const at = new Date(syncedAt)
      if (Number.isNaN(at.getTime())) return ''
      const stale = Date.now() - at.getTime() > DAY_MS
      const shown = at.toLocaleString('zh-CN', { hour12: false })
      return { text: '数据更新至 ' + shown + (stale ? '，已超过 1 天，请及时更新数据。' : '。'), stale }
    }

    const runQuery = async (refresh) => {
      submit.disabled = true
      sync.disabled = true
      setStatus(refresh ? '正在从 MES 同步计划与报工工时，时间范围越大越慢…' : '正在查询…')
      results.innerHTML = ''
      const values = new FormData(form)
      try {
        const response = await fetch('/api/plugins/mes-plan-list/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            startDate: values.get('startDate'),
            endDate: values.get('endDate'),
            statuses: picked('status'),
            checkTypes: picked('checkType'),
            refresh,
          }),
        })
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '查询失败，请稍后重试')
        // 工时随窗口变化，所以由服务端按当前窗口给出；首次查询当前窗口时，
        // 服务端会自动补齐缓存。
        lastPlans = payload.plans
        // 刷新后对账：已关闭或已消失的计划立刻退出选择。
        selectedPlanIds = reconcileSelection(selectedPlanIds, lastPlans)
        currentPage = 1
        if (payload.hours !== null && payload.hours !== undefined) {
          for (const plan of lastPlans) plan.windowHours = payload.hours[plan.id] ?? 0
        }
        const freshness = describeFreshness(payload.syncedAt)
        setStatus('共 ' + payload.plans.length + ' 条。' + (freshness === '' ? '' : ' ' + freshness.text),
          freshness !== '' && freshness.stale ? 'stale' : undefined)
        renderPlans(payload.plans)
        // 同步会扩大缓存覆盖的范围，设置面板里的概况要跟着变。
        if (!payload.fromCache) loadCache()
      } catch (error) {
        setStatus(error.message || '查询失败，请稍后重试', 'error')
      } finally {
        submit.disabled = false
        sync.disabled = false
      }
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      runQuery(false)
    })

    // 日期快捷选择：结束日期取今天，开始日期往前推 N-1 天，含今天共 N 天。
    const iso = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    for (const chip of document.querySelectorAll('.chip[data-days]')) {
      chip.addEventListener('click', () => {
        const days = Number(chip.dataset.days)
        const today = new Date()
        const from = new Date(today)
        from.setDate(from.getDate() - (days - 1))
        form.startDate.value = iso(from)
        form.endDate.value = iso(today)
        runQuery(false)
      })
    }

    sync.addEventListener('click', () => {
      if (form.reportValidity()) runQuery(true)
    })

    const cliVersion = document.querySelector('#cli-version')
    const cliOutput = document.querySelector('#cli-output')
    const cliFeedback = document.querySelector('#cli-feedback')
    const checkCli = document.querySelector('#check-cli')
    const updateCli = document.querySelector('#update-cli')

    // 打开页面只读本机版本，不联网；检查更新是用户主动点出来的动作。
    const loadCliVersion = async () => {
      try {
        const response = await fetch('/api/plugins/mes-plan-list/cli')
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '无法读取 mes 版本')
        cliVersion.textContent = 'mes ' + payload.version
      } catch (error) {
        cliVersion.textContent = 'mes 版本未知'
        cliFeedback.textContent = error.message || '无法读取 mes 版本'
        cliFeedback.dataset.tone = 'error'
      }
    }

    checkCli.addEventListener('click', async () => {
      checkCli.disabled = true
      cliFeedback.textContent = '正在检查…'
      delete cliFeedback.dataset.tone
      try {
        const response = await fetch('/api/plugins/mes-plan-list/cli?check=1')
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '检查更新失败')
        cliVersion.textContent = 'mes ' + payload.version
        cliOutput.textContent = payload.output
        cliOutput.hidden = payload.output === ''
        // 认不出「已是最新」时保留更新入口：宁可多显示一个按钮，也不要在 MES 改
        // 文案后把有更新说成没更新。
        updateCli.hidden = payload.upToDate
        cliFeedback.textContent = payload.upToDate ? '已是最新版本。' : 'mes 可能有新版本，请看上方输出。'
        cliFeedback.dataset.tone = payload.upToDate ? 'ok' : 'error'
      } catch (error) {
        cliFeedback.textContent = error.message || '检查更新失败'
        cliFeedback.dataset.tone = 'error'
      } finally {
        checkCli.disabled = false
      }
    })

    updateCli.addEventListener('click', async () => {
      updateCli.disabled = true
      checkCli.disabled = true
      submit.disabled = true
      cliFeedback.textContent = '正在更新 mes，期间查询不可用…'
      delete cliFeedback.dataset.tone
      try {
        const response = await fetch('/api/plugins/mes-plan-list/cli/update', { method: 'POST' })
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'mes 更新失败')
        cliVersion.textContent = 'mes ' + payload.version
        cliOutput.textContent = payload.output
        cliOutput.hidden = payload.output === ''
        cliFeedback.textContent = '已更新到 ' + payload.version + '。'
        cliFeedback.dataset.tone = 'ok'
        updateCli.hidden = true
        await refreshAuth()
      } catch (error) {
        cliFeedback.textContent = error.message || 'mes 更新失败'
        cliFeedback.dataset.tone = 'error'
      } finally {
        updateCli.disabled = false
        checkCli.disabled = false
        submit.disabled = false
      }
    })

    const cacheInfo = document.querySelector('#cache-info')
    const cacheFeedback = document.querySelector('#cache-feedback')
    const clearCache = document.querySelector('#clear-cache')

    const renderCache = (payload) => {
      cacheInfo.textContent = payload.count === 0
        ? '本机尚无缓存'
        : payload.count + ' 条，覆盖 ' + payload.startDate + ' ~ ' + payload.endDate
    }

    const loadCache = async () => {
      try {
        const response = await fetch('/api/plugins/mes-plan-list/cache')
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '无法读取缓存状态')
        renderCache(payload)
      } catch (error) {
        cacheInfo.textContent = '缓存状态未知'
        cacheFeedback.textContent = error.message || '无法读取缓存状态'
        cacheFeedback.dataset.tone = 'error'
      }
    }

    clearCache.addEventListener('click', async () => {
      clearCache.disabled = true
      cacheFeedback.textContent = '正在清空…'
      delete cacheFeedback.dataset.tone
      try {
        const response = await fetch('/api/plugins/mes-plan-list/cache', { method: 'DELETE' })
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '清空缓存失败')
        renderCache(payload)
        cacheFeedback.textContent = '已清空，下次查询会重新从 MES 取。'
        cacheFeedback.dataset.tone = 'ok'
      } catch (error) {
        cacheFeedback.textContent = error.message || '清空缓存失败'
        cacheFeedback.dataset.tone = 'error'
      } finally {
        clearCache.disabled = false
      }
    })

    const pluginVersion = document.querySelector('#plugin-version')
    const pluginFeedback = document.querySelector('#plugin-feedback')
    const checkPlugin = document.querySelector('#check-plugin')
    const updatePlugin = document.querySelector('#update-plugin')

    // 显示发布版本号；本地领先于该版本时把领先的提交数一并标出，避免让人以为
    // 自己正好停在那个发布版本上。
    const showPluginVersion = (payload) => {
      const base = payload.version || payload.commit
      const ahead = payload.ahead > 0 ? ' +' + payload.ahead : ''
      pluginVersion.textContent = base + ahead + ' · ' + payload.branch
    }

    // 打开页面只读本地 git 信息，不联网。
    const loadPluginVersion = async () => {
      try {
        const response = await fetch('/api/plugins/mes-plan-list/plugin')
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '无法读取插件版本')
        showPluginVersion(payload)
      } catch (error) {
        pluginVersion.textContent = '插件版本未知'
        pluginFeedback.textContent = error.message || '无法读取插件版本'
        pluginFeedback.dataset.tone = 'error'
      }
    }

    checkPlugin.addEventListener('click', async () => {
      checkPlugin.disabled = true
      pluginFeedback.textContent = '正在检查…'
      delete pluginFeedback.dataset.tone
      try {
        const response = await fetch('/api/plugins/mes-plan-list/plugin?check=1')
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '检查更新失败')
        showPluginVersion(payload)
        updatePlugin.hidden = payload.upToDate
        pluginFeedback.textContent = payload.upToDate
          ? '已是最新版本。'
          : '检测到新版本，可以更新。'
        pluginFeedback.dataset.tone = payload.upToDate ? 'ok' : 'error'
      } catch (error) {
        pluginFeedback.textContent = error.message || '检查更新失败'
        pluginFeedback.dataset.tone = 'error'
      } finally {
        checkPlugin.disabled = false
      }
    })

    updatePlugin.addEventListener('click', async () => {
      updatePlugin.disabled = true
      checkPlugin.disabled = true
      pluginFeedback.textContent = '正在更新…'
      delete pluginFeedback.dataset.tone
      try {
        const response = await fetch('/api/plugins/mes-plan-list/plugin/update', { method: 'POST' })
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '插件更新失败')
        showPluginVersion(payload)
        updatePlugin.hidden = true
        const target = payload.version || payload.commit
        if (payload.dependencies === 'failed') {
          // 依赖没装上就重启只会得到一个打不开的 DSH，这里不能说更新成功。
          pluginFeedback.textContent = '已更新到 ' + target + '，但依赖安装失败：'
            + (payload.dependencyError || '') + ' 插件当前不可用，请在仓库根手动执行 pnpm install 后重启 DSH。'
          pluginFeedback.dataset.tone = 'error'
        } else if (payload.changed) {
          pluginFeedback.textContent = '已更新到 ' + target
            + (payload.dependencies === 'installed' ? '，依赖已装好' : '') + '，请重启 DSH 使新版本生效。'
          pluginFeedback.dataset.tone = 'ok'
        } else {
          pluginFeedback.textContent = '已是最新版本，无需更新。'
          pluginFeedback.dataset.tone = 'ok'
        }
      } catch (error) {
        pluginFeedback.textContent = error.message || '插件更新失败'
        pluginFeedback.dataset.tone = 'error'
      } finally {
        updatePlugin.disabled = false
        checkPlugin.disabled = false
      }
    })

    for (const chip of document.querySelectorAll('.chip[data-clear]')) {
      chip.addEventListener('click', () => {
        for (const input of document.querySelectorAll('[data-picker="' + chip.dataset.clear + '"] input')) {
          input.checked = false
        }
        applyFilterSelection(form, chip.dataset.clear, syncAllChip, runQuery)
      })
    }
    for (const picker of document.querySelectorAll('[data-picker]')) {
      picker.addEventListener('change', () => {
        applyFilterSelection(form, picker.dataset.picker, syncAllChip, runQuery)
      })
    }
    syncAllChip('status')
    syncAllChip('checkType')

    refreshAuth()
    loadCliVersion()
    loadCache()
    loadPluginVersion()
    /*
     * 邮件提醒。所有来自服务端的内容（收件人、主题、正文、映射、历史）都用 textContent
     * 写入，不拼 HTML —— 这些字符串既有用户导入的，也有 MES 返回的。
     */
    const MAIL_API = '/api/plugins/mes-plan-list/mail'
    const mailPanel = document.querySelector('#mail-preview')
    const mailGroups = document.querySelector('#mail-preview-groups')
    const mailConfirm = document.querySelector('#mail-confirm')
    const mailSend = document.querySelector('#mail-send')
    const mailRetry = document.querySelector('#mail-retry')
    const mailResult = document.querySelector('#mail-result')
    const mailSettingsFeedback = document.querySelector('#mail-settings-feedback')
    const mailMappingsBody = document.querySelector('#mail-mappings tbody')
    const mailMappingsFeedback = document.querySelector('#mail-mappings-feedback')
    const mailHistory = document.querySelector('#mail-history')
    const importPreviewBox = document.querySelector('#mapping-import-preview')
    const importSummaryLine = document.querySelector('#mapping-import-summary')
    const importErrorList = document.querySelector('#mapping-import-errors')
    const importCommit = document.querySelector('#mapping-import-commit')

    let mailToken = ''
    let importToken = ''
    let mailBusy = false

    const mailFields = {
      senderName: document.querySelector('#mail-sender-name'),
      senderEmail: document.querySelector('#mail-sender-email'),
      smtpHost: document.querySelector('#mail-host'),
      smtpPort: document.querySelector('#mail-port'),
      securityMode: document.querySelector('#mail-security'),
      smtpUsername: document.querySelector('#mail-username'),
      subjectTemplate: document.querySelector('#mail-subject'),
      bodyTemplate: document.querySelector('#mail-body'),
    }

    const mailJson = async (path, options = {}) => {
      const response = await fetch(MAIL_API + path, options)
      const payload = await response.json()
      if (!response.ok || !payload.ok) throw new Error(payload.error || '操作失败，请稍后重试')
      return payload
    }

    /** 同一时刻只允许一个邮件请求在飞，避免重复发送。 */
    const exclusive = async (feedback, working, run) => {
      if (mailBusy) return
      mailBusy = true
      updateMailSendButton()
      feedback.textContent = working
      try {
        feedback.textContent = (await run()) || ''
      } catch (error) {
        feedback.textContent = error.message || '操作失败，请稍后重试'
      } finally {
        mailBusy = false
        updateMailSendButton()
      }
    }

    function updateMailSendButton() {
      mailSend.disabled = !canSend({ token: mailToken, confirmed: mailConfirm.checked, busy: mailBusy })
    }

    // 就地取节点：这个函数被提升到脚本顶部，早于下面的 const 初始化，
    // 用闭包变量会在「渲染发生在脚本求值完成前」时踩到 TDZ。
    function updateMailActionBar() {
      document.querySelector('#mail-selected-count').textContent = '已选 ' + selectedPlanIds.size + ' 条'
      document.querySelector('#mail-actionbar').hidden = selectedPlanIds.size === 0
    }

    const settingsPayload = () => ({
      senderName: mailFields.senderName.value.trim(),
      senderEmail: mailFields.senderEmail.value.trim(),
      smtpHost: mailFields.smtpHost.value.trim(),
      smtpPort: Number(mailFields.smtpPort.value),
      securityMode: mailFields.securityMode.value,
      smtpUsername: mailFields.smtpUsername.value.trim(),
      subjectTemplate: mailFields.subjectTemplate.value,
      bodyTemplate: mailFields.bodyTemplate.value,
    })

    const postJson = (path, body) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    const loadMailSettings = async () => {
      try {
        const payload = await mailJson('/settings')
        if (payload.settings !== null) {
          for (const [key, field] of Object.entries(mailFields)) field.value = payload.settings[key] ?? ''
        }
        // 密码只回报「有没有」，从不回显。
        mailSettingsFeedback.textContent = payload.hasPassword ? '已保存 SMTP 密码。' : '尚未保存 SMTP 密码。'
      } catch (error) {
        mailSettingsFeedback.textContent = error.message || '无法读取邮件设置'
      }
    }

    document.querySelector('#save-mail-settings').addEventListener('click', () => {
      const password = document.querySelector('#mail-password').value
      exclusive(mailSettingsFeedback, '正在保存…', async () => {
        const body = settingsPayload()
        if (password !== '') body.password = password
        const payload = await mailJson('/settings', { ...postJson('', body), method: 'PUT' })
        document.querySelector('#mail-password').value = ''
        return payload.hasPassword ? '已保存，SMTP 密码在钥匙串中。' : '已保存，但尚未设置 SMTP 密码。'
      })
    })

    document.querySelector('#test-mail').addEventListener('click', () => {
      const recipient = document.querySelector('#mail-test-recipient').value.trim()
      const password = document.querySelector('#mail-password').value
      exclusive(mailSettingsFeedback, '正在发送测试邮件…', async () => {
        const body = { ...settingsPayload(), recipient }
        if (password !== '') body.password = password
        await mailJson('/settings/test', postJson('', body))
        return '测试邮件已发出，请到该地址确认。'
      })
    })

    document.querySelector('#clear-mail-password').addEventListener('click', () => {
      exclusive(mailSettingsFeedback, '正在清除…', async () => {
        await mailJson('/settings/password', { method: 'DELETE' })
        return '已从钥匙串中清除 SMTP 密码。'
      })
    })

    const renderMappings = (rows) => {
      mailMappingsBody.replaceChildren()
      for (const row of rows) {
        const tr = document.createElement('tr')
        for (const value of [row.executorId, row.executorName, row.email]) {
          const td = document.createElement('td')
          td.textContent = value
          tr.append(td)
        }
        const actions = document.createElement('td')
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'ghost'
        remove.dataset.removeMapping = row.executorId
        remove.textContent = '删除'
        actions.append(remove)
        tr.append(actions)
        mailMappingsBody.append(tr)
      }
    }

    const loadMappings = async () => {
      try {
        renderMappings((await mailJson('/mappings')).mappings)
      } catch (error) {
        mailMappingsFeedback.textContent = error.message || '无法读取邮箱映射'
      }
    }

    mailMappingsBody.addEventListener('click', (event) => {
      const executorId = event.target.dataset && event.target.dataset.removeMapping
      if (executorId === undefined) return
      exclusive(mailMappingsFeedback, '正在删除…', async () => {
        renderMappings((await mailJson('/mappings?executorId=' + encodeURIComponent(executorId), { method: 'DELETE' })).mappings)
        return '已删除该执行人的邮箱。'
      })
    })

    const download = async (path, filename) => {
      const response = await fetch(MAIL_API + path)
      if (!response.ok) throw new Error('下载失败，请稍后重试')
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      URL.revokeObjectURL(url)
    }

    document.querySelector('#mapping-template').addEventListener('click', () => {
      exclusive(mailMappingsFeedback, '正在生成模板…', async () => {
        await download('/mappings/template', 'mes-plan-list-email-template.xlsx')
        return '模板已下载。'
      })
    })

    document.querySelector('#mapping-export').addEventListener('click', () => {
      exclusive(mailMappingsFeedback, '正在导出…', async () => {
        await download('/mappings/export', 'mes-plan-list-emails.xlsx')
        return '已导出，文件含真实邮箱，请妥善保管。'
      })
    })

    document.querySelector('#mapping-import-file').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0]
      if (file === undefined) return
      exclusive(mailMappingsFeedback, '正在解析…', async () => {
        const payload = await mailJson('/mappings/import-preview', {
          method: 'POST',
          headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
          body: await file.arrayBuffer(),
        })
        event.target.value = ''
        const summary = importSummary(payload)
        importToken = payload.token ?? ''
        importPreviewBox.hidden = false
        importSummaryLine.textContent = '新增 ' + summary.added + ' 条，更新 ' + summary.updated
          + ' 条，无变化 ' + summary.unchanged + ' 条，错误 ' + summary.errors + ' 条。'
        importErrorList.replaceChildren()
        for (const error of payload.errors) {
          const item = document.createElement('li')
          item.textContent = formatImportError(error)
          importErrorList.append(item)
        }
        importCommit.disabled = !summary.canCommit
        return summary.canCommit ? '' : '存在错误或没有变更，本次导入不会写入任何数据。'
      })
    })

    importCommit.addEventListener('click', () => {
      exclusive(mailMappingsFeedback, '正在导入…', async () => {
        const payload = await mailJson('/mappings/import-commit', postJson('', { token: importToken }))
        importToken = ''
        importCommit.disabled = true
        importPreviewBox.hidden = true
        renderMappings(payload.mappings)
        return '导入完成。'
      })
    })

    const renderHistory = (batches) => {
      mailHistory.replaceChildren()
      if (batches.length === 0) {
        const empty = document.createElement('p')
        empty.className = 'empty'
        empty.textContent = '暂无发送记录。'
        mailHistory.append(empty)
        return
      }
      for (const batch of batches) {
        const block = document.createElement('div')
        const title = document.createElement('p')
        title.textContent = batch.createdAt + ' · ' + sendSummary(batch).text
        block.append(title)
        const list = document.createElement('ul')
        for (const row of batch.results) {
          const item = document.createElement('li')
          item.textContent = row.executorName + ' · ' + row.maskedEmail + ' · '
            + (row.status === 'sent' ? '成功' : '失败 ' + row.errorCode)
          list.append(item)
        }
        block.append(list)
        mailHistory.append(block)
      }
    }

    const loadHistory = async () => {
      try {
        renderHistory((await mailJson('/history')).history)
      } catch {
        mailHistory.replaceChildren()
      }
    }

    document.querySelector('#clear-mail-history').addEventListener('click', () => {
      exclusive(mailMappingsFeedback, '正在清空…', async () => {
        renderHistory((await mailJson('/history', { method: 'DELETE' })).history)
        return '已清空发送历史。'
      })
    })

    const renderMailPreview = (groups) => {
      mailGroups.replaceChildren()
      for (const group of groups) {
        const details = document.createElement('details')
        const summary = document.createElement('summary')
        summary.textContent = group.executorName + ' · ' + group.maskedEmail + ' · ' + group.planIds.length + ' 个计划'
        const subject = document.createElement('p')
        subject.textContent = '主题：' + group.subject
        const body = document.createElement('pre')
        body.textContent = group.body
        details.append(summary, subject, body)
        mailGroups.append(details)
      }
    }

    const resetMailPreview = () => {
      mailToken = ''
      mailConfirm.checked = false
      mailRetry.hidden = true
      mailPanel.removeAttribute('data-show')
      updateMailSendButton()
    }

    document.querySelector('#mail-clear-selection').addEventListener('click', () => {
      selectedPlanIds = new Set()
      resetMailPreview()
      renderPlans(lastPlans)
    })

    // 预览失败时 #mail-preview 仍是隐藏的，所以反馈必须落在始终可见的操作栏里，
    // 否则「缺少映射」「计划已结束」这类拦截对用户就是一次静默的无反应。
    const mailFeedback = document.querySelector('#mail-feedback')

    document.querySelector('#mail-preview-button').addEventListener('click', () => {
      exclusive(mailFeedback, '正在核对计划状态并生成预览…', async () => {
        const payload = await mailJson('/preview', postJson('', { planIds: [...selectedPlanIds] }))
        mailToken = payload.token
        renderMailPreview(payload.groups)
        mailPanel.setAttribute('data-show', '')
        mailRetry.hidden = true
        mailConfirm.checked = false
        return '请逐封核对后勾选确认。'
      })
    })

    mailConfirm.addEventListener('change', updateMailSendButton)
    document.querySelector('#mail-cancel').addEventListener('click', resetMailPreview)

    const runBatch = (path, token, working) => {
      exclusive(mailResult, working, async () => {
        const payload = await mailJson(path, postJson('', { token }))
        const summary = sendSummary(payload)
        mailToken = ''
        mailConfirm.checked = false
        mailRetry.hidden = !summary.canRetry
        mailRetry.dataset.token = summary.retryToken ?? ''
        renderMailPreview(payload.results.map((row) => ({
          executorName: row.executorName,
          maskedEmail: row.maskedEmail,
          planIds: row.planIds,
          subject: row.status === 'sent' ? '已发送' : '发送失败：' + row.errorCode,
          body: row.status === 'sent' ? '' : (row.errorMessage || ''),
        })))
        await loadHistory()
        return summary.text + (summary.canRetry ? ' 可重试失败项。' : '')
      })
    }

    mailSend.addEventListener('click', () => runBatch('/send', mailToken, '正在顺序发送…'))
    mailRetry.addEventListener('click', () => runBatch('/retry', mailRetry.dataset.token || '', '正在重试失败项…'))

    loadMailSettings()
    loadMappings()
    loadHistory()

  </script>
</body>
</html>`
}
