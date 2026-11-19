# 全部弹窗布局优化

日期：2026-11-19。状态：用户已确认方案，实施中；完成项与验证结果随实施更新。

## 已确认范围

主窗口三栏不变。按用途优化创建/重命名等小表单、打开仓库、安全确认与错误、设置与仓库管理、快速选择、Diff/历史/报告阅读、工作流确认与执行进度、更新，以及组件内部的 stash 和工作流命名/删除小窗。菜单与下拉保留锚定方式，复核边界、长列表与文案。原生文件选择窗沿用系统界面。分组管理沿用上一轮布局，仅回归核对。

## 共用布局约定

- 各用途继续决定自己的宽度；小表单保持紧凑，阅读区保留全屏和宽正文。
- `dialog-shell`：纵向 flex、屏幕四周至少 16px 余量、限制最大宽高并隐藏外溢。
- `dialog-header`：固定标题区，使用实际 header 元素，以保留 Win7 / XP 标题皮肤。
- `dialog-body`：min-height:0 的可滚动正文，路径与长错误安全换行。
- `dialog-footer`：固定动作区，允许按钮换行；需要的校验、选择摘要和危险说明靠近执行动作。
- `dialog-title` / `dialog-field`：统一标题与纵向字段分工，不新增组件库或依赖。
- 快速选择器保留靠上定位，阅读工作区保留可调侧栏、全屏、搜索和 AI 报告等原功能。

## 不变的业务边界

所有真实调用、事件参数、v-model、父层刷新、取消含义、危险操作确认、IME、焦点陷阱、全局 Esc、运行中不可关闭条件保持原语义。不把关闭进度窗改成停止任务，不伪造完成、进度或恢复承诺。继续覆盖 light、dark、Catppuccin Latte、Catppuccin Mocha、Windows 7、Windows XP，以及跟随系统。

## 组件覆盖与当前状态

| 类别 | 覆盖组件 | 状态 |
| --- | --- | --- |
| 小表单 / 确认 / 错误 | CreateBranchDialog、CreateTagDialog、GroupNameDialog、TabRenameDialog、BranchRenameDialog、ConfirmDialog、ErrorDialog、OpenRepoDialog | 已完成 |
| 执行 / 进度 / MR | WorkflowAskMessage、WorkflowConfirmDialog、WorkflowRunDialog、WorkflowRunBatchDialog、UpdateDialog、MrPreviewDialog | 已完成 |
| 阅读 / 比较 | AiReviewDialog、ReleaseNotesDialog、RangeDiffDialog、FileHistoryModal、DiffViewer | 已完成 |
| 设置 / 管理 | SettingsModal（含内嵌工作流删除、重命名）、ReposOverviewModal、WorktreeModal、ReflogModal | 已完成 |
| 快速选择 | RepoSwitcher、BranchSwitcher、CommandPalette | 已完成 |
| 局部模态 / 菜单 | ChangesPanel 的 stash 保存与恢复确认、FolderDropdown、ContextMenu、Select、Tooltip | 已完成 |
| 分组管理 | GroupManagerModal | 沿用上一轮布局，回归编译通过 |
| Toast / 原生文件选择 | Toast、系统目录/文件选择器 | 审视后沿用现有实现，无新增决策与状态 |

## 验证与边界

局部实施先验证 SFC 模板，整合后运行 pnpm verify、全量模板/事件接线检查及独立源码验收。新增局部显示状态按实际逻辑检查；不为样式新增 UI 单测。发现业务或安全回归先复现再修复。

`pnpm verify` 已通过：契约 62 个 command / 13 个 serde struct 一致，六套主题 264 项对比度全绿，vue-tsc 无错误，14 个测试文件全部通过，生产构建成功。

三轮独立只读验收提出的问题均已修复并记录在 `docs/BUGS.md`：MR 生成中按钮文案、FileHistory 全屏被标题栏遮挡、页脚自身滚动挤压主动作、参数标签截断与分支前缀下拉缺可访问名称、批次进度窗错误文本嵌在折叠按钮内。

验收带出的两项既有风险也已处理：

- **正文被固定区压没**：校验区与按钮行拆成两层，按钮行 `shrink-0`；`.dialog-body` 给 4rem 保底高度。上限可算：标题 ≤25vh，页脚最多「校验 25vh + 按钮行」或「说明 20vh + 按钮行」，合计远低于 100vh，保底不会被壳的 `overflow: hidden` 裁切。
- **侧栏自动收起是死代码**：窗口 `minWidth` 860，`innerWidth < 760` 永不成立，`FileHistoryModal` 与 `DiffViewer` 各挂了一个空转的 resize 监听。阈值判断已移除，收起改为纯手动；DiffViewer 的 `winW` 保留，它还用于列表宽度上限（窗口 45%）。

本轮未经用户额外授权不调用浏览器或截图。实际桌面 UI 冒烟尚未执行，不将静态源码或构建检查称作实机验收。人工清单：短窗口、字号 20、长路径/错误/名单、六主题与系统模式、Win7/XP皮肤、Tab/Shift+Tab/IME/Esc、焦点返回、危险确认、克隆/更新锁定、进度窗关闭后任务继续、设置外观预览取消还原。
