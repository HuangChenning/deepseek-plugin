/**
 * 插件自身的版本查看与更新，基于本机的 git 工作区。
 *
 * 走 git 而不是 dshmarket / npm 的原因：仓库是 private 的，包管理器那条路要求一个
 * 可公开安装的来源。凭据由 `gh` 或 ssh-agent 持有，插件不经手 token——但「使用者
 * 本来就配好了」并不成立，所以 github-auth.js 负责检测，本文件负责把联网失败翻译
 * 成能照做的一句话。
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

/*
 * git 联网失败时的原文对使用者毫无指向性，而每一种失败要做的事完全不同。顺序有讲究：
 * `Repository not found` 必须排在认证失败之前——GitHub 对看不见的 private 仓库回 404，
 * 把它归进「没登录」会让人反复重登一个本来就登着的账号，而真正缺的是仓库权限。
 *
 * 最后两条来自 2026-09-03 在作者机器上的实测，不是设想出来的情况。
 */
const GIT_FAILURES = [
  [/Repository not found/iu, '已通过认证，但这个 GitHub 账号没有该仓库的访问权限。请让仓库管理员把你加进来——重新登录解决不了这个问题。'],
  [/could not read Username/iu, 'git 还没用上 GitHub 凭据。执行 `gh auth setup-git` 之后再更新。'],
  [/Authentication failed/iu, 'GitHub 凭据无效或已过期。执行 `gh auth login` 重新登录。'],
  [/Permission denied \(publickey\)/iu, 'GitHub 不接受本机的 SSH 公钥。执行 `gh auth login` 并选择 SSH 协议，它会把公钥挂到账号上。'],
  [/Connection timed out|port 22/iu, '连不上 GitHub 的 22 端口。在 `~/.ssh/config` 里把 github.com 改走 `ssh.github.com` 的 443 端口。'],
]

/**
 * 把 git 的失败输出翻译成一句能照做的话；认不出来就返回空串，交回给调用方。
 *
 * 宁可漏翻也不能过翻：把「工作区不干净」误报成「没登录」，会让人去折腾凭据，而真正
 * 要做的是提交本地改动。
 */
export function describeGitFailure(stderr) {
  const text = String(stderr ?? '')
  for (const [pattern, message] of GIT_FAILURES) if (pattern.test(text)) return message
  return ''
}

/**
 * 跑一次要联网的 git 操作。失败一律经过翻译：git 的 stderr 里带着 remote URL，而
 * private 仓库的地址本身就不该送进浏览器，所以认不出来的失败也只给通用文案。
 */
async function overNetwork(work, fallback) {
  try {
    return await work()
  } catch (error) {
    throw new Error(describeGitFailure(error?.stderr ?? error?.message ?? '') || fallback)
  }
}

// 依赖安装比 git pull 慢一个数量级，超时按分钟算。
const INSTALL_TIMEOUT_MS = 5 * 60_000
const MANIFESTS = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])

/** 这次更新动过依赖清单没有。只看文件名，路径在哪个包下都算。 */
export function needsDependencyInstall(files) {
  return (files ?? []).some((file) => MANIFESTS.has(file.split('/').pop()))
}

/**
 * 在仓库根跑 `pnpm install`。这是一个 pnpm workspace，只有仓库根那一次安装才会
 * 装上插件自己的依赖；不碰 DSH profile 的 node_modules 与 lockfile。
 */
async function installDependencies(run = git) {
  const root = await run(['rev-parse', '--show-toplevel'])
  try {
    await execFileAsync('pnpm', ['install'], { cwd: root, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('找不到 pnpm，请先安装 pnpm，再在仓库根执行 `pnpm install`')
    throw new Error('依赖安装失败，请在仓库根手动执行 `pnpm install`')
  }
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
export async function readPluginVersion(run = git) {
  const [commit, branch, at, subject, described] = await Promise.all([
    run(['rev-parse', '--short', 'HEAD']),
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['log', '-1', '--format=%cI']),
    run(['log', '-1', '--format=%s']),
    // --always：仓库尚无 tag 时退回短 sha，而不是让整块读取失败。
    run(['describe', '--tags', '--always']),
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
  const line = await overNetwork(
    () => git(['ls-remote', 'origin', version.branch], 20_000),
    '检查更新失败，请确认本机能访问 GitHub 上的这个仓库',
  )
  const remote = line.split(/\s+/)[0] ?? ''
  if (remote === '') throw new Error('远程没有同名分支，无法检查更新')
  return { ...version, upToDate: remote === local, remoteCommit: remote.slice(0, 7) }
}

/**
 * 拉取当前分支的新提交，必要时补装依赖。
 *
 * 只 pull 不装依赖，跨过一次加依赖的提交后重启 DSH 就直接起不来，所以 `dependencies`
 * 会如实回报 `unchanged` / `installed` / `failed`——安装失败时**不能**说更新成功。
 */
export async function pullPluginUpdate({ run = git, install = installDependencies } = {}) {
  if ((await run(['status', '--porcelain'])) !== '') {
    throw new Error('仓库有未提交的改动，请先提交或还原后再更新')
  }
  const before = await run(['rev-parse', '--short', 'HEAD'])
  // --ff-only：本地有分叉或领先时宁可失败，也不要自动合并出一个谁都没审过的状态。
  await overNetwork(() => run(['pull', '--ff-only'], 120_000), '更新失败，请确认本机能访问 GitHub 上的这个仓库')
  const version = await readPluginVersion(run)
  const result = { ...version, changed: version.commit !== before, previousCommit: before }
  if (!result.changed) return { ...result, dependencies: 'unchanged' }

  const files = (await run(['diff', '--name-only', `${before}..HEAD`])).split('\n').filter((file) => file !== '')
  if (!needsDependencyInstall(files)) return { ...result, dependencies: 'unchanged' }
  try {
    await install(run)
    return { ...result, dependencies: 'installed' }
  } catch (error) {
    return { ...result, dependencies: 'failed', dependencyError: error.message }
  }
}
