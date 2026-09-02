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

/**
 * 子进程输出上限。execFile 默认只有 1 MiB，而一页 500 条报工的 JSON 就会超过它，
 * 表现为一个没有任何线索的「命令执行失败」。
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** 配置了绝对路径就用它，否则沿用 PATH 里的 `mes`。 */
export async function resolveMesBinary(config = undefined) {
  const { mesPath } = config ?? (await readConfig())
  return mesPath === '' ? 'mes' : mesPath
}

export async function runMes(args, { timeout = TIMEOUT_MS } = {}) {
  const binary = await resolveMesBinary()
  try {
    const { stdout } = await execFileAsync(binary, args, { encoding: 'utf8', timeout, maxBuffer: MAX_OUTPUT_BYTES })
    return stdout
  } catch {
    throw new Error('MES 命令执行失败')
  }
}

/** 执行并拿到输出，非零退出也返回而不抛——子命令用退出码表达结果时需要。 */
async function execMes(args, timeout) {
  const binary = await resolveMesBinary()
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, { encoding: 'utf8', timeout, maxBuffer: MAX_OUTPUT_BYTES })
    return `${stdout}${stderr}`.trim()
  } catch (error) {
    const combined = `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim()
    if (combined === '') throw new Error('mes 命令执行失败')
    return combined
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

/** `mes update` 会替换正在使用的二进制，期间必须挡住其他 CLI 调用。 */
let updating = false

export function isUpdating() {
  return updating
}

/**
 * 判断 `mes update --check` 的输出是否表示「已是最新」。
 *
 * 该子命令只有文本输出（`-o json` 对它不生效，已实测），所以这是个刻意宽松的
 * 判断：只有认得出「up to date」才算最新，认不出一律当作「可能有更新」。失败
 * 方向必须是让用户多看一眼原始输出，而不是在 MES 改文案后宣称已是最新、让用户
 * 错过更新。
 */
export function isUpToDate(output) {
  return /up to date/i.test(output)
}

/** 只读本机已装的版本，不联网——页面加载走这条路径。 */
export async function readCliVersion() {
  return { version: await readMesVersion(await resolveMesBinary()) }
}

/**
 * 检查是否有新版本。这会联网，因此只在用户主动点「检查更新」时调用：打开页面
 * 不应该悄悄访问外部更新服务器。
 */
export async function readUpdateStatus() {
  const { version } = await readCliVersion()
  // 比默认的 30s 短：用户正在等这个结果，网络不通时不该让他干等。
  const output = await execMes(['update', '--check'], 15_000)
  return { version, upToDate: isUpToDate(output), output }
}

/** 执行 `mes update`，返回 CLI 输出与更新后的版本。 */
export async function runMesUpdate() {
  if (updating) throw new Error('mes 正在更新，请稍候')
  updating = true
  try {
    const output = await execMes(['update'], 180_000)
    // 二进制刚被替换，版本要重新读，不能沿用更新前的值。
    const version = await readMesVersion(await resolveMesBinary())
    return { version, output }
  } finally {
    updating = false
  }
}
