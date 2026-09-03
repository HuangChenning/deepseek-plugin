import assert from 'node:assert/strict'
import test from 'node:test'

import { checkPluginUpdate, needsDependencyInstall, pullPluginUpdate, readPluginVersion } from '../src/self-update.js'

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
 * 跨过一次加依赖的提交后只更新 git 不装依赖，重启 DSH 就直接起不来——2026-09-03
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

function fakeGit(pulledFiles, calls = []) {
  let merged = false
  return async (args) => {
    calls.push(args)
    if (args[0] === 'status') return ''
    if (args[0] === 'remote' || args[0] === 'fetch') return ''
    if (args[0] === 'merge') { merged = true; return '' }
    if (args[0] === 'diff') return pulledFiles
    if (args[0] === 'rev-parse' && args[1] === '--short') return merged ? 'bbbbbbb' : 'aaaaaaa'
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

test('checks only the official HTTPS main branch', async () => {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return 'aaaaaaaaaaaaaaaa'
    if (args[0] === 'ls-remote') return 'bbbbbbbbbbbbbbbb\trefs/heads/main'
    throw new Error('unexpected git ' + args.join(' '))
  }
  const readVersion = async () => ({ branch: 'local-topic', commit: 'aaaaaaa' })

  const result = await checkPluginUpdate({ run, readVersion })

  assert.equal(result.upToDate, false)
  assert.deepEqual(calls, [
    ['rev-parse', 'HEAD'],
    ['ls-remote', 'https://github.com/HuangChenning/deepseek-plugin.git', 'main'],
  ])
})

/*
 * 仓库公开后，更新不再依赖每台机器原来留下的是 SSH 还是 HTTPS，也不依赖 gh。
 * remote 和 ref 都是固定值，浏览器没有机会把更新指向别处。
 */
test('updates only from the official HTTPS main branch', async () => {
  const calls = []
  await pullPluginUpdate({ run: fakeGit('plugins/mes-plan-list/src/page.js\n', calls) })

  assert.deepEqual(calls.slice(0, 6), [
    ['status', '--porcelain'],
    ['rev-parse', '--short', 'HEAD'],
    ['remote', 'set-url', 'origin', 'https://github.com/HuangChenning/deepseek-plugin.git'],
    ['fetch', 'origin', 'main'],
    ['merge', '--ff-only', 'FETCH_HEAD'],
    ['rev-parse', '--short', 'HEAD'],
  ])
})

test('does not change origin when the working tree is dirty', async () => {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    return args[0] === 'status' ? ' M README.md' : ''
  }

  await assert.rejects(pullPluginUpdate({ run }), /未提交/u)
  assert.deepEqual(calls, [['status', '--porcelain']])
})

/*
 * git 的 stderr 里可能带着 remote URL。联网失败给固定文案，原文一个字都不出去。
 */
test('never echoes raw git output to the browser', async () => {
  const run = async (args) => {
    if (args[0] === 'status') return ''
    if (args[0] === 'rev-parse') return 'aaaaaaa'
    if (args[0] === 'remote') return ''
    if (args[0] === 'fetch') throw new Error("fatal: unable to access 'https://github.com/HuangChenning/deepseek-plugin.git/': boom")
    throw new Error('unexpected git ' + args.join(' '))
  }

  await assert.rejects(pullPluginUpdate({ run }), (error) => {
    assert.doesNotMatch(error.message, /https:\/\//u, '远程 URL 不得回显')
    assert.doesNotMatch(error.message, /fatal:/u, 'git 原文不得回显')
    assert.match(error.message, /更新失败/u)
    return true
  })
})
