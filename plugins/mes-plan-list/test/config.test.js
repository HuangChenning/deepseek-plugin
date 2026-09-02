import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readConfig, validateMesPath, writeConfig } from '../src/config.js'

async function tempConfigPath() {
  return join(await mkdtemp(join(tmpdir(), 'mes-plan-list-')), 'config.json')
}

// 这个字段决定 Host 执行哪个二进制，所以格式校验是安全边界，不只是输入整洁。
test('rejects a relative mes path so a query cannot pick up a binary from the cwd', () => {
  assert.throws(() => validateMesPath('./mes'), { message: 'mes 路径必须是绝对路径' })
  assert.throws(() => validateMesPath('mes'), { message: 'mes 路径必须是绝对路径' })
})

test('rejects control characters in a mes path', () => {
  assert.throws(() => validateMesPath('/usr/bin/mes\n/etc/passwd'), { message: 'mes 路径包含非法字符' })
})

test('treats an empty mes path as "use PATH"', () => {
  assert.equal(validateMesPath(''), '')
  assert.equal(validateMesPath('   '), '')
})

test('reads the default config when no file exists yet', async () => {
  assert.deepEqual(await readConfig(await tempConfigPath()), { mesPath: '' })
})

test('round-trips a saved mes path', async () => {
  const path = await tempConfigPath()

  const saved = await writeConfig({ mesPath: '/opt/homebrew/bin/mes' }, path)

  assert.deepEqual(saved, { mesPath: '/opt/homebrew/bin/mes' })
  assert.deepEqual(await readConfig(path), { mesPath: '/opt/homebrew/bin/mes' })
  assert.match(await readFile(path, 'utf8'), /"mesPath": "\/opt\/homebrew\/bin\/mes"/)
})

test('refuses to persist a relative path', async () => {
  const path = await tempConfigPath()

  await assert.rejects(writeConfig({ mesPath: 'mes' }, path), { message: 'mes 路径必须是绝对路径' })
})

// 配置文件损坏不应让整个插件不可用——退回 PATH 仍然是可用状态。
test('falls back to PATH when the config file is corrupt', async () => {
  const path = await tempConfigPath()
  await writeFile(path, '{ not json')

  assert.deepEqual(await readConfig(path), { mesPath: '' })
})
