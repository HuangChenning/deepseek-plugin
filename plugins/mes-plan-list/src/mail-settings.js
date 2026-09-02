const SECURITY_MODES = new Set(['tls', 'starttls'])
const TEMPLATE_VARIABLES = new Set(['executorName', 'planCount', 'planList'])
const SETTING_FIELDS = new Set([
  'senderName', 'senderEmail', 'smtpHost', 'smtpPort', 'securityMode',
  'smtpUsername', 'subjectTemplate', 'bodyTemplate', 'password',
])

function hasControlCharacters(value, { allowNewlines = false } = {}) {
  const pattern = allowNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/
  return pattern.test(value)
}

function requiredText(value, label, { allowNewlines = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}不能为空`)
  if (hasControlCharacters(value, { allowNewlines })) throw new Error(`${label}包含非法字符`)
  return value.trim()
}

function email(value, label) {
  const normalized = requiredText(value, label)
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized)) throw new Error(`${label}无效`)
  return normalized
}

/** Validate the template without evaluating or interpolating any user input. */
export function validateTemplate(subject, body) {
  if (typeof subject !== 'string' || subject.trim() === '') throw new Error('邮件主题不能为空')
  if (typeof body !== 'string' || body.trim() === '') throw new Error('邮件正文不能为空')
  if (hasControlCharacters(subject) || hasControlCharacters(body, { allowNewlines: true })) {
    throw new Error('邮件模板包含非法字符')
  }

  for (const template of [subject, body]) {
    const variablePattern = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g
    for (const match of template.matchAll(variablePattern)) {
      if (!TEMPLATE_VARIABLES.has(match[1])) throw new Error('邮件模板包含未知变量')
    }
    // A brace pair that looks like a variable but does not match the grammar is not
    // silently sent as literal text: it is almost certainly a typo in a template.
    if (/\{\{|\}\}/.test(template.replace(variablePattern, ''))) throw new Error('邮件模板包含未知变量')
  }
  return { subject, body }
}

/** Return only the persisted, non-secret SMTP settings. */
export function validateMailSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('邮件设置无效')
  for (const field of Object.keys(input)) {
    if (!SETTING_FIELDS.has(field)) throw new Error('邮件设置包含未知字段')
  }

  const senderName = requiredText(input.senderName, '发件人名称')
  const senderEmail = email(input.senderEmail, '发件邮箱')
  const smtpHost = requiredText(input.smtpHost, 'SMTP 主机')
  if (/\s|[\\/]/.test(smtpHost)) throw new Error('SMTP 主机无效')
  if (!Number.isInteger(input.smtpPort) || input.smtpPort < 1 || input.smtpPort > 65535) {
    throw new Error('SMTP 端口无效')
  }
  if (!SECURITY_MODES.has(input.securityMode)) throw new Error('安全模式无效')
  const smtpUsername = requiredText(input.smtpUsername, 'SMTP 用户名')
  const templates = validateTemplate(input.subjectTemplate, input.bodyTemplate)

  return {
    senderName,
    senderEmail,
    smtpHost,
    smtpPort: input.smtpPort,
    securityMode: input.securityMode,
    smtpUsername,
    subjectTemplate: templates.subject,
    bodyTemplate: templates.body,
  }
}
