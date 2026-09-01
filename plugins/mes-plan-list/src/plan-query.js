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

export function buildPlanListArgs({ startDate, endDate, status = '' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? '')) throw new Error('开始日期不能为空或格式错误')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate ?? '')) throw new Error('结束日期不能为空或格式错误')
  if (startDate > endDate) throw new Error('开始日期不能晚于结束日期')
  if (status !== '' && !['0', '1', '2', '3'].includes(status)) throw new Error('状态值无效')
  return [
    '-o', 'json', 'plan', 'list', '--start-date', startDate, '--end-date', endDate,
    ...(status === '' ? [] : ['--status', status]), '--page', '1', '--page-size', '200',
  ]
}

export async function queryPlans(input, run = runMes) {
  const output = await run(buildPlanListArgs(input))
  try {
    const payload = JSON.parse(output)
    return Array.isArray(payload.list) ? payload.list : []
  } catch {
    throw new Error('MES 返回的数据不是有效 JSON')
  }
}
