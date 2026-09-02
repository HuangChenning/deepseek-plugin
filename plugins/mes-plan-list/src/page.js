/**
 * 插件页面。既能独立访问（跟随系统明暗），也能嵌在 DSH 中央列的 iframe 里，
 * 由 client.js 通过 postMessage 推送 DSH 的明暗主题。
 */
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
    .shell { max-width: 1180px; margin: 0 auto; padding: 28px 24px 48px; }

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
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { padding: 10px 14px; text-align: left; vertical-align: top; }
    th {
      background: var(--surface-sunken); color: var(--muted);
      font-weight: 500; font-size: 12px; white-space: nowrap;
      border-bottom: 1px solid var(--border);
    }
    tbody tr + tr td { border-top: 1px solid var(--border); }
    tbody tr:hover td { background: var(--surface-sunken); }
    td.title { font-weight: 500; max-width: 280px; }
    td.company { max-width: 200px; }
    td.id, td.num, td.date { white-space: nowrap; font-variant-numeric: tabular-nums; }
    td.id, td.date { color: var(--muted); }
    td.num { text-align: right; }

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
    .panel h2 { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
    .panel .hint { margin: 0 0 12px; color: var(--muted); font-size: 12px; }
    .panel .row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
    .panel .field { flex: 1 1 380px; }
    .panel input { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
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

    <section id="settings" class="panel">
      <h2>插件版本</h2>
      <p class="hint">更新会在本机仓库执行 <code>git pull --ff-only</code>，用你已有的 git 凭据；工作区有未提交改动时会拒绝。更新后需重启 DSH 才生效。</p>
      <div class="row">
        <span id="plugin-version" class="version">读取中…</span>
        <button type="button" id="check-plugin" class="ghost">检查更新</button>
        <button type="button" id="update-plugin" hidden>更新插件</button>
      </div>
      <p id="plugin-feedback" class="feedback" role="status"></p>

      <hr class="rule">
      <h2>mes CLI 路径</h2>
      <p class="hint">留空则使用 PATH 中的 <code>mes</code>。填绝对路径可解决 DSH 从图形界面启动时找不到 mes 的情况。保存前会执行该路径的 <code>--version</code> 确认它确实是 mes。</p>
      <div class="row">
        <label class="field"><span>绝对路径</span><input id="mes-path" type="text" placeholder="/opt/homebrew/bin/mes" spellcheck="false"></label>
        <button type="button" id="save-config">保存</button>
      </div>
      <p id="config-feedback" class="feedback" role="status"></p>

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
        <label><input type="checkbox" value="2"><span>结束</span></label>
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
    <div id="results"></div>
  </div>

  <script>
    const form = document.querySelector('#query-form')
    const submit = form.querySelector('button')
    const status = document.querySelector('#status')
    const results = document.querySelector('#results')

    // 面板嵌在 DSH 中央列时跟随外壳主题；独立打开时保持 prefers-color-scheme。
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return
      const mode = event.data && event.data.mesPlanTheme
      if (mode === 'dark' || mode === 'light') document.documentElement.dataset.theme = mode
    })

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

    const banner = document.querySelector('#auth-banner')
    const settings = document.querySelector('#settings')
    const mesPath = document.querySelector('#mes-path')
    const saveConfig = document.querySelector('#save-config')
    const configFeedback = document.querySelector('#config-feedback')

    document.querySelector('#settings-toggle').addEventListener('click', () => {
      if (settings.hasAttribute('data-show')) settings.removeAttribute('data-show')
      else settings.setAttribute('data-show', '')
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

    const loadConfig = async () => {
      try {
        const response = await fetch('/api/plugins/mes-plan-list/config')
        const payload = await response.json()
        if (response.ok && payload.ok) mesPath.value = payload.mesPath
      } catch {
        // 读不到配置不影响查询：留空即表示沿用 PATH。
      }
    }

    saveConfig.addEventListener('click', async () => {
      saveConfig.disabled = true
      configFeedback.textContent = '正在校验…'
      delete configFeedback.dataset.tone
      try {
        const response = await fetch('/api/plugins/mes-plan-list/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mesPath: mesPath.value }),
        })
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '保存失败')
        mesPath.value = payload.mesPath
        configFeedback.textContent = payload.mesPath === ''
          ? '已保存，将使用 PATH 中的 mes。'
          : '已保存，检测到 mes ' + payload.version + '。'
        configFeedback.dataset.tone = 'ok'
        await refreshAuth()
      } catch (error) {
        configFeedback.textContent = error.message || '保存失败'
        configFeedback.dataset.tone = 'error'
      } finally {
        saveConfig.disabled = false
      }
    })
    const day = (value) => String(value ?? '').slice(0, 10)
    const executors = (plan) => (plan.executorList ?? []).map((row) => row.executorName).filter(Boolean).join('、')

    const setStatus = (text, tone) => {
      status.textContent = text
      if (tone) status.dataset.tone = tone
      else delete status.dataset.tone
    }

    const renderRow = (plan) => '<tr>'
      + '<td class="id">' + escapeHtml(plan.id) + '</td>'
      + '<td class="title">' + escapeHtml(plan.title) + '</td>'
      + '<td class="company">' + escapeHtml(plan.contractName) + '</td>'
      + '<td>' + escapeHtml(plan.checkTypeDesc) + '</td>'
      + '<td>' + escapeHtml(executors(plan)) + '</td>'
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
      const labels = ['计划ID', '计划标题', '合同名称', '合同类型', '执行人', '报工工时(h)', '计划开始', '计划结束', '进行状态']
      results.innerHTML = '<div class="table-wrap"><table><thead><tr>'
        + labels.map((label) => '<th>' + label + '</th>').join('')
        + '</tr></thead><tbody>' + plans.map(renderRow).join('') + '</tbody></table></div>'
    }

    const DAY_MS = 24 * 60 * 60 * 1000
    const sync = document.querySelector('#sync')

    /** 最近一次查询的结果，供「加载报工工时」就地补上工时后重绘。 */
    let lastPlans = []

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
        // 工时随窗口变化，所以由服务端按当前窗口给出；没有报工缓存时为 null，
        // 表格显示「—」，同步一次即可补上。
        lastPlans = payload.plans
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
        pluginFeedback.textContent = payload.changed
          ? '已更新到 ' + (payload.version || payload.commit) + '，请重启 DSH 使新版本生效。'
          : '已是最新版本，无需更新。'
        pluginFeedback.dataset.tone = 'ok'
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
        syncAllChip(chip.dataset.clear)
      })
    }
    for (const picker of document.querySelectorAll('[data-picker]')) {
      picker.addEventListener('change', () => { syncAllChip(picker.dataset.picker) })
    }
    syncAllChip('status')
    syncAllChip('checkType')

    loadConfig()
    refreshAuth()
    loadCliVersion()
    loadCache()
    loadPluginVersion()
  </script>
</body>
</html>`
}
