import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function runMes(args) {
  return execFileAsync('mes', args, { encoding: 'utf8' })
    .then(({ stdout }) => stdout)
    .catch(() => {
      throw new Error('MES 命令执行失败')
    })
}

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

/** 取回该条件下的全部实施计划：MES 按页返回，这里翻页直到取完。 */
export async function queryPlans(input, run = runMes) {
  const plans = []
  for (let page = 1; ; page += 1) {
    const output = await run(buildPlanListArgs({ ...input, page }))
    let payload
    try {
      payload = JSON.parse(output)
    } catch {
      throw new Error('MES 返回的数据不是有效 JSON')
    }
    const list = Array.isArray(payload.list) ? payload.list : []
    plans.push(...list)
    // 空页说明已经翻过头；否则以 MES 报告的总数为准。缺 total 时按单页处理。
    if (list.length === 0 || !Number.isInteger(payload.total) || plans.length >= payload.total) return plans
  }
}
