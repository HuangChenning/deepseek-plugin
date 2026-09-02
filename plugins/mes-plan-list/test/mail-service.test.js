import assert from 'node:assert/strict'
import test from 'node:test'

import { MailPreviewStore } from '../src/mail-preview.js'
import { retryFailedBatch, sendPreviewBatch } from '../src/mail-service.js'

const PROFILE = 'profile-a'

const settings = {
  senderName: '交付中心',
  senderEmail: 'noreply@example.invalid',
  smtpHost: 'smtp.example.invalid',
  smtpPort: 465,
  securityMode: 'tls',
  smtpUsername: 'noreply@example.invalid',
}

const mappings = [
  { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
  { executorId: '1002', executorName: '李四', email: 'lisi@example.invalid' },
]

function group(executorId, executorName, planIds) {
  return {
    executorId,
    executorName,
    maskedEmail: `${executorName[0]}***@example.invalid`,
    subject: `${executorName}：${planIds.length} 个逾期计划`,
    body: `执行人：${executorName}`,
    planIds,
  }
}

const preview = {
  groups: [group('1001', '张三', [1, 2]), group('1002', '李四', [2])],
}

function overdueQuery(statusById = {}) {
  const seen = []
  const query = async (id) => {
    seen.push(id)
    return { id, status: statusById[id] ?? 3 }
  }
  query.seen = seen
  return query
}

function fakeStore() {
  return {
    batches: [],
    writeBatch(profile, batch) {
      this.batches.push({ profile, batch })
      return this.batches.length
    },
  }
}

function fakeTransport(behaviour = () => undefined) {
  const sent = []
  return {
    sent,
    async sendMail(message) {
      sent.push(message)
      const failure = behaviour(message, sent.length)
      if (failure) throw failure
      return { accepted: [message.to] }
    },
  }
}

function transient(code = 'ETIMEDOUT') {
  return Object.assign(new Error(`connection ${code}`), { code })
}

function input(overrides = {}) {
  const previewStore = overrides.previewStore ?? new MailPreviewStore()
  const token = overrides.token ?? previewStore.create(PROFILE, preview)
  return {
    profileKey: PROFILE,
    token,
    previewStore,
    mappings,
    settings,
    store: fakeStore(),
    transport: fakeTransport(),
    query: overdueQuery(),
    ...overrides,
  }
}

test('checks plan status again with MES before sending a consumed preview', async () => {
  // 预览与确认之间可能过去几分钟，计划可能已被关闭；第二次校验是唯一的保护。
  const args = input({ query: overdueQuery({ 2: 1 }) })

  await assert.rejects(() => sendPreviewBatch(args), /所选计划必须全部为已逾期未结束状态/)
  assert.equal(args.transport.sent.length, 0)
  assert.equal(args.store.batches.length, 0)
  // 每个被选中的计划都要重新查一次，且只查一次。
  assert.deepEqual([...args.query.seen].sort(), [1, 2])
})

test('aborts the whole batch when a recipient mapping disappeared after preview', async () => {
  const args = input({ mappings: [mappings[0]] })

  await assert.rejects(() => sendPreviewBatch(args), /执行人邮箱映射不完整/)
  assert.equal(args.transport.sent.length, 0)
})

test('resolves recipients from stored mappings rather than the preview snapshot', async () => {
  const args = input()
  await sendPreviewBatch(args)

  // 预览里只有掩码地址，真实收件人必须由服务端按执行人 ID 重新解析。
  assert.deepEqual(args.transport.sent.map((message) => message.to), [
    'zhangsan@example.invalid',
    'lisi@example.invalid',
  ])
  assert.deepEqual(args.transport.sent[0].from, { name: '交付中心', address: 'noreply@example.invalid' })
})

test('sends one plain-text message per group, one at a time', async () => {
  const order = []
  const transport = {
    sent: [],
    async sendMail(message) {
      order.push(`start:${message.to}`)
      await new Promise((resolve) => setImmediate(resolve))
      order.push(`end:${message.to}`)
      this.sent.push(message)
      return { accepted: [message.to] }
    },
  }
  const args = input({ transport })
  const result = await sendPreviewBatch(args)

  // 顺序发送：上一封结束后下一封才开始，避免并发触发服务端限流。
  assert.deepEqual(order, [
    'start:zhangsan@example.invalid',
    'end:zhangsan@example.invalid',
    'start:lisi@example.invalid',
    'end:lisi@example.invalid',
  ])
  assert.equal(transport.sent.every((message) => message.html === undefined), true)
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 0)
})

