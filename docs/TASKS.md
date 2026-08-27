# git-zen 开发任务

状态标记：[ ] 待做 · [x] 完成 · [~] 进行中 · [-] 明确不做

## M1 骨架

- [x] 技术选型确认（Tauri 2 + Vue 3 + TS）
- [x] 项目骨架：package.json / vite / tsconfig / tauri.conf
- [x] Rust 后端全部 command（git.rs 单文件）
- [x] 前端类型镜像 gitApi.ts
- [x] 文档留存：docs/（DESIGN / NOTES / TASKS）
- [x] pnpm install + cargo check 通过
- [x] vue-tsc 类型检查通过
- [x] graph.test.ts 自检通过
- [x] `pnpm tauri dev` 跑起来，手动冒烟

## M2 核心四件套

- [x] 暂存/取消暂存（单文件 + 全部）
- [x] 提交（Ctrl+Enter 快捷键）
- [x] Push / Pull + ahead/behind 徽标
- [x] 分支列表 / 切换 / 新建
- [x] 泳道历史图（300 条上限）

## M3 打磨

- [x] UI 改版：Tailwind v4 + shadcn-vue 风格组件已落地（Button/Input/Textarea/Badge + lucide 图标）
- [x] 错误 toast 文案美化：humanize 映射（无上游/非快进/认证失败/非仓库/空仓库/冲突/网络）+ 原始 stderr 小字附显
- [x] 正式应用图标：scripts/gen-icon.mjs 生成泳道主题多尺寸 ICO（16-256），可重跑再生成
- [x] 空仓库 / 无上游分支等边界场景提示（随错误映射覆盖；空仓库已有"暂无提交"空态）
- [x] release 构建：`git-zen.exe`（9MB）已产出 ✓；NSIS 安装包被网络阻塞，有网环境重跑 `pnpm tauri build`

## M4 日常可用（已完成）

- [x] **diff 查看**：文件行 hover 出 diff 图标，弹层展示 +/- 行着色；未跟踪文件提示无 diff。后端 `git_diff(repo, path, cached)`
- [x] **checkout 远程分支**：点 origin/x 自动建同名本地跟踪分支（DWIM）
- [x] **历史过滤 + 加载更多**：顶部搜索框按提交信息/作者前端过滤（过滤时隐藏加载按钮）；`--skip` 分页每页 300
- [x] **启动/打开仓库后台 fetch 一次**：静默刷 ahead/behind，失败不打扰
- [x] **rename 显示**：porcelain `old -> new` 拆成删除线+箭头样式

### M4.1 日常可用 - 补充（已完成）

- [x] **commit 级 diff**：点历史行弹窗看整个 commit 的 patch（多文件，文件名分段标题）；后端 `git_show(repo, hash)`，hash 做了十六进制校验
- [x] **分支双击切换**：本地/远程分支都改为双击触发，hover 提示已更新
- [x] **滚动自动加载**：历史区滚到底部距底 60px 自动拉下一页（loading 防抖防重复触发），按钮已移除

### M4.2 日常可用 - 实用内容（已完成）

- [x] **仓库选项卡**：工具栏下方标签行，持久化所有导入过的仓库；单击切换、双击重命名、X 关闭、拖动排序
- [x] **本地分支删除/重命名**：叶子 hover 出 GitMerge/Pencil/Trash2 图标；删除走确认框且用 `-d` 安全删（未合并会拒绝）；重命名行内编辑回车保存
- [x] **分支合并**：非当前分支 hover 合并图标 → 确认框后 `merge --no-edit` 到当前分支；远程分支自动取同名跟踪分支名
- [x] **报错改确认框**：居中卡片展示友好文案 + 可展开的原始 stderr，点「确认」才关，不再自动消失
- [x] **diff 一键展开/收起**：多文件时头部出现两个按钮，操作折叠集合
- [x] **侧边栏拖宽**：两侧把手拖拽调整宽度（左 140-420 / 右 240-520），localStorage 持久化
- [x] **Spinner**：新增 `ui/Spinner.vue`（lucide LoaderCircle + animate-spin），历史区遮罩与 diff 弹窗加载态已换用，后续 loading 统一用它

