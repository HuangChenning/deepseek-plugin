import assert from 'node:assert/strict'
import test from 'node:test'

import { isUpToDate } from '../src/mes-cli.js'

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
