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

/**
 * 把 `git describe` 的输出拆成版本号与领先的提交数。
 *
 * `v0.1.0` → 正好在这个发布版本上；`v0.1.0-2-gabc1234` → 该版本之后又有 2 个
 * 提交。用 describe 而不是读 package.json 的 version：后者在这两种情况下都是
 * 同一个值，看不出本地是否已经领先于发布版本。仓库还没有任何 tag 时，
 * `--always` 会退回成短 sha，此时如实显示 sha。
 */
function parseDescribe(described) {
  const matched = /^(.+)-(\d+)-g[0-9a-f]+$/.exec(described)
  if (matched === null) return { version: described, ahead: 0 }
  return { version: matched[1], ahead: Number(matched[2]) }
}

/** 当前签出的版本。纯本地，不联网。 */
export async function readPluginVersion() {
  const [commit, branch, at, subject, described] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['log', '-1', '--format=%cI']),
    git(['log', '-1', '--format=%s']),
    // --always：仓库尚无 tag 时退回短 sha，而不是让整块读取失败。
    git(['describe', '--tags', '--always']),
  ])
  return { commit, branch, at, subject, ...parseDescribe(described) }
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
