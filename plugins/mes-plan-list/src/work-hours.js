/**
 * 从 MES 取报工记录，用于计算「窗口期内每个计划的报工工时」。
 *
 * 关联字段是报工记录的 **rid**——它就是实施计划的 id（已实测比对）。同一条记录上
 * 的 `planId` 恒为 null，是另一回事，不要用它。
 *
 * 报工比计划多一个数量级（2026 全年 34258 条 vs 953 个计划），且 `--page-size`
 * 超过 500 会触发 CLI 的 10 秒超时，所以只能 500 一页、约 6 秒一页。全年要 6 分
 * 钟以上，因此这部分是按需加载的，不跟着计划同步一起走。
 */
import { runMes } from './mes-cli.js'

/**
 * 单页条数。再大 CLI 会超时（1000 必超），500 也偏容易触发。
 *
 * 报工接口在连续翻页时并不稳定：实测同一批请求的单页耗时在 4~18 秒之间波动，
 * 并会偶发失败——500 和 200 两种页大小都复现过。因此单页失败必须重试，否则一次
 * 几十页的加载几乎不可能全程成功。
 */
const PAGE_SIZE = 300

/** 单页最多重试次数，间隔按 1s、2s、4s 递增。 */
const MAX_RETRIES = 3

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

export function buildStatisticsArgs({ startDate, endDate, page = 1 }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate ?? '')) throw new Error('开始日期不能为空或格式错误')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate ?? '')) throw new Error('结束日期不能为空或格式错误')
  if (startDate > endDate) throw new Error('开始日期不能晚于结束日期')
  return [
    '-o', 'json', 'statistics', 'list',
    '--from', startDate, '--to', endDate,
    '--page', String(page), '--page-size', String(PAGE_SIZE),
  ]
}

/** 一条报工记录里我们需要的部分。 */
function toRecord(row) {
  return {
    id: row.id,
    // rid 是实施计划 id；没有 rid 的报工（内部事项等）不归属任何计划。
    planId: Number.isInteger(row.rid) ? row.rid : null,
    workDate: String(row.start ?? '').slice(0, 10),
    hours: Number(row.taskTime) || 0,
  }
}

/** 取一页，失败退避重试；重试用尽才放弃整次加载。 */
async function fetchPage(input, page, run) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(buildStatisticsArgs({ ...input, page }), { timeout: 60_000 })
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error
      await sleep(1000 * 2 ** attempt)
    }
  }
}

/**
 * 取回窗口内的全部报工。翻页逻辑与 queryPlans 一致：按 id 去重，终止判断用原始
 * 取回条数，否则去重会让它永远够不到 total。
 */
export async function queryWorkHours(input, run = runMes) {
  const byId = new Map()
  let fetched = 0
  for (let page = 1; ; page += 1) {
    const output = await fetchPage(input, page, run)
    let payload
    try {
      payload = JSON.parse(output)
    } catch {
      throw new Error('MES 返回的数据不是有效 JSON')
    }
    const list = Array.isArray(payload.list) ? payload.list : []
    fetched += list.length
    for (const row of list) {
      if (Number.isInteger(row.id)) byId.set(row.id, toRecord(row))
    }
    if (list.length === 0 || !Number.isInteger(payload.total) || fetched >= payload.total) return [...byId.values()]
  }
}
