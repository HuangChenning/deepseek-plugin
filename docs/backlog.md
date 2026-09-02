# 后续工作交接清单

最后更新：2026-09-02

> 五项新需求（mes 路径配置、登录检测、插件自更新、mes CLI 更新、SQLite 同步）
> 的方案与实施顺序见 [roadmap.md](./roadmap.md)。本文只记录既有工作的遗留项。

`main` 已包含 DSH Web 插件 `mes-plan-list`。本轮修复了插件从未被 DSH 加载的问题、
补上了侧边栏入口、并重做了页面设计。以下是仍未完成的事项。

## 本轮已完成（不必重做）

- 用已登录账号执行真实查询，核对了 `mes -o json plan list` 的返回字段：
  `id`、`companyName`、`title`、`startDate`、`endDate`、`status`、`statusDesc`
  全部存在；另有 `contractName`、`checkTypeDesc`、`executorList` 已加入表格。
  日期是 `YYYY-MM-DD HH:mm:ss`，页面只显示日期部分。
- 定位并修复了「页面查询不了数据」与「侧边栏看不到插件」：两者同因——
  `package.json` 缺 `dsh.bundle.patch`，插件名从未进入 profile 的
  `dsh.profile.bundles`，DSH 因此不加载它，两个路由都是 404。
- 确认 `dsh-task-board` 的 `session/list` endpoint 警告来自当前 DSH 版本
  （需 >= 0.1.2-alpha.2，本机为 0.1.1-rc.2），与 `mes-plan-list` 无关。
- 为 workspace 增加 CI（`pnpm test` + `git diff --check`）。
- 用 `pnpm register`（`scripts/register-dsh-plugins.mjs`）取代手工编辑 profile：
  `dsh plugin add` 会顺带跑一次覆盖整个 profile 的 pnpm install，因而被 profile
  里五个无关包的 `minimumReleaseAge` 违规一并拒绝（`@linxin666/*`、`dsh-context`、
  `dsh-cost-meter`、`dshmarket`；该 cutoff 是滚动窗口，不是固定日期）。脚本只写
  dependencies、`dsh.profile.bundles` 和 node_modules 软链，不受影响，且幂等。
- 取消 200 条结果上限：`queryPlans` 现在翻页取全（实测全年 958 条、5 次 CLI
  调用、约 7 秒）。

## 必须补充验证

- [ ] 确认 DSH 进程的 PATH 能找到 `mes`。查询用 `execFile('mes', args)`，依赖
      PATH 解析；本次验证是从终端启动 `dsh --profile web`（PATH 含
      `/opt/homebrew/bin`）。若从 GUI 或 launchd 启动，可能解析失败并统一报
      「MES 查询失败」。届时需要考虑可配置的绝对路径。

## 工程化增强（尚未实现）

- [ ] 确定发布/版本策略，并将 `CHANGELOG.md` 的 `[Unreleased]` 内容归档到实际
      版本。插件目前是 `private` 且无 `version` 字段，需要先决定是否发布到 npm。
- [ ] CI 尚未包含 README 审计（backlog 原条目），因为「审计」的判定标准未定义。
      需要先明确要检查什么（链接有效性？命令可执行性？），再实现。
- [ ] 开发第二个 DSH 插件后，再评估是否抽取共享工具包；在此之前不要创建共享抽象。
      侧边栏注入逻辑是第一个可能的候选。
- [ ] 评估是否需要额外筛选条件（客户、负责人、团队、标题）。当前版本不含这些。
      结果不再有条数上限，但大范围查询会串行发多次 CLI 调用、一次性渲染全部行；
      若实际使用中范围继续放大，需要考虑前端虚拟滚动或并行取页。
- [ ] 评估是否需要计划详情链接、导出或其他只读展示；当前版本不提供计划修改能力。

## 当前运行与本地状态

- 验证时 DSH Web 以 `dsh --profile web --no-open --port 3080` 运行；接手前先用
  `lsof -nP -iTCP:3080 -sTCP:LISTEN` 确认端口占用。
- `docs/superpowers/` 下的 plan 与 design 文档是初版归档，仍写着不存在的
  `dsh web --patch …` 命令和「不做分页」的验证标准，两者都已被实现取代。本次
  未改动它们（属于历史记录），但后续 agent 不应把它们当作现行约定。
- `AGENTS.md` 和 `CLAUDE.md` 是本地指令文件，必须同步更新且不得提交或推送。
- `.DS_Store` 是本地未跟踪文件，不得提交。
- DSH profile 的本地 `link:` 安装属于机器状态，不在 Git 仓库中；新机器需要重新
  执行安装命令。

## 已知设计决策

- 查询通过 Node `execFile('mes', args)` 执行，禁止 shell 拼接。
- API 只接受 `startDate`、`endDate`、`status`，并限制请求体为 16 KiB。
- 实施计划状态：`0` 未开始、`1` 进行中、`2` 结束、`3` 已逾期未结束。
- 每次向 MES 请求 200 条，由 `queryPlans` 依据 MES 返回的 `total` 翻页直到取完；
  空页也终止循环，避免 `total` 异常时打转。页面不分页，一次渲染全部结果。
- 侧边栏入口是纯 DOM 注入 + `MutationObserver` 自愈：DSH 没有给外部插件开放
  侧边栏 slot，`dsh-task-board` 也是同样做法。
- 面板用 iframe 承载已有页面，避免把页面重写成 React 组件；iframe 拿不到外壳的
  CSS 变量，因此 client 半边按外壳背景亮度推断明暗，用 `postMessage` 推给页面。
- client bundle 必须通过 `window.__ModuleLoader__.load` 自注册；直接导出 ES
  模块会让整个 Web UI 报「Failed to load plugins」。本插件无浏览器侧依赖，
  因此手写这层包装，不引入打包器。
