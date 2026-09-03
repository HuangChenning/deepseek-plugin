import assert from 'node:assert/strict'
import test from 'node:test'

import { describeGitFailure, needsDependencyInstall, pullPluginUpdate, readPluginVersion } from '../src/self-update.js'

/*
 * 版本展示读的是 `git describe --tags --always`，它有三种形态，页面对每种的呈现
 * 都不同。这里用真实仓库跑一次，确认解析结果自洽——展示错版本比不展示更糟，因为
 * 使用者会据此判断自己要不要更新。
 */
test('reports a release version rather than a bare commit', async () => {
  const version = await readPluginVersion()

  assert.match(version.commit, /^[0-9a-f]{7,}$/)
  assert.notEqual(version.version, '', '必须给出可展示的版本')
  assert.ok(Number.isInteger(version.ahead) && version.ahead >= 0)
  // 正好停在某个 tag 上时 ahead 为 0，且版本不应带 -N-g 后缀。
  if (version.ahead === 0) {
    assert.doesNotMatch(version.version, /-\d+-g[0-9a-f]+$/)
  } else {
    assert.doesNotMatch(version.version, /-g[0-9a-f]+$/, '领先提交数应被单独拆出，不留在版本号里')
  }
})

/*
 * 跨过一次加依赖的提交后只 `git pull` 不装依赖，重启 DSH 就直接起不来——2026-09-03
 * 有人真踩了这一脚。反过来无条件装也不行：`pnpm install` 不是免费的，一次纯文档
 * 更新也要等上几十秒。所以判据只能是「依赖清单本身动过没有」。
 */
test('reinstalls only when the dependency manifest moved', () => {
  assert.equal(needsDependencyInstall(['plugins/mes-plan-list/package.json']), true)
  assert.equal(needsDependencyInstall(['pnpm-lock.yaml']), true)
  assert.equal(needsDependencyInstall(['pnpm-workspace.yaml']), true)
  assert.equal(needsDependencyInstall(['plugins/mes-plan-list/src/page.js', 'README.md']), false)
  assert.equal(needsDependencyInstall([]), false)
  // 只认整个文件名，别把恰好带这个后缀的别的文件也算进去。
  assert.equal(needsDependencyInstall(['docs/package.json.md']), false)
})

function fakeGit(pulledFiles) {
  let pulled = false
  return async (args) => {
    if (args[0] === 'status') return ''
    if (args[0] === 'pull') { pulled = true; return '' }
    if (args[0] === 'diff') return pulledFiles
    if (args[0] === 'rev-parse' && args[1] === '--short') return pulled ? 'bbbbbbb' : 'aaaaaaa'
    if (args[0] === 'rev-parse') return 'main'
    if (args[0] === 'log') return args.includes('--format=%cI') ? '2026-09-03T00:00:00+08:00' : '一次提交'
    if (args[0] === 'describe') return 'v0.5.0-1-gbbbbbbb'
    throw new Error('unexpected git ' + args.join(' '))
  }
}

/*
 * 「更新成功」出现在一个起不来的状态上，比直接报错更糟：用户据此去重启 DSH，然后
 * 对着一个打不开的界面找不着北。安装失败必须原样传到页面上。
 */
test('does not report a successful update when the dependency install failed', async () => {
  const install = async () => { throw new Error('依赖安装失败，请在仓库根手动执行 `pnpm install`') }
  const result = await pullPluginUpdate({ run: fakeGit('pnpm-lock.yaml\n'), install })

  assert.equal(result.changed, true)
  assert.equal(result.dependencies, 'failed')
  assert.match(result.dependencyError, /pnpm install/u)
})

test('skips the install when only source files moved', async () => {
  let installed = false
  const install = async () => { installed = true }
  const result = await pullPluginUpdate({
    run: fakeGit('plugins/mes-plan-list/src/page.js\n'),
    install,
  })

  assert.equal(installed, false)
  assert.equal(result.dependencies, 'unchanged')
})

/*
 * 本地探针在 SSH 侧永远给不出「已就绪」，联网失败因此是那条路唯一的真实判据。git 的
 * 原文（`could not read Username`、`Permission denied (publickey)`）对使用者毫无指向
 * 性，翻译的价值全在于**指向不同的下一步**——所以这里断言的是命令，不是措辞。
 */
test('translates each git authorization failure into a command to run', async () => {
  const cases = [
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", /gh auth setup-git/u],
    ["remote: Support for password authentication was removed.\nfatal: Authentication failed for 'https://github.com/x/y.git/'", /gh auth login/u],
    ['remote: Repository not found.\nfatal: repository not found', /仓库权限|访问权限/u],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', /gh auth login/u],
    ['ssh: connect to host github.com port 22: Operation timed out', /ssh\.github\.com|443/u],
  ]

  for (const [stderr, expected] of cases) {
    assert.match(describeGitFailure(stderr), expected, stderr.slice(0, 40))
  }
})

/*
 * 这两条最容易被归错，代价也最大：把权限问题说成没登录，会让人反复重登一个本来就
 * 登着的账号；把公钥问题指向 setup-git（那是 HTTPS 的命令）则纯属把人带偏。
 */
test('never mistakes a repository permission problem for a login problem', () => {
  const notFound = describeGitFailure('remote: Repository not found.')
  assert.doesNotMatch(notFound, /gh auth login/u, '权限不足时重新登录解决不了问题')

  const publickey = describeGitFailure('git@github.com: Permission denied (publickey).')
  assert.doesNotMatch(publickey, /setup-git/u, 'setup-git 是 HTTPS 那条路的命令')
})

/*
 * 过度匹配比不匹配更糟：把「工作区不干净」误报成「没登录」，用户会去折腾凭据，而
 * 真正要做的是提交本地改动。认不出来就交回给调用方，别硬翻。
 */
test('leaves non-authorization failures to the caller', () => {
  for (const text of [
    '仓库有未提交的改动，请先提交或还原后再更新',
    '远程没有同名分支，无法检查更新',
    'fatal: Not possible to fast-forward, aborting.',
    '',
    undefined,
  ]) {
    assert.equal(describeGitFailure(text), '', String(text).slice(0, 30))
  }
})

/*
 * git 的 stderr 里带着 remote URL，而 private 仓库的地址本身就是不该往浏览器送的
 * 信息。认不出来的失败给通用文案，原文一个字都不出去。
 */
test('never echoes raw git output to the browser', async () => {
  const run = async (args) => {
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-parse') return 'aaaaaaa'
    if (args[0] === 'pull') throw new Error("fatal: unable to access 'https://github.com/HuangChenning/deepseek-plugin.git/': boom")
    throw new Error('unexpected git ' + args.join(' '))
  }

  await assert.rejects(pullPluginUpdate({ run }), (error) => {
    assert.doesNotMatch(error.message, /https:\/\//u, '远程 URL 不得回显')
    assert.doesNotMatch(error.message, /fatal:/u, 'git 原文不得回显')
    assert.match(error.message, /更新失败/u)
    return true
  })
})
