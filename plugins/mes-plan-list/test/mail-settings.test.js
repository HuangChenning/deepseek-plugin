import assert from 'node:assert/strict'
import test from 'node:test'

import { validateMailSettings, validateTemplate } from '../src/mail-settings.js'

const VALID_SETTINGS = {
  senderName: '项目管理部',
  senderEmail: 'sender@example.invalid',
  smtpHost: 'smtp.example.invalid',
  smtpPort: 465,
  securityMode: 'tls',
  smtpUsername: 'sender@example.invalid',
  subjectTemplate: '{{executorName}} 风险交底',
  bodyTemplate: '共 {{planCount}} 条\n{{planList}}',
}

test('accepts a complete TLS profile and never returns its password', () => {
  const result = validateMailSettings({ ...VALID_SETTINGS, password: 'client-secret' })

  assert.deepEqual(result, VALID_SETTINGS)
  assert.equal('password' in result, false, 'a validated response must be safe to return to the browser')
})

test('accepts an omitted password so the existing Keychain secret can be preserved', () => {
  assert.deepEqual(validateMailSettings(VALID_SETTINGS), VALID_SETTINGS)
})

test('accepts the forced STARTTLS security mode', () => {
  assert.equal(validateMailSettings({ ...VALID_SETTINGS, securityMode: 'starttls' }).securityMode, 'starttls')
})

test('rejects ports outside the TCP range or that are not integers', () => {
  for (const smtpPort of [0, 65536, 465.5, '465']) {
    assert.throws(() => validateMailSettings({ ...VALID_SETTINGS, smtpPort }), /SMTP 端口无效/)
  }
})

test('rejects empty sender and SMTP addresses', () => {
  assert.throws(() => validateMailSettings({ ...VALID_SETTINGS, senderEmail: '  ' }), /发件邮箱(?:无效|不能为空)/)
  assert.throws(() => validateMailSettings({ ...VALID_SETTINGS, smtpUsername: '' }), /SMTP 用户名不能为空/)
})

test('rejects plaintext SMTP mode instead of allowing a downgrade', () => {
  assert.throws(() => validateMailSettings({ ...VALID_SETTINGS, securityMode: 'plain' }), /安全模式无效/)
})

test('rejects unknown template variables', () => {
  assert.throws(
    () => validateTemplate('{{executorName}}', '密码 {{password}}\n{{planList}}'),
    /邮件模板包含未知变量/,
  )
})

test('rejects control characters in SMTP fields', () => {
  assert.throws(() => validateMailSettings({ ...VALID_SETTINGS, smtpHost: 'smtp.example.invalid\nX-Injected: yes' }), /包含非法字符/)
})

test('returns the two validated template values', () => {
  assert.deepEqual(validateTemplate('风险交底', '{{planCount}} 条'), {
    subject: '风险交底',
    body: '{{planCount}} 条',
  })
})
