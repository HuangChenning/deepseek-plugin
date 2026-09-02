import assert from 'node:assert/strict'
import test from 'node:test'

import { createKeychain } from '../src/keychain.js'

function fakeExecFile({ stdout = '', error = null } = {}) {
  const calls = []
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options })
    callback(error, stdout, '')
  }
  return { calls, execFile }
}

test('reads a profile password with security argument arrays', async () => {
  const fake = fakeExecFile({ stdout: 'client-secret\n' })
  const keychain = createKeychain({ execFile: fake.execFile })

  assert.equal(await keychain.readPassword('profile-hash'), 'client-secret')
  assert.deepEqual(fake.calls[0].args, [
    'find-generic-password', '-s', 'mes-plan-list.smtp', '-a', 'profile-hash', '-w',
  ])
  assert.equal(fake.calls[0].options.shell, false)
})

test('writes a profile password without invoking a shell', async () => {
  const fake = fakeExecFile()
  const keychain = createKeychain({ execFile: fake.execFile })

  await keychain.writePassword('profile-hash', 'client-secret')

  assert.deepEqual(fake.calls[0].args, [
    'add-generic-password', '-U', '-s', 'mes-plan-list.smtp', '-a', 'profile-hash', '-w', 'client-secret',
  ])
})

test('deletes only the requested profile password', async () => {
  const fake = fakeExecFile()
  const keychain = createKeychain({ execFile: fake.execFile })

  await keychain.deletePassword('profile-hash')

  assert.deepEqual(fake.calls[0].args, [
    'delete-generic-password', '-s', 'mes-plan-list.smtp', '-a', 'profile-hash',
  ])
})

test('hides raw Keychain errors from callers', async () => {
  const fake = fakeExecFile({ error: Object.assign(new Error('password=raw-secret'), { code: 1 }) })
  const keychain = createKeychain({ execFile: fake.execFile })

  await assert.rejects(keychain.writePassword('profile-hash', 'client-secret'), (error) => {
    assert.equal(error.message.includes('raw-secret'), false)
    assert.equal(error.message, '保存 SMTP 密码失败')
    return true
  })
})

test('treats a missing Keychain item as an absent password', async () => {
  const fake = fakeExecFile({ error: Object.assign(new Error('The specified item could not be found.'), { code: 44 }) })
  const keychain = createKeychain({ execFile: fake.execFile })

  assert.equal(await keychain.readPassword('profile-hash'), undefined)
})
