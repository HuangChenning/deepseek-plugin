import { classifySendError, sender } from './mailer.js'
import { queryPlanById } from './plan-query.js'

/**
 * 确认发送前的第二次状态复核。预览到确认之间可能过去几分钟，计划随时可能被关闭，
 * 所以这里不信任预览快照，逐条重新向 MES 读取状态；任何一条不再逾期就整批中止。
 */
async function preflight(groups, query) {
  const planIds = [...new Set(groups.flatMap((group) => group.planIds))]
  const plans = await Promise.all(planIds.map((id) => query(id)))
  if (plans.some((plan) => Number(plan?.status) !== 3)) {
    throw new Error('所选计划必须全部为已逾期未结束状态')
  }
}

function resolveRecipients(groups, mappings) {
  const emailById = new Map((mappings ?? []).map((mapping) => [String(mapping.executorId), mapping.email]))
  return groups.map((group) => {
    const email = emailById.get(String(group.executorId))
    if (typeof email !== 'string' || email.trim() === '') throw new Error('执行人邮箱映射不完整')
    return { group, email: email.trim() }
  })
}

async function deliver(transport, message) {
  try {
    await transport.sendMail(message)
    return { status: 'sent', errorCode: '', errorMessage: '' }
  } catch (error) {
    const first = classifySendError(error)
    if (!first.transient) return { status: 'failed', errorCode: first.code, errorMessage: first.message }
    try {
      await transport.sendMail(message)
      return { status: 'sent', errorCode: '', errorMessage: '' }
    } catch (retryError) {
      const second = classifySendError(retryError)
      return { status: 'failed', errorCode: second.code, errorMessage: second.message }
    }
  }
}

/**
 * 消费一次性预览令牌并顺序发送。收件地址只从本地映射解析，预览快照里的掩码地址
 * 不参与投递；正文与真实地址既不落库也不记日志。
 */
export async function sendPreviewBatch({
  profileKey, token, previewStore, mappings, settings, password,
  store, transport, query = queryPlanById, now = () => new Date(),
}) {
  const preview = previewStore.consume(token, profileKey)
  const targets = resolveRecipients(preview.groups, mappings)
  await preflight(preview.groups, query)

  const results = []
  for (const { group, email } of targets) {
    const outcome = await deliver(transport, {
      from: sender(settings),
      to: email,
      subject: group.subject,
      text: group.body,
    })
    results.push({
      executorId: group.executorId,
      executorName: group.executorName,
      maskedEmail: group.maskedEmail,
      planIds: group.planIds,
      ...outcome,
    })
  }

  const succeeded = results.filter((result) => result.status === 'sent').length
  const batch = {
    createdAt: now().toISOString(),
    totalMessages: results.length,
    succeeded,
    failed: results.length - succeeded,
    results: results.map(({ errorMessage, ...row }) => row),
  }
  store.writeBatch(profileKey, batch)

  const failedGroups = preview.groups.filter((group) =>
    results.some((result) => result.executorId === group.executorId && result.status === 'failed'))

  return {
    totalMessages: batch.totalMessages,
    succeeded: batch.succeeded,
    failed: batch.failed,
    results,
    // 重试令牌只装失败的分组，因此重试天然是「仅失败项」，且照样走完整预检。
    retryToken: failedGroups.length === 0 ? undefined : previewStore.create(profileKey, { groups: failedGroups }),
  }
}

/** 仅失败项重试：令牌本身只含失败分组，其余流程与首次发送完全一致。 */
export function retryFailedBatch(input) {
  return sendPreviewBatch(input)
}