### M4.3 日常可用 - 实用内容2（已完成）

- [x] **合并当前分支到某分支**：本地非当前分支 hover 出 GitPullRequestArrow 图标；流程=切到目标→merge 当前→成功切回，冲突则停在目标待解决（确认框写明流程）
- [x] **选项卡拖动换库**：改用 vue-draggable-plus（SortableJS），150ms 动画，v-model 自动同步排序；自研鼠标拖拽方案已移除
- [x] **快捷键**：Ctrl+Tab / Ctrl+Shift+Tab 切仓库、Ctrl+1..9 跳第 N 个、F5 刷新；设置弹窗新增「快捷键」页展示全部快捷键（固定绑定，暂不可改）
- [x] **强制删除分支**：确认框带勾选框，勾选后用 `-D` 强删，默认仍 `-d` 安全删
- [x] **diff 一键展/收单按钮**：两个按钮合成一个切换按钮，图标随状态变化

## M5 功能拓展、升级（已完成）

- [x] **设置-用户信息（第一栏）**：名字/邮箱写入当前仓库 git config（`git_get_user`/`git_config_user`），保存时一并写回
- [x] **分支前缀多前缀**：个性化里逗号分隔多个前缀（feat/, fix/…），创建分支弹窗下拉选择
- [x] **分支区模糊搜索**：侧栏输入框改为搜索框，实时过滤本地+远程树（子串匹配，祖先节点自动保留）
- [x] **创建分支独立按钮**：工具栏 GitBranchPlus → 弹窗：前缀下拉 + 分支名，基于当前分支创建并自动切换
- [x] **刷新动画**：刷新中图标 animate-spin，防重复点击
- [x] **选项卡 LRU 缓存**：最多缓存 5 个仓库的 status/log/branches 快照，切回秒开；关闭选项卡即逐出；命中后后台静默刷新轻量数据
- [x] **右键丢弃更改**：未暂存文件右键菜单——已跟踪「丢弃更改」（checkout --）/未跟踪「删除文件」，均二次确认
- [x] **历史区右键菜单**：复制 hash / checkout 该提交（detached HEAD 确认）/ revert（反向提交确认）
- [x] **窗口标题徽标**：有未推送提交时窗口标题显示 `(↑N) git-zen`

## M6 AI 拓展（已完成）

架构前提（先做，后面的功能全靠它）：

### M6.1 基础设施（已完成）

- [x] **tauri-plugin-http 接入**：capabilities 放行 `https://**` 与 `http://**`（兼容本地 Ollama）；
      业务逻辑全部在前端 TS，Rust 零新增 HTTP 代码
- [x] **设置「AI」页**（Bot 图标）：Base URL / API Key / Model 三字段；配了 Key 时保存前用 `/models`
      轻量请求验通，失败不关弹窗展示原因；页面上注明 Key 仅存本机 localStorage
- [x] **通用封装 `src/ai.ts`**：aiComplete() 30s 超时竞态、HTTP 状态→人话映射（401/403/404/429/5xx）、
      clipForAI() 截断 16KB 并标注原文长度；提示词集中在 AI_PROMPTS，功能只许走这里

### M6.2 功能点（已完成，全部只读：仅消费 diff/log 文本，不写工作区）

- [x] **AI 生成提交信息**：提交框右上 Sparkles 按钮（无暂存时禁用），暂存区多文件合并 diff →
      ≤50 字主题+要点正文写入输入框供人工修改后再提交；错误显示在提交框下方
- [x] **AI 解释变更**：DiffViewer 头部 Bot 按钮，对当前文件/commit patch 输出中文要点解读，
      结果面板内嵌弹窗底部（35% 高度上限独立滚动）
