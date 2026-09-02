/**
 * 插件配置的读写与路径格式校验。
 *
 * 配置放在 Host 侧（不是浏览器 localStorage）：执行 CLI 的是 Host 进程，配置必须
 * 在它能读到的地方。本模块只做文件读写和纯格式校验，不执行任何进程——「这个路径
 * 确实是 mes」由 mes-cli.js 验证，两者在 index.js 里串起来。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export const CONFIG_PATH = join(homedir(), '.dsh', 'storages', 'mes-plan-list', 'config.json')

/** 空字符串表示「不配置绝对路径，沿用 PATH 里的 mes」。 */
const DEFAULT_CONFIG = { mesPath: '' }

/**
 * 校验用户填写的 mes 路径格式。
 *
 * 这个字段决定 Host 执行哪个二进制，等同于任意代码执行，因此只接受绝对路径，
 * 并拒绝控制字符——留空是唯一的「不指定」写法。
 */
export function validateMesPath(value) {
  if (typeof value !== 'string') throw new Error('mes 路径必须是字符串')
  const path = value.trim()
  if (path === '') return ''
  if (!isAbsolute(path)) throw new Error('mes 路径必须是绝对路径')
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error('mes 路径包含非法字符')
  return path
}

export async function readConfig(path = CONFIG_PATH) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // 没有配置文件是正常的首次状态，不是错误。
    return { ...DEFAULT_CONFIG }
  }
  try {
    const payload = JSON.parse(raw)
    return { mesPath: validateMesPath(payload.mesPath ?? '') }
  } catch {
    // 文件损坏时退回默认值，而不是让整个插件不可用。
    return { ...DEFAULT_CONFIG }
  }
}

export async function writeConfig({ mesPath }, path = CONFIG_PATH) {
  const config = { mesPath: validateMesPath(mesPath) }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`)
  return config
}
