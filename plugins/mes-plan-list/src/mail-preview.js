import { randomBytes } from 'node:crypto'

import { queryPlanById } from './plan-query.js'

const PREVIEW_TTL_MS = 10 * 60 * 1000
const TEMPLATE_VARIABLES = new Set(['executorName', 'planCount', 'planList'])
const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function maskEmail(email) {
  const [local, domain] = email.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}

function validateTemplate(template) {
  if (typeof template !== 'string') throw new Error('邮件模板不能为空')
  for (const match of template.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    if (!TEMPLATE_VARIABLES.has(match[1])) throw new Error('邮件模板包含未知变量')
  }
  if (/[{}]/.test(template.replace(TEMPLATE_VARIABLE_PATTERN, ''))) throw new Error('邮件模板包含未知变量')
}

function renderTemplate(template, variables) {
  return template.replace(/{{\s*(executorName|planCount|planList)\s*}}/g, (unused, variable) => variables[variable])
}

function planLine(plan) {
  const customer = plan.companyName ?? plan.customer ?? ''
  const type = plan.checkTypeName ?? plan.typeName ?? plan.checkType ?? ''
  return `计划 ID：${plan.id}；客户：${customer}；标题：${plan.title ?? ''}；类型：${type}；计划结束时间：${plan.endDate ?? ''}`
}

function selectedPlans(planIds, plans) {
  if (!Array.isArray(planIds) || planIds.length === 0 || !Array.isArray(plans)) throw new Error('请选择至少一条计划')
  const byId = new Map(plans.map((plan) => [plan?.id, plan]))
  const selected = planIds.map((id) => byId.get(id))
  if (selected.some((plan) => plan === undefined)) throw new Error('所选计划不存在')
  if (selected.some((plan) => Number(plan.status) !== 3)) throw new Error('所选计划必须全部为已逾期未结束状态')
  return [...new Map(selected.map((plan) => [plan.id, plan])).values()].sort((left, right) => Number(left.id) - Number(right.id))
}

/** 生成已完成状态复核的计划的逐执行人邮件预览。 */
export function buildMailPreview({ profileKey, planIds, plans, mappings, settings }) {
  if (typeof profileKey !== 'string' || profileKey.trim() === '') throw new Error('MES 账号不能为空')
  validateTemplate(settings?.subjectTemplate)
  validateTemplate(settings?.bodyTemplate)

  const mappingById = new Map((mappings ?? []).map((mapping) => [String(mapping.executorId), mapping]))
  const groups = new Map()
  for (const plan of selectedPlans(planIds, plans)) {
    const executors = Array.isArray(plan.executorList) ? plan.executorList : []
    if (executors.length === 0) throw new Error('计划缺少执行人')
    const executorIds = new Set()
    for (const executor of executors) {
      const executorId = String(executor?.executorId ?? '')
      if (executorId === '') throw new Error('执行人邮箱映射不完整')
      if (executorIds.has(executorId)) continue
      executorIds.add(executorId)
      const mapping = mappingById.get(executorId)
      if (mapping === undefined || typeof mapping.email !== 'string' || mapping.email.trim() === '') throw new Error('执行人邮箱映射不完整')
      if (!groups.has(executorId)) {
        groups.set(executorId, {
          executorId,
          executorName: String(executor.executorName ?? mapping.executorName ?? ''),
          email: mapping.email.trim(),
          plans: [],
        })
      }
      groups.get(executorId).plans.push(plan)
    }
  }

  return {
    groups: [...groups.values()]
      .sort((left, right) => left.executorId.localeCompare(right.executorId))
      .map((group) => {
        const planIdsForExecutor = group.plans.map((plan) => plan.id)
        const variables = {
          executorName: group.executorName,
          planCount: String(planIdsForExecutor.length),
          planList: group.plans.map(planLine).join('\n'),
        }
        const subject = renderTemplate(settings.subjectTemplate, variables)
        const body = renderTemplate(settings.bodyTemplate, variables)
        if (subject.trim() === '' || body.trim() === '') throw new Error('邮件主题和正文不能为空')
        return {
          executorId: group.executorId,
          executorName: group.executorName,
          maskedEmail: maskEmail(group.email),
          subject,
          body,
          planIds: planIdsForExecutor,
        }
      }),
  }
}

/**
 * 发送预检的唯一入口：不信任调用方附带的计划数据，而是逐条通过 MES 重新读取后
 * 才构建邮件预览。query 参数仅用于在测试或上层服务中替换 MES 边界。
 */
export async function revalidateAndBuildMailPreview({ profileKey, planIds, mappings, settings }, query = queryPlanById) {
  if (!Array.isArray(planIds) || planIds.length === 0) throw new Error('请选择至少一条计划')
  const plans = await Promise.all(planIds.map((id) => query(id)))
  return buildMailPreview({ profileKey, planIds, plans, mappings, settings })
}

/** 仅在当前进程有效的、账户绑定的一次性邮件预览。 */
export class MailPreviewStore {
  #tokens = new Map()

  create(profileKey, preview, now = new Date()) {
    const token = randomBytes(32).toString('base64url')
    const snapshot = deepFreeze(structuredClone(preview))
    this.#tokens.set(token, { profileKey, preview: snapshot, expiresAt: now.getTime() + PREVIEW_TTL_MS })
    return token
  }

  consume(token, profileKey, now = new Date()) {
    const entry = this.#tokens.get(token)
    if (entry === undefined || entry.profileKey !== profileKey || now.getTime() >= entry.expiresAt) {
      if (entry !== undefined && now.getTime() >= entry.expiresAt) this.#tokens.delete(token)
      throw new Error('邮件预览令牌无效或已过期')
    }
    this.#tokens.delete(token)
    return entry.preview
  }
}
