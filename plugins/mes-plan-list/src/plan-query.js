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

/** 单次查询上限；MES 返回的 total 超过它时页面提示结果已截断。 */
export const PAGE_SIZE = 200

export function buildPlanListArgs({ startDate, endDate, status = '' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? '')) throw new Error('开始日期不能为空或格式错误')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate ?? '')) throw new Error('结束日期不能为空或格式错误')
  if (startDate > endDate) throw new Error('开始日期不能晚于结束日期')
  if (status !== '' && !['0', '1', '2', '3'].includes(status)) throw new Error('状态值无效')
  return [
    '-o', 'json', 'plan', 'list', '--start-date', startDate, '--end-date', endDate,
    ...(status === '' ? [] : ['--status', status]), '--page', '1', '--page-size', String(PAGE_SIZE),
  ]
}

export async function queryPlans(input, run = runMes) {
  const output = await run(buildPlanListArgs(input))
  let payload
  try {
    payload = JSON.parse(output)
  } catch {
    throw new Error('MES 返回的数据不是有效 JSON')
  }
  const plans = Array.isArray(payload.list) ? payload.list : []
  return { plans, total: Number.isInteger(payload.total) ? payload.total : plans.length }
}
