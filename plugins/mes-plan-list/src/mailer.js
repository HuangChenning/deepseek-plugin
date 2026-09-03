import { createRequire } from 'node:module'

// 与工作簿同理：nodemailer 只在真正发信时用到，顶层静态 import 会让依赖缺失时整个
// 模块解析失败，把「发不了信」放大成「DSH 起不来」。createTransport 是同步的，所以
// 用 createRequire 而不是 await import。
function requireNodemailer() {
  try {
    return createRequire(import.meta.url)('nodemailer')
  } catch {
    throw new Error('缺少 nodemailer 依赖，请在仓库根执行 `pnpm install` 后重启 DSH')
  }
}

// 显式白名单：只有这些是「再试一次可能就好了」的网络故障。认证失败、被拒收件人
// 和未知错误一律不重试，避免对着服务端反复撞同一堵墙。
const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNECTION', 'ESOCKET', 'EDNS'])

const MESSAGES = {
  EAUTH: 'SMTP 认证失败，请检查用户名或授权码',
  EENVELOPE: 'SMTP 拒绝了收件地址',
  transient: 'SMTP 连接失败，请稍后重试',
  unknown: 'SMTP 发送失败',
}

/** 把传输层异常收敛成可展示的错误码与中文文案，绝不透出原始报文。 */
export function classifySendError(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (TRANSIENT_CODES.has(code)) return { transient: true, code, message: MESSAGES.transient }
  if (code === 'EAUTH' || code === 'EENVELOPE') return { transient: false, code, message: MESSAGES[code] }
  return { transient: false, code, message: MESSAGES.unknown }
}

// nodemailer 默认等 120s 连接、30s greeting、600s 空闲。发信是同步阻塞界面的操作，
// 中途既没有进度也不能取消，这些默认值意味着一台不吭声的服务器能把设置页挂上好几分钟。
// 下面的上限短到用户还愿意等，又远长过任何一次正常投递——本插件只发纯文本。
const TIMEOUTS = { connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000 }

/** 只有两种模式：隐式 TLS 与强制 STARTTLS，两者都不允许退回明文。 */
export function createTransport(settings, password, { nodemailer } = {}) {
  if (settings?.securityMode !== 'tls' && settings?.securityMode !== 'starttls') {
    throw new Error('安全模式无效')
  }
  return (nodemailer ?? requireNodemailer()).createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.securityMode === 'tls',
    requireTLS: true,
    auth: { user: settings.smtpUsername, pass: password },
    ...TIMEOUTS,
  })
}

export function sender(settings) {
  return { name: settings.senderName, address: settings.senderEmail }
}

/** 用一次性收件地址验证 SMTP 配置，不读取也不写入任何计划或映射数据。 */
export async function sendTestMail({ settings, password, recipient }, deps = {}) {
  if (typeof recipient !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient.trim())) {
    throw new Error('测试收件地址无效')
  }
  const transport = createTransport(settings, password, deps)
  try {
    await transport.sendMail({
      from: sender(settings),
      to: recipient.trim(),
      subject: 'MES 逾期风险提醒 SMTP 测试',
      text: '这是一封用于验证 SMTP 配置的测试邮件，无需回复。',
    })
  } catch (error) {
    throw new Error(classifySendError(error).message)
  }
  return { ok: true }
}
