/**
 * 把本工作区的插件注册进一个 DSH profile。
 *
 * `dsh plugin add` 会顺带跑一次 pnpm install，因而会重新校验整个 profile 的
 * lockfile；只要 profile 里有任何一个无关的包违反供应链策略（例如尚未过
 * minimumReleaseAge 冷却期），注册就会被一并拒绝。本脚本只做注册本身需要的三件
 * 事——写 dependencies、写 dsh.profile.bundles、建 node_modules 软链——因此不受
 * 其他包的状态影响。三步都是幂等的。
 *
 * 用法：node scripts/register-dsh-plugins.mjs [profile]   （默认 web）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profileName = process.argv[2] ?? 'web'
const profileDir = join(homedir(), '.dsh', 'profiles', profileName)
const manifestPath = join(profileDir, 'package.json')

if (!existsSync(manifestPath)) {
  console.error(`找不到 DSH profile：${profileDir}`)
  console.error(`先运行一次 \`dsh --profile ${profileName}\` 让 DSH 创建它。`)
  process.exit(1)
}

const pluginsDir = join(repoRoot, 'plugins')
const plugins = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'package.json')))
  .map((entry) => {
    const path = join(pluginsDir, entry.name)
    return { path, name: JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name }
  })

if (plugins.length === 0) {
  console.error(`plugins/ 下没有找到插件包。`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []

const changes = []
for (const plugin of plugins) {
  const specifier = `link:${plugin.path}`
  if (manifest.dependencies[plugin.name] !== specifier) {
    manifest.dependencies[plugin.name] = specifier
    changes.push(`dependencies += ${plugin.name}`)
  }
  // bundles 的顺序就是插件的加载顺序，因此只追加，不重排已有条目。
  if (!manifest.dsh.profile.bundles.includes(plugin.name)) {
    manifest.dsh.profile.bundles.push(plugin.name)
    changes.push(`bundles += ${plugin.name}`)
  }

  // pnpm 平时会建这个软链；这里自己建，好让注册完全绕开 pnpm。
  const modulesDir = join(profileDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const linkPath = join(modulesDir, plugin.name)
  const linked = existsSync(linkPath) && realpathSync(linkPath) === realpathSync(plugin.path)
  if (!linked) {
    if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined) {
      console.error(`${linkPath} 已存在且不指向 ${plugin.path}，请先手动移除。`)
      process.exit(1)
    }
    symlinkSync(relative(modulesDir, plugin.path), linkPath, 'dir')
    changes.push(`node_modules/${plugin.name} -> ${plugin.path}`)
  }
}

if (changes.length === 0) {
  console.log(`profile ${profileName} 已是最新，无需改动。`)
  process.exit(0)
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
for (const change of changes) console.log(change)
console.log(`\n已注册到 ${profileDir}，重启 \`dsh --profile ${profileName}\` 生效。`)
