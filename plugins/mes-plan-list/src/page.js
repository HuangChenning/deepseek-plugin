export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MES 实施计划</title>
  <style>
    body { font: 16px system-ui, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: #1f2937; }
    form { display: flex; flex-wrap: wrap; gap: 1rem; align-items: end; }
    label { display: grid; gap: .35rem; } button { padding: .5rem 1rem; }
    #message { min-height: 1.5rem; margin: 1rem 0; } table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d1d5db; padding: .55rem; text-align: left; } th { background: #f3f4f6; }
  </style>
</head>
<body>
  <h1>MES 实施计划</h1>
  <form id="query-form">
    <label>开始日期 <input name="startDate" type="date" required></label>
    <label>结束日期 <input name="endDate" type="date" required></label>
    <label>状态 <select name="status"><option value="">全部</option><option value="0">未开始</option><option value="1">进行中</option><option value="2">已完成</option><option value="3">逾期未完成</option></select></label>
    <button type="submit">查询</button>
  </form>
  <p id="message" role="status"></p>
  <div id="results"></div>
  <script>
    const form = document.querySelector('#query-form')
    const message = document.querySelector('#message')
    const results = document.querySelector('#results')
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
    const renderPlans = (plans) => {
      if (plans.length === 0) {
        results.innerHTML = '<p>没有符合条件的实施计划。</p>'
        return
      }
      const fields = ['id', 'companyName', 'title', 'startDate', 'endDate', 'statusDesc']
      const labels = ['编号', '客户', '计划名称', '开始日期', '结束日期', '状态']
      results.innerHTML = '<table><thead><tr>' + labels.map((label) => '<th>' + label + '</th>').join('') + '</tr></thead><tbody>' + plans.map((plan) => '<tr>' + fields.map((field) => '<td>' + escapeHtml(plan[field]) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      message.textContent = '正在查询…'
      results.innerHTML = ''
      const values = new FormData(form)
      try {
        const response = await fetch('/api/plugins/mes-plan-list/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ startDate: values.get('startDate'), endDate: values.get('endDate'), status: values.get('status') }),
        })
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || '查询失败，请稍后重试')
        message.textContent = '查询成功，共 ' + payload.plans.length + ' 条。'
        renderPlans(payload.plans)
      } catch (error) {
        message.textContent = error.message || '查询失败，请稍后重试'
      }
    })
  </script>
</body>
</html>`
}