test('retries a transient failure exactly once', async () => {
  let firstRecipientAttempts = 0
  const transport = fakeTransport((message) => {
    if (message.to !== 'zhangsan@example.invalid') return undefined
    firstRecipientAttempts += 1
    return firstRecipientAttempts === 1 ? transient() : undefined
  })
  const args = input({ transport })
  const result = await sendPreviewBatch(args)

  assert.equal(firstRecipientAttempts, 2)
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 0)
})

test('never retries an authentication failure or a rejected recipient', async () => {
  for (const code of ['EAUTH', 'EENVELOPE']) {
    let attempts = 0
    const transport = fakeTransport((message) => {
      if (message.to !== 'zhangsan@example.invalid') return undefined
      attempts += 1
      return Object.assign(new Error('rejected'), { code })
    })
    const result = await sendPreviewBatch(input({ transport }))

    assert.equal(attempts, 1, `${code} 不应重试`)
    assert.equal(result.failed, 1)
  }
})

test('continues the batch after one group fails', async () => {
  const transport = fakeTransport((message) =>
    message.to === 'zhangsan@example.invalid' ? Object.assign(new Error('nope'), { code: 'EAUTH' }) : undefined)
  const args = input({ transport })
  const result = await sendPreviewBatch(args)

  // 一个执行人发失败不能连累其余执行人。
  assert.equal(result.totalMessages, 2)
  assert.equal(result.succeeded, 1)
  assert.equal(result.failed, 1)
  assert.deepEqual(result.results.map((row) => row.status), ['failed', 'sent'])
  assert.equal(args.transport.sent.length, 2)
})

test('persists a masked batch result to profile-scoped history', async () => {
  const transport = fakeTransport((message) =>
    message.to === 'zhangsan@example.invalid' ? Object.assign(new Error('nope'), { code: 'EAUTH' }) : undefined)
  const args = input({ transport, now: () => new Date('2026-09-02T10:00:00.000Z') })
  await sendPreviewBatch(args)

  assert.equal(args.store.batches.length, 1)
  const { profile, batch } = args.store.batches[0]
  assert.equal(profile, PROFILE)
  assert.equal(batch.createdAt, '2026-09-02T10:00:00.000Z')
  assert.deepEqual(batch.results.map((row) => row.maskedEmail), ['张***@example.invalid', '李***@example.invalid'])
  assert.deepEqual(batch.results.map((row) => row.errorCode), ['EAUTH', ''])
  // 历史只保存掩码地址和错误码，正文和真实地址不得落库。
  const stored = JSON.stringify(batch)
  assert.doesNotMatch(stored, /zhangsan@example\.invalid|lisi@example\.invalid/)
  assert.doesNotMatch(stored, /执行人：张三/)
})

test('consumes the preview token exactly once', async () => {
  const args = input()
  await sendPreviewBatch(args)
  await assert.rejects(() => sendPreviewBatch(args), /邮件预览令牌无效或已过期/)
})

test('retries only the failed groups with a fresh preflight', async () => {
  const transport = fakeTransport((message) =>
    message.to === 'zhangsan@example.invalid' ? transient('ECONNRESET') : undefined)
  const previewStore = new MailPreviewStore()
  const first = await sendPreviewBatch(input({ transport, previewStore }))

  assert.equal(first.failed, 1)
  assert.equal(typeof first.retryToken, 'string')

  const retryArgs = input({ previewStore, token: first.retryToken })
  const second = await retryFailedBatch(retryArgs)

  // 重试只覆盖失败的执行人，并且重新向 MES 核验一次状态。
  assert.equal(second.totalMessages, 1)
  assert.equal(second.succeeded, 1)
  assert.deepEqual(retryArgs.transport.sent.map((message) => message.to), ['zhangsan@example.invalid'])
  assert.deepEqual([...retryArgs.query.seen].sort(), [1, 2])
  assert.equal(retryArgs.store.batches.length, 1)
})

test('does not offer a retry token when every group succeeded', async () => {
  const result = await sendPreviewBatch(input())
  assert.equal(result.retryToken, undefined)
})