- [x] **AI Review 未推送提交**：ahead > 0 时工具栏出现「Review N」按钮；后端新命令
      `git_diff_unpushed`（`@{upstream}..HEAD`）；报告弹窗按【问题/风险/建议】分节输出
- [x] **未配置引导**：三个入口在 aiConfigured() 为 false 时点击 → 自动打开设置并定位到 AI 页

### M6.3 功能优化（已完成）

- [x] **提交信息语言配置**：设置 AI 页新增「提交语言」下拉（中文/English），存 `aiCommitLang`；
      提示词 `AI_PROMPTS.commitMessage.system(lang)` 按语言注入
- [x] **AI 功能开关**：设置 AI 页「功能开关」下拉（开启/关闭，默认开启），存 `aiEnabled`；
      关闭时三个 AI 入口分别提示/引导设置，`aiConfigured()` 一并校验
- [-] ~~流式打字机输出~~（已取消：部分模型/中转不支持 SSE 流式，非流式兼容性最好；
  ai_stream/aiStream 及 reqwest、futures-util 依赖已全部回退，Spinner 非流式方案保留）

## M7 功能拓展

### 7.1（已完成）

- [x] **提交并推送**：提交按钮右侧附加推送按钮（ArrowUpFromLine），一次完成提交+推送；
      复用 git_push 的无上游自动 `-u`，填写了 AI 信息或手写均可
- [x] **远程链接配置 + 打开**：设置-个性化新增「仓库网页链接」（按仓库存 localStorage，留空自动从
      origin URL 推断——支持 git@host:path 与 https 两种形式）；状态栏新增「远程」按钮
      （ExternalLink 图标），点击经 tauri-plugin-opener 在浏览器打开
- [x] **历史视图范围切换**：搜索框左侧下拉「当前分支 / 所有分支」（ui/Select）；
      后端 git_log 加 `--all` 参数；切换走遮罩两段式重载，滚动分页同样生效
- [x] **单文件历史视图**：文件右键 →「查看文件历史」（暂存区/未暂存都支持，rename 取新路径）；
      后端 git_log 加 `--follow -- path`；历史区顶部显示文件 chip（显示短名 + × 退出），
      与视图范围切换互斥（文件历史固定当前分支）

## 需求池（无需关注，后面排期）

### Git 核心补全

- tag 管理：列表/创建/删除/推送 tag（目前完全没有 tag 支持，是最明显的缺口）
- stash 列表/弹出/恢复
- amend 上次提交 / 撤销上次提交（reset --soft HEAD~1）
- blame 视图：每行最后修改者/提交
- 右键「加入 .gitignore」（自动追加对应行）
- cherry-pick（右键菜单，交互简单化只做单提交）
- 多 remote 支持：push/pull 时可选 remote（目前写死 origin）

### 效率

- hunk 级暂存：diff 弹窗内按块 stage/unstage
- 文件列表目录树/平铺双视图切换
- 任意两个提交的 range diff 对比（历史区选中两个节点）
- 提交信息模板（读仓库 .gitmessage 或自定义）
- 拖拽文件到暂存区批量 stage
- 历史区按文件路径过滤

### AI 拓展（衔接 M6）

- AI 生成 Release Notes：选 tag/提交范围，汇总成 changelog
- AI 从 CONTRIBUTING.md/仓库文档学习提交规范（不只靠近期提交推断）
- AI 总结单文件的演进历史（这个文件为什么长成这样）
- AI 冲突解读：冲突时展示双方意图说明（只读，不做交互式解决）

### 体验

- 提交统计热力图（每周提交量，设置-个人页）
- i18n 英文界面
- 自定义主题色（目前固定紫罗兰）
- worktree 支持（列出/切换工作树）
- GitHub/GitLab 集成：PR 列表、CI 状态徽标（需 token，较重）
