import assert from 'node:assert/strict'
import test from 'node:test'

import { isUpToDate, resolveMesBinary, setHostMesPath } from '../src/mes-cli.js'

// `mes update --check` 忽略 -o json，只有文本可读，所以这个判断必须朝安全的方向
// 失败：认不出就当作可能有更新。反过来会在 MES 改文案后让用户错过更新。
test('recognizes the CLI up-to-date line', () => {
  assert.equal(isUpToDate('  ✓  mes is up to date: 0.5.3'), true)
})

test('treats an unrecognized check output as possibly out of date', () => {
  assert.equal(isUpToDate('a new version is available: 0.6.0'), false)
  assert.equal(isUpToDate('检查失败：无法连接更新服务器'), false)
  assert.equal(isUpToDate(''), false)
})

/*
 * 两个配置来源的优先级。Harness 的插件配置是现在的正门，旧 config.json 只是
 * 兼容回退；两者同时有值时必须是 Harness 赢，否则用户在设置里改了路径却没生效。
 */
test('the Harness path takes precedence over the legacy config file', async () => {
  setHostMesPath('/opt/homebrew/bin/mes')
  try {
    assert.equal(await resolveMesBinary({ mesPath: '/old/from/config.json' }), '/opt/homebrew/bin/mes')
  } finally {
    setHostMesPath('')
  }
})

test('without a Harness path the legacy config file still decides', async () => {
  setHostMesPath('')

  assert.equal(await resolveMesBinary({ mesPath: '/old/from/config.json' }), '/old/from/config.json')
  assert.equal(await resolveMesBinary({ mesPath: '' }), 'mes', '两处都没配就沿用 PATH')
})

// 这个字段决定 Host 执行哪个二进制，Schema.string() 只保证是字符串，不保证是路径。
test('a Harness path that is not absolute is rejected rather than executed', () => {
  assert.throws(() => setHostMesPath('mes'), /绝对路径/)
  assert.throws(() => setHostMesPath('/usr/bin/\u0000mes'), /非法字符/)
})
