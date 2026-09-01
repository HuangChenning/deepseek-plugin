# 后续工作交接清单

最后更新：2026-09-02

当前 `main` 已包含第一个 DSH Web 插件 `mes-plan-list`，并已推送到 GitHub。以下事项尚未完成，供后续 agent 接手。

## 必须补充验证

- [ ] 使用已登录的 MES 账号执行一次真实查询，确认 `mes -o json plan list` 的返回字段与页面表格列完全匹配。
  - 先运行 `mes auth status`。
  - 选择明确的日期范围和状态，避免无意发起大范围查询。
  - 检查客户、计划标题、日期、状态等字段是否存在；若实际字段不同，更新 `plugins/mes-plan-list/src/page.js` 及测试。
- [ ] 在干净环境重新验证插件安装流程：
  - `dsh plugin --profile web add link:./plugins/mes-plan-list`
  - `dsh web --patch plugins/mes-plan-list/cordis.patch.yml --no-open`
  - 打开 `http://127.0.0.1:3080/plugins/mes-plan-list`。
- [ ] 确认 DSH profile 中已有插件的兼容性警告是否由当前 DSH 版本导致。已知 `dsh-task-board` 可能报告 `session/list` endpoint unavailable；这不是 `mes-plan-list` 的错误，但应在升级 DSH 或相关插件后复查。

## 工程化增强（尚未实现）

- [ ] 为 workspace 增加 CI：至少执行 `pnpm test`、`git diff --check` 和 README 审计。
- [ ] 确定发布/版本策略，并将 `CHANGELOG.md` 的 `[Unreleased]` 内容归档到实际版本。
- [ ] 开发第二个 DSH 插件后，再评估是否抽取共享工具包；在此之前不要创建共享抽象。
- [ ] 评估是否需要额外筛选条件（客户、负责人、团队、标题）或分页；当前版本明确不包含这些功能。
- [ ] 评估是否需要计划详情链接、导出或其他只读展示；当前版本不提供计划修改能力。

## 当前运行与本地状态

- 当前 DSH Web 进程曾以 `--patch plugins/mes-plan-list/cordis.patch.yml` 在 `3080` 运行；其他 agent 接手前应先用 `lsof -nP -iTCP:3080 -sTCP:LISTEN` 确认端口占用。
- `AGENTS.md` 和 `CLAUDE.md` 是本地指令文件，必须同步更新且不得提交或推送。
- `.DS_Store` 是本地未跟踪文件，不得提交。
- DSH profile 的本地 `link:` 安装属于机器状态，不在 Git 仓库中；新机器需要重新执行安装命令。

## 已知设计决策

- 查询通过 Node `execFile('mes', args)` 执行，禁止 shell 拼接。
- API 只接受 `startDate`、`endDate`、`status`，并限制请求体为 16 KiB。
- 实施计划状态：`0` 未开始、`1` 进行中、`2` 结束、`3` 已逾期未结束。
- 页面固定使用 `--page 1 --page-size 200`，当前不做分页。
