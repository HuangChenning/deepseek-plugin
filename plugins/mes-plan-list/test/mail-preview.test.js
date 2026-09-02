import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMailPreview, MailPreviewStore, revalidateAndBuildMailPreview } from '../src/mail-preview.js'

const settings = {
  subjectTemplate: '{{executorName}}：{{planCount}} 个逾期计划',
  bodyTemplate: '执行人：{{executorName}}\n数量：{{planCount}}\n{{planList}}',
}

function plan(id, executorList, status = 3) {
  return {
    id,
    status,
    companyName: `客户 ${id}`,
    title: `计划 ${id}`,
    checkTypeName: '现场交付',
    endDate: `2026-09-${String(id).padStart(2, '0')} 18:00:00`,
    executorList,
  }
}

const mappings = [
  { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
  { executorId: '1002', executorName: '李四', email: 'lisi@example.invalid' },
]

test('builds one deterministic preview group per executor for overdue plans', () => {
  const preview = buildMailPreview({
    profileKey: 'profile-a',
    planIds: [2, 1],
    plans: [
      plan(1, [{ executorId: '1001', executorName: '张三' }]),
      plan(2, [
        { executorId: '1001', executorName: '张三' },
        { executorId: '1002', executorName: '李四' },
      ]),
    ],
    mappings,
    settings,
  })

  assert.deepEqual(preview, {
    groups: [
      {
        executorId: '1001',
        executorName: '张三',
        maskedEmail: 'z***@example.invalid',
        subject: '张三：2 个逾期计划',
        body: '执行人：张三\n数量：2\n计划 ID：1；客户：客户 1；标题：计划 1；类型：现场交付；计划结束时间：2026-09-01 18:00:00\n计划 ID：2；客户：客户 2；标题：计划 2；类型：现场交付；计划结束时间：2026-09-02 18:00:00',
        planIds: [1, 2],
      },
      {
        executorId: '1002',
        executorName: '李四',
        maskedEmail: 'l***@example.invalid',
        subject: '李四：1 个逾期计划',
        body: '执行人：李四\n数量：1\n计划 ID：2；客户：客户 2；标题：计划 2；类型：现场交付；计划结束时间：2026-09-02 18:00:00',
        planIds: [2],
      },
    ],
  })
})

test('revalidates every selected plan with MES instead of trusting caller-supplied plans', async () => {
  const requested = []
  const preview = await revalidateAndBuildMailPreview({
    profileKey: 'profile-a',
    planIds: [2, 1],
    plans: [
      { ...plan(1, [{ executorId: '1001', executorName: '张三' }]), companyName: '过期缓存客户' },
      { ...plan(2, [{ executorId: '1002', executorName: '李四' }]), companyName: '过期缓存客户' },
    ],
    mappings,
    settings,
  }, async (id) => {
    requested.push(id)
    return plan(id, [{ executorId: id === 1 ? '1001' : '1002', executorName: id === 1 ? '张三' : '李四' }])
  })

  assert.deepEqual(requested, [2, 1])
  assert.match(preview.groups[0].body, /客户 1/)
  assert.doesNotMatch(preview.groups[0].body, /过期缓存客户/)
})

test('blocks the complete preview when MES shows any selected plan is no longer overdue', async () => {
  const requested = []

  await assert.rejects(
    revalidateAndBuildMailPreview({
      profileKey: 'profile-a',
      planIds: [1, 2],
      plans: [plan(1, [{ executorId: '1001', executorName: '张三' }]), plan(2, [{ executorId: '1002', executorName: '李四' }])],
      mappings,
      settings,
    }, async (id) => {
      requested.push(id)
      return plan(id, [{ executorId: id === 1 ? '1001' : '1002', executorName: id === 1 ? '张三' : '李四' }], id === 2 ? 2 : 3)
    }),
    { message: '所选计划必须全部为已逾期未结束状态' },
  )

  assert.deepEqual(requested, [1, 2])
})

test('blocks the complete batch when any selected plan is no longer overdue', () => {
  assert.throws(
    () => buildMailPreview({
      profileKey: 'profile-a',
      planIds: [1, 2],
      plans: [plan(1, [{ executorId: '1001', executorName: '张三' }]), plan(2, [{ executorId: '1002', executorName: '李四' }], 2)],
      mappings,
      settings,
    }),
    { message: '所选计划必须全部为已逾期未结束状态' },
  )
})

test('blocks the complete batch when any executor lacks an email mapping', () => {
  assert.throws(
    () => buildMailPreview({
      profileKey: 'profile-a',
      planIds: [1],
      plans: [plan(1, [{ executorId: '1003', executorName: '王五' }])],
      mappings,
      settings,
    }),
    // 必须点名是谁、该去哪儿补，否则用户只能逐个试错。
    { message: /王五/ },
  )
})

test('blocks the complete batch when a plan executor has no id to map', () => {
  assert.throws(
    () => buildMailPreview({
      profileKey: 'profile-a',
      planIds: [1],
      plans: [plan(1, [{ executorName: '无编号执行人' }])],
      mappings,
      settings,
    }),
    { message: /没有姓名|执行人 ID/ },
  )
})

test('names a nameless executor by plan and id instead of blocking silently', () => {
  // MES 有时只给 executorId 不给姓名。这种执行人永远配不出按姓名建立的映射，
  // 所以必须说明是哪条计划、该去 MES 补什么，而不是重复报「映射不完整」。
  assert.throws(
    () => buildMailPreview({
      profileKey: 'profile-a',
      planIds: [1],
      plans: [plan(1, [{ executorId: '15401', executorName: null }])],
      mappings,
      settings,
    }),
    (error) => {
      assert.match(error.message, /计划 1（执行人 ID 15401）/)
      assert.match(error.message, /在 MES 中补全该执行人姓名|取消勾选/)
      return true
    },
  )
})

test('reports every blocker at once rather than one per attempt', () => {
  assert.throws(
    () => buildMailPreview({
      profileKey: 'profile-a',
      planIds: [1, 2],
      plans: [
        plan(1, [{ executorId: '1003', executorName: '王五' }]),
        plan(2, [{ executorId: '1004', executorName: '赵六' }, { executorId: '15401', executorName: null }]),
      ],
      mappings,
      settings,
    }),
    (error) => {
      // 一次说清全部，否则补一个、再预览、再撞下一个。
      assert.match(error.message, /王五/)
      assert.match(error.message, /赵六/)
      assert.match(error.message, /15401/)
      return true
    },
  )
})

test('rejects unknown template variables instead of rendering them', () => {
  assert.throws(
    () => buildMailPreview({
      profileKey: 'profile-a',
      planIds: [1],
      plans: [plan(1, [{ executorId: '1001', executorName: '张三' }])],
      mappings,
      settings: { ...settings, subjectTemplate: '{{unknown}}' },
    }),
    { message: '邮件模板包含未知变量' },
  )
})

test('rejects malformed or unbalanced template delimiters', () => {
  for (const subjectTemplate of ['{{unknown', 'unknown}}', '{{{{executorName}}}}', '{{executorName}}}']) {
    assert.throws(
      () => buildMailPreview({
        profileKey: 'profile-a',
        planIds: [1],
        plans: [plan(1, [{ executorId: '1001', executorName: '张三' }])],
        mappings,
        settings: { ...settings, subjectTemplate },
      }),
      { message: '邮件模板包含未知变量' },
    )
  }
})

test('accepts only the three documented template variables', () => {
  const preview = buildMailPreview({
    profileKey: 'profile-a',
    planIds: [1],
    plans: [plan(1, [{ executorId: '1001', executorName: '张三' }])],
    mappings,
    settings: { subjectTemplate: '{{planList}}', bodyTemplate: '{{executorName}}/{{planCount}}/{{planList}}' },
  })

  assert.equal(preview.groups[0].subject, '计划 ID：1；客户：客户 1；标题：计划 1；类型：现场交付；计划结束时间：2026-09-01 18:00:00')
  assert.match(preview.groups[0].body, /^张三\/1\/计划 ID：1；客户：客户 1；标题：计划 1；类型：现场交付；计划结束时间：2026-09-01 18:00:00$/)
})

test('consumes a profile-bound preview token exactly once before expiry', () => {
  const store = new MailPreviewStore()
  const preview = { groups: [{ executorId: '1001', planIds: [1] }] }
  const now = new Date('2026-09-02T00:00:00.000Z')
  const token = store.create('profile-a', preview, now)

  assert.match(token, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(token, store.create('profile-a', preview, now))
  assert.throws(() => store.consume(token, 'profile-b', now), { message: '邮件预览令牌无效或已过期' })
  assert.deepEqual(store.consume(token, 'profile-a', now), preview)
  assert.throws(() => store.consume(token, 'profile-a', now), { message: '邮件预览令牌无效或已过期' })
  assert.throws(() => store.consume('guessable-token', 'profile-a', now), { message: '邮件预览令牌无效或已过期' })
})

test('expires preview tokens and retains an immutable snapshot', () => {
  const store = new MailPreviewStore()
  const now = new Date('2026-09-02T00:00:00.000Z')
  const preview = { groups: [{ executorId: '1001', planIds: [1] }] }
  const token = store.create('profile-a', preview, now)
  preview.groups[0].planIds.push(2)

  assert.throws(() => store.consume(token, 'profile-a', new Date(now.getTime() + 10 * 60 * 1000)), { message: '邮件预览令牌无效或已过期' })

  const second = store.create('profile-a', { groups: [{ executorId: '1001', planIds: [1] }] }, now)
  const consumed = store.consume(second, 'profile-a', now)
  assert.deepEqual(consumed, { groups: [{ executorId: '1001', planIds: [1] }] })
  assert.throws(() => { consumed.groups[0].planIds.push(2) }, TypeError)
})
