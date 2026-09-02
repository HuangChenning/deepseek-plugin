import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MailStore, profileKey } from '../src/mail-store.js'

async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mes-plan-list-mail-'))
  const path = join(directory, 'mail.db')
  const store = new MailStore(path)
  t.after(async () => {
    store.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { path, store }
}

const SETTINGS = {
  senderName: '项目管理部',
  senderEmail: 'sender@example.invalid',
  smtpHost: 'smtp.example.invalid',
  smtpPort: 465,
  securityMode: 'tls',
  smtpUsername: 'sender@example.invalid',
  subjectTemplate: '{{executorName}} 风险交底',
  bodyTemplate: '共 {{planCount}} 条\n{{planList}}',
}

test('derives a stable private profile key from the MES account', () => {
  assert.equal(
    profileKey('alice'),
    '2bd806c97f0e00af1a1fc3328fa763a9269723c8db8fac4f93af71db186d6e90',
  )
  assert.equal(profileKey(' alice '), profileKey('alice'))
  assert.throws(() => profileKey('  '), /MES 账号不能为空/)
})

test('keeps settings and executor mappings isolated by profile', async (t) => {
  const { store } = await temporaryStore(t)
  const alice = profileKey('alice')
  const bob = profileKey('bob')

  store.writeSettings(alice, SETTINGS)
  store.replaceMappings(alice, [
    { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
  ])

  assert.deepEqual(store.readSettings(alice), SETTINGS)
  assert.equal(store.readSettings(bob), undefined)
  assert.deepEqual(store.listMappings(alice), [
    { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
  ])
  assert.deepEqual(store.listMappings(bob), [])
})

test('mapping replacement is atomic when one row violates the stored-data contract', async (t) => {
  const { store } = await temporaryStore(t)
  const profile = profileKey('alice')
  const original = [
    { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
  ]
  store.replaceMappings(profile, original)

  assert.throws(() => store.replaceMappings(profile, [
    { executorId: '2001', executorName: '李四', email: 'lisi@example.invalid' },
    { executorId: '', executorName: '无效人员', email: 'invalid@example.invalid' },
  ]))
  assert.deepEqual(store.listMappings(profile), original)
})

test('deletes only the requested profile mapping', async (t) => {
  const { store } = await temporaryStore(t)
  const alice = profileKey('alice')
  const bob = profileKey('bob')
  const mapping = { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' }
  store.replaceMappings(alice, [mapping])
  store.replaceMappings(bob, [mapping])

  assert.equal(store.deleteMapping(alice, '1001'), true)
  assert.equal(store.deleteMapping(alice, '1001'), false)
  assert.deepEqual(store.listMappings(alice), [])
  assert.deepEqual(store.listMappings(bob), [mapping])
})

test('persists private settings and mappings when the database is reopened', async (t) => {
  const { path, store } = await temporaryStore(t)
  const profile = profileKey('alice')
  store.writeSettings(profile, SETTINGS)
  store.replaceMappings(profile, [
    { executorId: '1001', executorName: '张三', email: 'zhangsan@example.invalid' },
  ])
  store.close()

  const reopened = new MailStore(path)
  t.after(() => reopened.close())
  assert.deepEqual(reopened.readSettings(profile), SETTINGS)
  assert.equal(reopened.listMappings(profile).length, 1)
})

test('stores only masked recipients in profile-scoped send history', async (t) => {
  const { store } = await temporaryStore(t)
  const alice = profileKey('alice')
  const bob = profileKey('bob')

  const batchId = store.writeBatch(alice, {
    createdAt: '2026-09-02T12:00:00.000Z',
    totalMessages: 1,
    succeeded: 0,
    failed: 1,
    results: [{
      executorId: '1001',
      executorName: '张三',
      maskedEmail: 'z***@example.invalid',
      planIds: [18366, 18372],
      status: 'failed',
      errorCode: 'timeout',
    }],
  })

  assert.equal(typeof batchId, 'number')
  assert.deepEqual(store.listHistory(alice), [{
    id: batchId,
    createdAt: '2026-09-02T12:00:00.000Z',
    totalMessages: 1,
    succeeded: 0,
    failed: 1,
    results: [{
      executorId: '1001',
      executorName: '张三',
      maskedEmail: 'z***@example.invalid',
      planIds: [18366, 18372],
      status: 'failed',
      errorCode: 'timeout',
    }],
  }])
  assert.deepEqual(store.listHistory(bob), [])
  assert.equal(store.clearHistory(bob), 0)
  assert.equal(store.clearHistory(alice), 1)
  assert.deepEqual(store.listHistory(alice), [])
})
