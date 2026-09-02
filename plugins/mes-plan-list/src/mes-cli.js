/**
 * 所有对本机 mes CLI 的调用都走这里：解析用哪个二进制、执行、读版本、读登录态。
 *
 * 一律使用 execFile 传参数数组，绝不拼 shell——浏览器输入因此无法变成可执行语法。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { readConfig } from './config.js'

const execFileAsync = promisify(execFile)

/** mes --version 的输出形如 `mes version 0.5.3`。 */
const VERSION_PATTERN = /^mes version (\d+\.\d+\.\d+\S*)/m

/** 单次 CLI 调用的超时，避免网络类子命令把请求挂死。 */
const TIMEOUT_MS = 30_000

/** 配置了绝对路径就用它，否则沿用 PATH 里的 `mes`。 */
export async function resolveMesBinary(config = undefined) {
  const { mesPath } = config ?? (await readConfig())
  return mesPath === '' ? 'mes' : mesPath
}

export async function runMes(args, { timeout = TIMEOUT_MS } = {}) {
  const binary = await resolveMesBinary()
  try {
    const { stdout } = await execFileAsync(binary, args, { encoding: 'utf8', timeout })
    return stdout
  } catch {
    throw new Error('MES 命令执行失败')
  }
}

/**
 * 读取某个二进制自称的版本。保存 mes 路径前用它确认「这个文件确实是 mes」——
 * 只检查绝对路径和可执行位是不够的，那样等于允许把任意程序配成 mes。
 */
export async function readMesVersion(binary) {
  let stdout
  try {
    ;({ stdout } = await execFileAsync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }))
  } catch {
    throw new Error('无法执行该路径，请确认文件存在且可执行')
  }
  const matched = VERSION_PATTERN.exec(stdout)
  if (matched === null) throw new Error('该路径不是 mes CLI')
  return matched[1]
}

/**
 * 读取登录状态。未登录时 CLI 可能以非零码退出但仍打印 JSON，因此失败分支也要
 * 尝试解析 stdout，否则「没登录」会被误报成「命令坏了」。
 */
export async function readAuthStatus() {
  const binary = await resolveMesBinary()
  const args = ['-o', 'json', 'auth', 'status']
  let stdout
  try {
    ;({ stdout } = await execFileAsync(binary, args, { encoding: 'utf8', timeout: 15_000 }))
  } catch (error) {
    if (typeof error?.stdout !== 'string' || error.stdout === '') throw new Error('无法读取 MES 登录状态')
    stdout = error.stdout
  }
  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new Error('无法读取 MES 登录状态')
  }
  // 保守判定：只有明确 ok 且 token 有效才算已登录，字段缺失一律按未登录处理。
  return {
    loggedIn: payload.status === 'ok' && payload.tokenValid === true,
    account: typeof payload.account === 'string' ? payload.account.trim() : '',
  }
}
