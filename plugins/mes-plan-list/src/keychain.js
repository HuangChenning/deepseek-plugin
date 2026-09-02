import { execFile as defaultExecFile } from 'node:child_process'

const SERVICE = 'mes-plan-list.smtp'
const EXEC_OPTIONS = {
  encoding: 'utf8',
  timeout: 10_000,
  maxBuffer: 64 * 1024,
  shell: false,
}

function validateProfileKey(profileKey) {
  if (typeof profileKey !== 'string' || profileKey.trim() === '') throw new Error('邮件配置身份不能为空')
  if (/[\u0000-\u001f\u007f]/.test(profileKey)) throw new Error('邮件配置身份包含非法字符')
  return profileKey
}

function validatePassword(password) {
  if (typeof password !== 'string' || password === '') throw new Error('SMTP 密码不能为空')
  if (/[\u0000-\u001f\u007f]/.test(password)) throw new Error('SMTP 密码包含非法字符')
  return password
}

function callExecFile(execFile, args) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, stdout = '', stderr = '') => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    try {
      // Supporting both callback-shaped test doubles and the native callback API
      // keeps the injection boundary explicit while retaining execFile semantics.
      const result = execFile(
        'security',
        args,
        ...(execFile.length <= 3 ? [finish] : [EXEC_OPTIONS, finish]),
      )
      if (result !== undefined && result !== null && typeof result.then === 'function') {
        result.then((value) => finish(null, value?.stdout ?? value ?? ''), finish)
      } else if (execFile.length <= 2 && result !== undefined) {
        finish(null, result)
      }
    } catch (error) {
      finish(error)
    }
  })
}

function isMissingItem(error) {
  return error?.code === 44 || /not found|could not be found|SecKeychainSearchCopyNext/i.test(error?.message ?? '')
}

export function createKeychain(options = {}) {
  const execFile = typeof options === 'function' ? options : (options.execFile ?? defaultExecFile)
  async function readPassword(profileKey) {
    const account = validateProfileKey(profileKey)
    try {
      const { stdout } = await callExecFile(execFile, [
        'find-generic-password', '-s', SERVICE, '-a', account, '-w',
      ])
      return String(stdout).replace(/\r?\n$/, '')
    } catch (error) {
      if (isMissingItem(error)) return undefined
      throw new Error('读取 SMTP 密码失败')
    }
  }

  async function writePassword(profileKey, password) {
    const account = validateProfileKey(profileKey)
    const secret = validatePassword(password)
    try {
      await callExecFile(execFile, [
        'add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret,
      ])
      return true
    } catch {
      throw new Error('保存 SMTP 密码失败')
    }
  }

  async function deletePassword(profileKey) {
    const account = validateProfileKey(profileKey)
    try {
      await callExecFile(execFile, [
        'delete-generic-password', '-s', SERVICE, '-a', account,
      ])
      return true
    } catch (error) {
      if (isMissingItem(error)) return false
      throw new Error('清除 SMTP 密码失败')
    }
  }

  return { readPassword, writePassword, deletePassword }
}

const keychain = createKeychain()
export function readPassword(profileKey, injectedExecFile) {
  return (injectedExecFile === undefined ? keychain : createKeychain(injectedExecFile)).readPassword(profileKey)
}
export function writePassword(profileKey, password, injectedExecFile) {
  return (injectedExecFile === undefined ? keychain : createKeychain(injectedExecFile)).writePassword(profileKey, password)
}
export function deletePassword(profileKey, injectedExecFile) {
  return (injectedExecFile === undefined ? keychain : createKeychain(injectedExecFile)).deletePassword(profileKey)
}
