import assert from 'node:assert/strict'
import test from 'node:test'

import { readPluginVersion } from '../src/self-update.js'

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
