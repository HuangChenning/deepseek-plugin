import { runMes } from './mes-cli.js'

/** 单次向 MES 请求的条数；结果总量由 queryPlans 翻页取全，不受它限制。 */
const PAGE_SIZE = 200

export function buildPlanListArgs({ startDate, endDate, status = '', page = 1 }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? '')) throw new Error('开始日期不能为空或格式错误')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate ?? '')) throw new Error('结束日期不能为空或格式错误')
  if (startDate > endDate) throw new Error('开始日期不能晚于结束日期')
  if (status !== '' && !['0', '1', '2', '3'].includes(status)) throw new Error('状态值无效')
  return [
    '-o', 'json', 'plan', 'list', '--start-date', startDate, '--end-date', endDate,
    ...(status === '' ? [] : ['--status', status]), '--page', String(page), '--page-size', String(PAGE_SIZE),
  ]
}

/**
 * 取回该条件下的全部实施计划：MES 按页返回，这里翻页直到取完。
 *
 * 按 id 去重：MES 的分页会在页边界上重复返回少量记录（实测全年 958 行里有 5 个
 * 重复 id，实际只有 953 个计划）。不去重的话，条数和表格行都会偏多。终止判断用
 * 的是**原始取回条数**而不是去重后的条数，否则去重会让它永远够不到 total。
 */
export async function queryPlans(input, run = runMes) {
  const byId = new Map()
  let fetched = 0
  for (let page = 1; ; page += 1) {
    const output = await run(buildPlanListArgs({ ...input, page }))
    let payload
    try {
      payload = JSON.parse(output)
    } catch {
      throw new Error('MES 返回的数据不是有效 JSON')
    }
    const list = Array.isArray(payload.list) ? payload.list : []
    fetched += list.length
    for (const plan of list) byId.set(plan.id, plan)
    // 空页说明已经翻过头；否则以 MES 报告的总数为准。缺 total 时按单页处理。
    if (list.length === 0 || !Number.isInteger(payload.total) || fetched >= payload.total) return [...byId.values()]
  }
}
