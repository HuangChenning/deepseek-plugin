import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyGithubAuth, remoteProtocol } from '../src/github-auth.js'

const https = { remote: 'https://github.com/HuangChenning/deepseek-plugin.git' }
const ssh = { remote: 'git@github.com:HuangChenning/deepseek-plugin.git' }

test('reads the protocol off origin in the three shapes git writes', () => {
  assert.equal(remoteProtocol('https://github.com/HuangChenning/deepseek-plugin.git'), 'https')
  assert.equal(remoteProtocol('git@github.com:HuangChenning/deepseek-plugin.git'), 'ssh')
  assert.equal(remoteProtocol('ssh://git@github.com/HuangChenning/deepseek-plugin.git'), 'ssh')
  assert.equal(remoteProtocol('/Users/huangcn/mirror.git'), 'unknown')
  assert.equal(remoteProtocol(''), 'unknown')
  assert.equal(remoteProtocol(undefined), 'unknown')
})

/*
 * 四态不能压成「登录了没有」两态：`gh auth login` 的交互流程里「是否配置 git」
 * 可以跳过，此时 `gh auth token` 成功而 `git pull` 依旧失败。压成两态就会对着这种
 * 用户报「已就绪」，把他们推向一个查不出原因的失败——那比不给状态更糟。
 */
test('distinguishes a skipped git helper from being logged out', () => {
  const at = (probe) => classifyGithubAuth({ ...https, ...probe })

  assert.equal(at({ ghInstalled: true, loggedIn: true, gitHelper: true }).state, 'ready')
  assert.equal(at({ ghInstalled: true, loggedIn: true, gitHelper: false }).state, 'no-git-helper')
  assert.equal(at({ ghInstalled: true, loggedIn: false, gitHelper: false }).state, 'logged-out')
  assert.equal(at({ ghInstalled: false, loggedIn: false, gitHelper: false }).state, 'missing-gh')

  // 两条最容易写反的引导：漏配 helper 该跑 setup-git，不是重新登录。
  assert.match(at({ ghInstalled: true, loggedIn: true, gitHelper: false }).hint, /gh auth setup-git/u)
  assert.match(at({ ghInstalled: true, loggedIn: false }).hint, /gh auth login/u)
  assert.doesNotMatch(at({ ghInstalled: true, loggedIn: true, gitHelper: false }).hint, /gh auth login/u)
  assert.equal(at({ ghInstalled: true, loggedIn: true, gitHelper: true }).hint, '')
})

/*
 * 2026-09-03 在作者机器上实测：`~/.ssh/id_ed25519` 存在、`gh` 也已登录，
 * `ssh -T git@github.com` 仍然是 Permission denied (publickey)——公钥没挂到账号上；
 * 同一台机器的 22 端口还被劫持到 198.18.0.5，只有 ssh.github.com:443 通。两种失败
 * 本地都探不出来，所以「本机有私钥」只够说「无法确认」。报绿会让用户停止排查，
 * 这是本文件最该防的回归。
 */
test('never reports ssh as ready because a local key proves nothing', () => {
  for (const sshKey of [true, false]) {
    for (const ghInstalled of [true, false]) {
      for (const loggedIn of [true, false]) {
        for (const gitHelper of [true, false]) {
          const result = classifyGithubAuth({ ...ssh, sshKey, ghInstalled, loggedIn, gitHelper })
          assert.notEqual(result.state, 'ready')
          assert.ok(['ssh-unverified', 'ssh-no-key'].includes(result.state), result.state)
        }
      }
    }
  }

  assert.equal(classifyGithubAuth({ ...ssh, sshKey: true }).state, 'ssh-unverified')
  assert.equal(classifyGithubAuth({ ...ssh, sshKey: false }).state, 'ssh-no-key')
  // 没私钥先生成；有私钥也只能让用户自己跑一次连通性测试——插件不代跑，那要联网。
  assert.match(classifyGithubAuth({ ...ssh, sshKey: false }).hint, /ssh-keygen/u)
  assert.match(classifyGithubAuth({ ...ssh, sshKey: true }).hint, /ssh -T git@github\.com/u)
})

/*
 * 一个没有下一步动作的状态条等于噪音：用户看得见「不行」，却不知道该敲什么。
 * `unknown` 也要有话说——它说的是「判断不了」，不是编一条引导出来。
 */
test('always says what to do next unless the state is already ready', () => {
  const probes = [
    { ...https, ghInstalled: true, loggedIn: true, gitHelper: true },
    { ...https, ghInstalled: true, loggedIn: true, gitHelper: false },
    { ...https, ghInstalled: true, loggedIn: false },
    { ...https, ghInstalled: false },
    { ...ssh, sshKey: true },
    { ...ssh, sshKey: false },
    { remote: '/Users/huangcn/mirror.git' },
    { remote: '' },
  ]
  const seen = new Set()

  for (const probe of probes) {
    const { state, hint } = classifyGithubAuth(probe)
    seen.add(state)
    if (state === 'ready') assert.equal(hint, '')
    else assert.notEqual(hint.trim(), '', state)
  }

  assert.deepEqual([...seen].sort(), [
    'logged-out', 'missing-gh', 'no-git-helper', 'ready', 'ssh-no-key', 'ssh-unverified', 'unknown',
  ])
})
