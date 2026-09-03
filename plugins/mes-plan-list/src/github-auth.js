/**
 * 检测本机是否具备拉取这个 private 仓库的 GitHub 授权，并把结论翻译成一句能照着
 * 敲的引导。
 *
 * 分派依据是 origin 的协议，不是用户偏好：协议是仓库的既成事实，让用户在页面上
 * 选「我用 HTTPS 还是 SSH」只会让他们选错。
 *
 * 安全：插件绝不接收、存储、转发或回显 GitHub token。`gh auth token` 只取退出码，
 * 输出一律丢弃；SSH 私钥只看文件在不在，绝不读内容。
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
// 设置页打开时就要出状态，任何一个探针卡住都不能把整页拖住。
const PROBE_TIMEOUT_MS = 10_000

/** origin 用的是哪种协议。scp 式的 `git@host:path` 也算 SSH。 */
export function remoteProtocol(url) {
  const value = String(url ?? '').trim()
  if (value.startsWith('https://')) return 'https'
  if (value.startsWith('ssh://') || /^[^/\s]+@[^/\s]+:/u.test(value)) return 'ssh'
  return 'unknown'
}

const HINTS = {
  'missing-gh': '没找到 gh 命令。先安装 GitHub CLI（macOS 可用 `brew install gh`），再执行 `gh auth login`。',
  'logged-out': '尚未登录 GitHub。执行 `gh auth login`，选择 HTTPS 协议，并在最后一步允许它配置 git。',
  'no-git-helper': '已登录，但 git 还没用上这份凭据。执行 `gh auth setup-git` 之后再更新。',
  'ssh-unverified': '本机有 SSH 私钥，但能否拉取只有连上去才知道。执行 `ssh -T git@github.com` 自测；'
    + '若提示 Permission denied (publickey)，说明公钥没挂到账号上，执行 `gh auth login` 并选择 SSH 协议。',
  'ssh-no-key': '没找到 SSH 私钥。执行 `ssh-keygen -t ed25519` 生成一对，再执行 `gh auth login` 并选择 SSH 协议，它会代传公钥。',
  unknown: 'origin 既不是 https 也不是 ssh 地址，无法判断 GitHub 授权状态。',
}

/**
 * 把探针结果定成状态。纯函数，不联网也不碰文件系统。
 *
 * HTTPS 是四态而不是「登录了没有」两态：`gh auth login` 里「是否配置 git」那一步
 * 可以跳过，跳过后 `gh auth token` 成功而 `git pull` 依旧失败。
 *
 * SSH 侧**没有 `ready`**：本机看得见私钥完全不代表 GitHub 接受它（公钥可能没挂到
 * 账号上），端口 22 还可能在本机被劫持——两种失败本地都探不出来，唯一诚实的呈现
 * 是「无法确认」，真实判据留给联网时的错误翻译。
 */
export function classifyGithubAuth(probe) {
  const protocol = remoteProtocol(probe?.remote)
  if (protocol === 'https') {
    if (probe.ghInstalled !== true) return { state: 'missing-gh', hint: HINTS['missing-gh'] }
    if (probe.loggedIn !== true) return { state: 'logged-out', hint: HINTS['logged-out'] }
    if (probe.gitHelper !== true) return { state: 'no-git-helper', hint: HINTS['no-git-helper'] }
    return { state: 'ready', hint: '' }
  }
  if (protocol === 'ssh') {
    const state = probe.sshKey === true ? 'ssh-unverified' : 'ssh-no-key'
    return { state, hint: HINTS[state] }
  }
  return { state: 'unknown', hint: HINTS.unknown }
}

/** 读一个本地命令的 stdout；失败返回空串。 */
async function probeOutput(file, args) {
  try {
    const { stdout } = await execFileAsync(file, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS })
    return stdout
  } catch {
    return ''
  }
}

/**
 * 只看一个命令的退出码，返回值一概不接。`gh auth token` 的 stdout 就是 token 本身，
 * 绝不能落进插件的任何变量——「有没有登录」用退出码就够了。
 */
async function probeStatus(file, args) {
  try {
    await execFileAsync(file, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS })
    return 'ok'
  } catch (error) {
    // 命令没装和「装了但失败」是两回事，引导文案完全不同。
    return error?.code === 'ENOENT' ? 'missing' : 'failed'
  }
}

/** ~/.ssh 下有没有私钥。只看文件名，不读内容。 */
async function hasSshKey() {
  try {
    const names = await readdir(join(homedir(), '.ssh'))
    return names.some((name) => name.startsWith('id_') && !name.endsWith('.pub'))
  } catch {
    return false
  }
}

/**
 * 跑本地探针并定态。全程不联网——打开设置页不该悄悄发请求，所以用 `gh auth token`
 * （只读本机 keyring）而不是会调 API 的 `gh auth status`。
 */
export async function readGithubAuth() {
  // 用 `git -C 插件目录` 而不是读全局配置，否则会漏掉仓库级的覆盖。
  const remote = (await probeOutput('git', ['-C', HERE, 'remote', 'get-url', 'origin'])).trim()
  const protocol = remoteProtocol(remote)

  if (protocol === 'https') {
    const gh = await probeStatus('gh', ['auth', 'token'])
    const helper = await probeOutput('git', ['-C', HERE, 'config', '--get-all', 'credential.https://github.com.helper'])
    return classifyGithubAuth({
      remote,
      ghInstalled: gh !== 'missing',
      loggedIn: gh === 'ok',
      gitHelper: helper.includes('gh auth git-credential'),
    })
  }
  if (protocol === 'ssh') return classifyGithubAuth({ remote, sshKey: await hasSshKey() })
  return classifyGithubAuth({ remote })
}
