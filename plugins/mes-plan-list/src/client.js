/**
 * 浏览器半边：向 DSH Web 侧边栏注入「实施计划」入口，并在中央列打开插件页面。
 *
 * DSH 外壳没有给外部插件开放侧边栏 slot，因此入口行以纯 DOM 方式注入到
 * 「新建会话」按钮之后，并用 MutationObserver 在 React 重渲染后自愈。
 * 页面本身仍由 Host 半边在 /plugins/mes-plan-list 提供，这里只用 iframe 承载，
 * 避免把已经可用的页面重写成 React 组件。
 *
 * DSH 的 client bundle 必须通过 window.__ModuleLoader__.load 自注册，且工厂内
 * 使用 CommonJS 形态导出。本插件没有浏览器侧依赖，因此手写这层包装即可，
 * 不引入打包器。
 */

window.__ModuleLoader__.load({
  id: 'mes-plan-list',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

const ROW_ATTR = 'data-dsh-mesplan-entry'
const VIEW_ATTR = 'data-dsh-mesplan-view'
const ACTIVE_ATTR = 'data-dsh-mesplan-active'
const PAGE_PATH = '/plugins/mes-plan-list'
const STYLE_ID = 'dsh-mesplan-style'

const ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2" width="11" height="12" rx="1.5"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></svg>'

const CSS = `
[${VIEW_ATTR}] {
  position: absolute;
  inset: 0;
  display: none;
  z-index: 60;
  background: var(--dsw-alias-bg-base, #fff);
}
[${VIEW_ATTR}] iframe { display: block; width: 100%; height: 100%; border: none; }
html[${ACTIVE_ATTR}] [${VIEW_ATTR}] { display: block; }
html[${ACTIVE_ATTR}] [data-pane='conversation'] > :not([${VIEW_ATTR}]),
html[${ACTIVE_ATTR}] [class*='centerCol'] > :not([${VIEW_ATTR}]) { display: none !important; }
[${ROW_ATTR}] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
[${ROW_ATTR}]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
[${ROW_ATTR}][data-active] {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
[${ROW_ATTR}] .mesplan-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex: none; }
[${ROW_ATTR}] .mesplan-label { overflow: hidden; text-overflow: ellipsis; }
[data-dsh-frame][data-sidebar-collapsed] [${ROW_ATTR}],
[data-sidebar-collapsed] [${ROW_ATTR}] { justify-content: center; padding: 0; width: 36px; height: 36px; margin: 0 auto 12px; border-radius: 50%; }
[data-dsh-frame][data-sidebar-collapsed] [${ROW_ATTR}] .mesplan-label,
[data-sidebar-collapsed] [${ROW_ATTR}] .mesplan-label { display: none; }
`

function injectStyle() {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
}

function sidebarRoot() {
  const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild ?? undefined
}

function centerColumn() {
  return document.querySelector('[data-pane="conversation"], [class*="centerCol"]') ?? undefined
}

function newSessionAnchor(root) {
  const nested = root.querySelector('button[class*="newSession"]')
  if (nested !== null) return nested.closest('[class*="logoRow"]')?.parentElement === root ? nested.closest('[class*="logoRow"]') : nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child
  }
  return undefined
}

/** 由外壳背景色的亮度推断当前是明色还是暗色主题。 */
function themeMode() {
  const parts = getComputedStyle(document.body).backgroundColor.match(/\d+(?:\.\d+)?/g)
  if (parts === null || parts.length < 3) return undefined
  const [red, green, blue] = parts.map(Number)
  return (red * 299 + green * 587 + blue * 114) / 1000 < 128 ? 'dark' : 'light'
}

/** 反复把节点放回容器，直到外壳重建后再次被观察到。 */
function keepMounted(findParent, node, place) {
  let observer
  const tryPlace = () => {
    if (node.isConnected && node.parentElement?.isConnected === true) return
    const parent = findParent()
    if (parent === undefined) return
    place(parent, node)
  }
  observer = new MutationObserver(tryPlace)
  observer.observe(document.body, { childList: true, subtree: true })
  tryPlace()
  return () => {
    observer.disconnect()
    node.remove()
  }
}

function apply() {
  if (typeof document === 'undefined') return
  if (document.querySelector(`[${ROW_ATTR}]`) !== null) return
  injectStyle()

  const view = document.createElement('div')
  view.setAttribute(VIEW_ATTR, '')
  const frame = document.createElement('iframe')
  frame.title = 'MES 实施计划'
  view.append(frame)

  // 页面在独立 iframe 文档里，拿不到外壳的 CSS 变量，因此把明暗结果推给它。
  const pushTheme = () => {
    const mode = themeMode()
    if (mode !== undefined) frame.contentWindow?.postMessage({ mesPlanTheme: mode }, location.origin)
  }
  frame.addEventListener('load', pushTheme)
  new MutationObserver(pushTheme).observe(document.documentElement, { attributes: true })

  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(ROW_ATTR, '')
  entry.setAttribute('data-dsh-plugin', 'mes-plan-list')
  entry.setAttribute('data-dsh-part', 'sidebar-entry')
  entry.setAttribute('aria-label', '实施计划')
  entry.innerHTML = `<span class="mesplan-icon">${ICON}</span><span class="mesplan-label">实施计划</span>`

  entry.addEventListener('click', () => {
    const open = document.documentElement.hasAttribute(ACTIVE_ATTR)
    if (open) {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
      delete entry.dataset.active
      return
    }
    // 首次打开才加载页面，之后保留 iframe 状态（已查询的结果不会丢失）。
    if (frame.getAttribute('src') === null) frame.setAttribute('src', PAGE_PATH)
    document.documentElement.setAttribute(ACTIVE_ATTR, '')
    entry.dataset.active = 'true'
  })

  keepMounted(sidebarRoot, entry, (root, node) => {
    const anchor = newSessionAnchor(root)
    root.insertBefore(node, anchor === undefined ? root.firstChild : anchor.nextSibling)
  })
  keepMounted(centerColumn, view, (column, node) => {
    if (getComputedStyle(column).position === 'static') column.style.position = 'relative'
    column.append(node)
  })
}

    exports.apply = apply
    return module.exports
  },
})
