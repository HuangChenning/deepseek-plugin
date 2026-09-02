import assert from 'node:assert/strict'
import test from 'node:test'

import { classifySendError, createTransport, sendTestMail } from '../src/mailer.js'

const settings = {
  senderName: '交付中心',
  senderEmail: 'noreply@example.invalid',
  smtpHost: 'smtp.example.invalid',
  smtpPort: 465,
  securityMode: 'tls',
  smtpUsername: 'noreply@example.invalid',
}

function fakeNodemailer(sendMail = async () => ({ accepted: ['x'] })) {
  const calls = []
  return {
    calls,
    createTransport(options) {
      calls.push(options)
      return { sendMail }
    },
  }
}

test('builds an implicit TLS transport for the tls security mode', () => {
  const nodemailer = fakeNodemailer()
  createTransport(settings, 'secret-pass', { nodemailer })

  // SSL/TLS 必须在连接建立时就加密，绝不能退化成先明文再协商。
  assert.deepEqual(nodemailer.calls[0], {
    host: 'smtp.example.invalid',
    port: 465,
    secure: true,
    requireTLS: true,
    auth: { user: 'noreply@example.invalid', pass: 'secret-pass' },
  })
})

test('requires a STARTTLS upgrade instead of allowing a plaintext session', () => {
  const nodemailer = fakeNodemailer()
  createTransport({ ...settings, securityMode: 'starttls', smtpPort: 587 }, 'secret-pass', { nodemailer })

  // requireTLS 让升级失败时直接中止，而不是退回明文投递。
  assert.deepEqual(nodemailer.calls[0], {
    host: 'smtp.example.invalid',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: 'noreply@example.invalid', pass: 'secret-pass' },
  })
})

test('rejects any security mode outside the two approved modes', () => {
  const nodemailer = fakeNodemailer()
  assert.throws(
    () => createTransport({ ...settings, securityMode: 'none' }, 'secret-pass', { nodemailer }),
    /安全模式无效/,
  )
  assert.equal(nodemailer.calls.length, 0)
})

test('sends a test message to the requested temporary recipient only', async () => {
  const sent = []
  const nodemailer = fakeNodemailer(async (message) => {
    sent.push(message)
    return { accepted: [message.to] }
  })

  await sendTestMail(
    { settings, password: 'secret-pass', recipient: 'tester@example.invalid' },
    { nodemailer },
  )

  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, 'tester@example.invalid')
  assert.deepEqual(sent[0].from, { name: '交付中心', address: 'noreply@example.invalid' })
  // 测试邮件是纯文本，且不得携带任何计划内容。
  assert.equal(sent[0].html, undefined)
  assert.equal(typeof sent[0].text, 'string')
})

test('rejects a test recipient that is not a single valid address', async () => {
  const nodemailer = fakeNodemailer()
  await assert.rejects(
    () => sendTestMail({ settings, password: 'secret-pass', recipient: 'not-an-address' }, { nodemailer }),
    /测试收件地址无效/,
  )
})

test('redacts authentication and TLS failures', async () => {
  const nodemailer = fakeNodemailer(async () => {
    throw Object.assign(
      new Error('535 5.7.8 Authentication failed for noreply@example.invalid with password secret-pass'),
      { code: 'EAUTH' },
    )
  })

  await assert.rejects(
    () => sendTestMail({ settings, password: 'secret-pass', recipient: 'tester@example.invalid' }, { nodemailer }),
    (error) => {
      assert.equal(error.message, 'SMTP 认证失败，请检查用户名或授权码')
      // 原始报文会带出密码、用户名和主机，任何一项都不能泄漏给调用方。
      assert.doesNotMatch(error.message, /secret-pass|noreply@example\.invalid|smtp\.example\.invalid|535/)
      return true
    },
  )
})

test('classifies only the documented transport failures as transient', () => {
  // 重试白名单是显式的：认证失败和被拒收件人重试多少次都不会变好。
  assert.equal(classifySendError({ code: 'ETIMEDOUT' }).transient, true)
  assert.equal(classifySendError({ code: 'ECONNRESET' }).transient, true)
  assert.equal(classifySendError({ code: 'ESOCKET' }).transient, true)
  assert.equal(classifySendError({ code: 'EAUTH' }).transient, false)
  assert.equal(classifySendError({ code: 'EENVELOPE' }).transient, false)
  assert.equal(classifySendError({ code: undefined }).transient, false)
})
