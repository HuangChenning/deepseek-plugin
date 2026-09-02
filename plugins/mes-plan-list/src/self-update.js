/**
 * 插件自身的版本查看与更新，基于本机的 git 工作区。
 *
 * 走 git 而不是 dshmarket / npm 的原因：仓库是 private 的，而使用者本来就有它的
 * 访问权限，git 会用本机既有的凭据。插件因此完全不需要经手 token——private 仓库
 * 在包管理器路线上的认证障碍在这里不存在。
 *
 * 安全：浏览器不能影响拉取的内容。remote、分支、ref 一律不接受参数，只做当前
 * 分支的 `pull --ff-only`；工作区不干净时拒绝，避免冲掉本地未提交的改动。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

async function git(args, timeout = 30_000) {
  const { stdout } = await execFileAsync('git', ['-C', HERE, ...args], { encoding: 'utf8', timeout })
  return stdout.trim()
}

/** 当前签出的版本。纯本地，不联网。 */
export async function readPluginVersion() {
  const [commit, branch, at, subject] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['log', '-1', '--format=%cI']),
    git(['log', '-1', '--format=%s']),
  ])
  return { commit, branch, at, subject }
}

/**
 * 问一次远程是否有新提交。用 `ls-remote` 而不是 `fetch`：只读，不动本地 .git。
 * 只在用户点击时调用——打开页面不该悄悄联网。
 */
export async function checkPluginUpdate() {
  const version = await readPluginVersion()
  const local = await git(['rev-parse', 'HEAD'])
  const line = await git(['ls-remote', 'origin', version.branch], 20_000)
  const remote = line.split(/\s+/)[0] ?? ''
  if (remote === '') throw new Error('远程没有同名分支，无法检查更新')
  return { ...version, upToDate: remote === local, remoteCommit: remote.slice(0, 7) }
}

/** 拉取当前分支的新提交。 */
export async function pullPluginUpdate() {
  if ((await git(['status', '--porcelain'])) !== '') {
    throw new Error('仓库有未提交的改动，请先提交或还原后再更新')
  }
  const before = await git(['rev-parse', '--short', 'HEAD'])
  // --ff-only：本地有分叉或领先时宁可失败，也不要自动合并出一个谁都没审过的状态。
  await git(['pull', '--ff-only'], 120_000)
  const version = await readPluginVersion()
  return { ...version, changed: version.commit !== before, previousCommit: before }
}
