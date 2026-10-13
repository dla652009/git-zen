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

### 7.2（已完成）

- [x] **DiffViewer 双栏改造**：参考 FileHistoryModal 布局——左侧文件列表（短名 + 行数，
      title 显示全路径），右侧只渲染选中文件的 diff；折叠/展开功能随单栏布局退役（双栏下无意义）；
      AI 解释/保存到本地/空态全部保留
- [x] **选中复制 + 行级改动人提示**：diff 内容区加 `select-text`（反制全局 select-none）支持选中复制；
      每行 hover 原生 title 显示改动人信息（commit 模式「修改：作者 · 日期」，工作区文件「路径（模式）」）。
      曾试容器委托组件（LineTooltips），因关闭不可靠/定位错位/复杂度过高回退原生 title——
      diff 逐行场景浏览器原生延迟展示恰好最稳。真正的逐行归属在需求池 blame 视图承接

### 7.3（已完成）

- [x] **DiffViewer 左侧文件列表显示完整路径**：不再只显示短名，列表加宽 w-56→w-64，
      超长截断 + title 兜底全路径
- [x] **合并冲突 diff 展示**：unmerged 文件（UU/AA/DD/AU/UA/DU/UD）双击强制走工作区 diff
      （`git diff --cached` 对未合并路径只输出 `* Unmerged path`，不可用）；lib/patch.ts 解析
      combined diff（`diff --cc` 双状态列，分别是相对 ours/theirs 的增删），冲突标记行
      （<<<<<<< / ======= / >>>>>>>）琥珀色高亮；弹窗头部显示「合并冲突」Badge，
      文件状态图标改 GitMerge；新增 patch.test.ts 自检

### 7.4（已完成）

- [x] **DiffViewer 文件列表可拖宽**：与主界面侧栏同款把手，160-560px，localStorage 持久化（gz.diffListW）
- [x] **diff 长行折行**：原 `whitespace-pre` 不折行，且 flex 布局里 break-word 不影响 min-content
      宽度导致长行溢出容器；改 `whitespace-pre-wrap` + `[overflow-wrap:anywhere]`
      （DiffViewer 与 FileHistoryModal 同步修复）
- [x] **逐行归属（blame）**：新后端命令 `git_blame`（解析 `--porcelain`，sha 的 author/author-time
      元信息只在首块出现、按 sha 缓存）；patch.ts 跟踪 unified hunk 行号（PatchLine.oldLine/newLine）；
      DiffViewer 行级 tip 规则——commit 模式：+ 行归属当前提交作者，context/- 行 blame 父版本
      （`<hash>^`，按旧文件行号查）；文件模式：+ 行=工作区未提交，context 行 blame 工作区。
      按选中的文件段懒加载，失败静默降级为通用提示；合并冲突（combined）无行号跟踪，保持通用提示。
      已知取舍：已暂存 diff 的 context 行按工作区 blame 近似（worktree 有二次编辑时行号可能偏移）

## M8 多仓库效率（已完成）

- [x] **仓库快速切换器（Ctrl+P）**：居中弹窗，按仓库名/路径模糊过滤，最近使用（MRU）排序、
      名称前缀匹配优先；↑↓ 选择、回车打开、Esc 关闭、hover 同步选中；分组名以 Badge 显示；
      busy 时静默忽略（与点选项卡一致）。MRU 记录在 activate/closeTab 维护，启动以当前仓库为种子
- [x] **选项卡分组（书签文件夹模式）**：分组以文件夹常驻标签栏（Folder 图标 + 下载箭头，
      激活仓库在组内时高亮），组内仓库**不占选项卡**，点击文件夹弹出成员下拉（当前仓库带高亮点，
      底部「管理分组…」入口）；管理按钮固定在标签栏最右侧，弹窗内增删改查——新建/重命名/删除分组
      （重名拦截）、展开分组编辑成员（×移出、+添加，展示来源分组），删除分组不关仓库、成员回到标签栏；
      一个仓库只属一个分组。标签栏顺序（文件夹+仓库）持久化于 gz.barOrder，由 syncBar 自愈同步
      （修剪关闭仓库/已删分组条目、追加新仓库/新分组）；barOrder 与渲染 1:1，拖拽排序始终可用；
      Ctrl+Tab / Ctrl+1..9 只在可见仓库间循环/定位（文件夹不占号）；关闭当前仓库优先落到第一个可见
      仓库，全收进分组时落到任一剩余仓库；「关闭其他」不关闭分组内仓库
- [x] **拖拽归组**：仓库 tab 拖到文件夹上松手 = 收进该分组。拖动期间 document.elementFromPoint
      命中检测 + 文件夹高亮（sortable ghost 加 pointer-events:none 防拦截命中）。
      坑：Sortable 默认把文件夹当排序目标，悬停时挤开文件夹、onEnd 里再归组会与库内 model 同步
      竞争夺写坏数组（模板读 item.kind 报 null）→ 修复：onMove 禁止仓库排进文件夹位置
      （悬停不再腾位，落子走库内复位分支），addMember 推迟到 nextTick，syncBar 过滤脏值兜底
- [x] **切换缓存容量可配置**：设置-个性化「性能 → 切换缓存」滑条（1-30，默认 5），
      存 settings.repoCacheSize；调小立即淘汰最旧快照，缓存仍为纯内存不落盘

## M9 实用补全（已完成）

- [x] **提交统计热力图**：设置-用户信息页新增 GitHub 风格 12 个月热力图（列=周、行=周一..周日，
      五档配色随主题 primary，月份/星期标尺 + 图例，超宽横向滚动）。后端 `git_commit_stats`
      （`git log --since --pretty=%ad --date=short`，Rust 侧按天聚合，只回有提交的日期）；
      前端 CommitHeatmap 组件（原生 title tooltip——数百格子不包 Tooltip 组件的既有惯例）；
      空仓库/失败有兜底文案，无仓库时整节隐藏；设置弹窗加宽加高 640x440→880x520 完整容纳
      热力图（窗口过小时 max-w/max-h 回退 95vw/95vh，热力图横向滚动、内容区滚动）；
      **只统计当前提交者**：git_commit_stats 加 author 参数（`--author`，传用户信息页的
      user.email），邮箱边输入边防抖重载（300ms + seq 守卫过期请求）；未配置邮箱时显示
      引导文案（不过滤出全量数据会误导）
- [x] **放弃未推送的提交**：头部 ↑N 徽标可点击（tooltip 说明），确认框明示后果——丢弃 N 个
      未推送提交、重置回上游分支；工作区有未提交改动时一并提示数量（reset --hard 会连带丢弃）；
      注明界面不可撤销、终端 reflog 可找回。后端 `git_reset_unpushed`（`-c alias.reset=reset`
      防别名劫持）；成功后清掉该分支的 AI Review 缓存（未推送的提交已变）
- [x] **amend 追加到上次提交**：提交按钮同一行右侧两个 icon（省纵向空间，Tooltip 说明）——
      「追加到上次提交」：暂存区改动并入上次提交，提交框有内容则同时更新提交信息、
      留空则 `--no-edit` 保留原信息（后端 `git_amend`，`-c alias.commit=commit` 防劫持）。
      确认框按「有上游且 ahead==0 = 上次提交已推送」给出改写历史警告；成功后清空提交框草稿
- [x] **撤销上次提交**：同行的撤销 icon，`reset --soft HEAD~1`（后端
      `git_undo_commit`），全部改动完整回到暂存区、工作区不动；根提交（仅 1 个提交）禁用，
      已推送同样在确认框警告；确认框一并提示「重新推送需强制推送」
- [x] **stash 暂存架**：未暂存区头 Archive 按钮开下拉菜单（懒加载列表）——收纳当前改动
      （可选备注 + 「包含未跟踪文件」勾选，`stash push [-u] -m`）、点记录恢复（apply 保留记录）、
      hover 恢复并删除（pop）/仅删除记录（drop，确认框）；收纳弹窗与菜单在切仓库时自动收起。
      后端 `git_stash_list/push/apply/drop` 四命令（list 用 `%gd%H%ar%gs` 0x1f 分隔解析，
      push 对 git 退出码 0 的 "No local changes to save" 转成明确中文报错）
- [x] **tag 管理（最小集）**：侧栏新增「标签」组（默认收起，行 hover 推送/删除、组头 + 新建），
      历史行右键「新建标签…」可对任意提交打 tag，新建弹窗支持附注信息（填了 = `-a -m` 附注标签，
      留空 = 轻量标签）；后端 `git_tag_list/create/delete/push` 四命令（list 走 for-each-ref，
      `*objectname` 解引用附注标签到真实提交；**for-each-ref 不支持 %x1f 转义，用 tab 分隔**）。
      历史区 refs 徽标剥掉 `tag: ` 前缀并用 muted 配色区分分支；标签列表随 refresh/activate
      一并刷新并纳入 LRU 快照；确认框提示删本地标签不影响远程同名标签
- [x] **从远程克隆仓库**：工具栏「打开」改为弹窗两入口——本地目录（原流程）/ 从远程克隆；
      克隆表单 = 远程 URL + 「选择位置…」目录选择器 + 目录名（从 URL 末段自动推断、可改），
      「克隆并打开」走后端 `git_clone`（cwd 用目标父目录，`--` 防地址被当选项，认证走系统凭据、
      终端密码提示保持禁用即快速失败），成功后自动加入选项卡并打开；错误就地显示在表单内
      （humanize 补「目录已存在」「无法读取远程」「仓库不存在」三条映射），克隆中按钮带 Spinner

## M10 精细暂存与历史检视（已完成）

> 主题：补齐 git 核心操作的零散缺口（.gitignore / cherry-pick / 文件过滤）与 AI 衍生能力。
> M10 做完核心 Git 功能基本齐平，之后里程碑可转向打磨与发布。

### 10.1 精细暂存与提交流

- [-] ~~hunk 级暂存~~（已实现后按用户反馈移除：实际用不到。git_apply_hunks/run_stdin 及
  DiffViewer hunk 按钮已回退；按 hunk 暂存的需求暂时在终端 git add -p 承接）
- [x] **右键「加入 .gitignore」**：未跟踪文件右键 → 追加路径到仓库根 .gitignore（整行已存在
      跳过、文件不存在则创建，后端 `git_ignore_add`），无确认框，成功后刷新文件即从未暂存区消失
- [x] **cherry-pick 单提交**：历史右键「Cherry-pick 到当前分支」（确认框提示空拣选/冲突会失败
      停留）；后端 `git_cherry_pick`（防别名劫持）；humanize 补「改动已在当前分支（空拣选）」映射
- [-] ~~提交信息模板~~（已实现后按用户反馈移除：实际用不到。git_read_commit_template、
  设置字段与预填逻辑已回退）

### 10.2 历史检视与 AI

- [-] ~~任意两提交对比（range diff）~~（已实现后按用户反馈移除：实际用不到。
  git_diff_range、DiffViewer range 模式与对比基准 chip 已回退）
- [x] **历史区按文件路径过滤**：git_log 的 file_path 参数早已支持，文件右键「在历史区按此文件
      过滤」→ 工具栏出现文件 chip（× 退出），watch 两段式重载与视图范围切换共用；
      与搜索框并存、切仓库自动清除
- [x] **AI 生成 Release Notes**：侧栏标签组 Sparkles 入口 → 弹窗选范围（默认「最近标签」=
      `describe --tags --abbrev=0`，可选任意 tag，无 tag 可选全部提交）→ 后端 `git_commits_range`
      取提交清单 → `AI_PROMPTS.releaseNotes` 按新功能/修复/优化分组输出 Markdown，
      复用 Review 弹窗骨架 + 保存到本地；打开即自动生成，可换范围重新生成
- [x] **AI 冲突解读**：冲突文件的 diff 弹窗 Bot 按钮改用 `AI_PROMPTS.conflictExplain`——
      解读 combined diff 双状态列、双方意图与解决方向（只读）

## M11 打磨与手感：UI/UX 细节、交互与体验（已完成）

> 主题：不加新能力，把已有的每个面打磨到"顺手"。四个方向：布局排版、交互手感（键盘/反馈/性能）、
> 阅读细节（diff 与复制）、主题与可及性（含文案精简）。可与 M10 交错排期。

### 11.0 布局与排版走查（已完成）

- [x] **头部按钮重排**：按频率与语义分组、加分隔线——打开（低频，靠左）；右侧 新建分支 / Pull /
      Push / Review ｜ 刷新 / 设置。↑N 徽标点击改为小下拉（AI Review / 放弃未推送提交），
      撤掉独立 Review 按钮：徽标回归"指示 + 汇总入口"，破坏动作藏进菜单且仍有确认框兜底
- [x] **左侧栏交互习惯**：分支双击切换改**单击切换**（对齐 VS Code / GitHub Desktop 惯例，
      当前分支点击无动作）；组头 hover 图标（标签组的 AI/+）迁入右键菜单
- [x] **文件/历史行打开方式**：双击改**单击**打开 diff（hover 图标已 stop 传播不冲突；
      误开成本低 Esc 即关），全应用统一为「单击看内容、右键看操作」
- [x] **三栏与状态栏走查**：左右栏拖宽把手/最小宽度、空态文案位置与措辞、状态栏信息密度、
      提交区复查（M9 已收纳过一轮）

### 11.1 交互手感（已完成）

- [x] **浮层键盘统一**：Esc 关闭一切浮层（右键菜单/stash 菜单/分组下拉/切换器，确认框=取消）；
      确认框打开时焦点落在「取消」键（危险操作的安全默认），Enter 天然触发取消——
      实现取「焦点即取消」而非计划的「Enter 触发主按钮」，破坏操作多一道手动的坎；
      右键菜单项支持 ↑↓ 移动 + 回车执行（ui/ContextMenu 内建，capture 层拦 Esc）
- [x] **共享右键菜单组件 + 左栏操作迁移**：抽 ui/ContextMenu（替换 tab/提交/文件/分组/stash 五处
      手搓 fixed 定位菜单，统一 Esc/键盘/外点关闭，顺带就是浮层键盘统一项的载体）；
      本地分支右键 = 重命名 / 合并到当前 / 合并当前到该 / 删除 / 强制删除 / 复制名称，
      远程分支 = 删除 / 复制名称，标签 = 推送 / 删除 / 复制名称；强制删除做独立菜单项
      （确认框写明后果），替代现有勾选框交互。行主操作（切换分支）保留单击不进菜单；
      **确认框数量不减**——菜单只是换入口，危险操作照旧确认
- [x] **成功反馈 toast**：错误仍是确认框，但成功操作给右下角自动消失的轻提示
      （"已提交 a1b2c3d" / "已暂存 3 个文件"），新 ui/Toast 组件，App.run() 统一触发
- [x] **历史区虚拟滚动**：滚动加载无上限，几千提交时 DOM 行数与徽标爆炸；按 26px 固定行高
      做窗口化渲染（可视区 ± 缓冲行），泳道 SVG 同步偏移。体验债里唯一的性能项
- [x] **侧栏折叠**：左/右栏一键收起（把手双击 + 快捷键），小屏幕给历史区让位，状态持久化
- [x] **空态首屏 + 拖拽打开仓库**：无仓库时展示欢迎页（打开按钮 + 最近仓库列表）；
      文件夹拖进窗口任意位置即打开该仓库（Tauri drag-drop），空态页提示此操作
- [x] **分支快速切换器（Ctrl+B）**：复用 Ctrl+P 弹窗骨架（模糊过滤 + ↑↓ + 回车），分支跳转不再依赖侧栏

### 11.2 阅读细节（已完成）

- [x] **diff 行号栏**：patch.ts 已跟踪 oldLine/newLine，行左侧显示 旧/新 双列行号，便于引用与定位
- [x] **diff 折行开关**：7.4 改为永远折行后加一个 折行/不折行 切换按钮，localStorage 记忆
- [x] **导出 patch**：DiffViewer 头部「导出 .patch」，当前 commit/文件 diff 存盘（复用保存对话框）
- [x] **右键复制补齐**：历史行右键加 复制提交信息/作者/短 hash；文件行右键加 复制路径
- [x] **最近提交信息复用**：提交框为空时出最近 5 条提交信息下拉一键填入
- [x] **搜索命中高亮**：历史区过滤时高亮命中关键词（过滤逻辑已有，只差渲染）

### 11.3 主题与可及性（已完成）

- [x] **跟随系统深浅色**：核查发现外观设置早已内置「跟随系统」档（resolvedTheme + prefers-color-scheme 监听），无需改动
- [x] **可及性走查**：头部/选项卡/提交区/diff 弹窗/Stash 图标按钮补 aria-label；:focus-visible
      全局焦点环（Button 去掉 outline-none）；prefers-reduced-motion 全局降动画；浅色主题对比度
      随状态色 token 校准
- [x] **微动效**：弹窗/菜单入场 150ms fade+scale（尊重 reduced-motion），保持克制不上头
- [x] **轻交互反馈**：控件反馈态统一——按钮按压轻微缩放/变暗、行 hover 底色与开关/滑条
      100~150ms 平滑过渡、拖拽 ghost 半透明样式；一律尊重 prefers-reduced-motion
- [x] **收敛过艳的颜色**：状态色与 diff 配色降饱和——emerald/sky/rose/violet/amber-400 系
      在深色底上偏刺眼，收敛为主题 token 并降一档明度与饱和度；浅色主题同步校准，
      语义色对底色对比度过 WCAG AA（4.5:1）

### 11.4 文案精简（已完成）

- [x] **规范**：tooltip/hover 一行、动词开头、只说「动作 + 结果」不说实现细节与后果
      （后果留给确认框讲）；空态必须给出下一步动作；同一动作全应用只用一种说法
- [x] **全量走查**：逐条过 tooltip / 确认框 / 空态 / 右键菜单 / humanize 文案。
      典型改法：拉取远程更新并合并到当前分支 →「拉取并合并远程更新」；
      推送本地提交到远程（无上游时自动建立跟踪）→「推送（无上游自动建立跟踪）」；
      拉取远程并刷新仓库状态（含 fetch，离线时仅刷新本地）→「刷新（含 fetch，离线仅本地）」；
      打开仓库（本地目录 / 从远程克隆）→「打开仓库」；
      分组「x」· N 个仓库 · 点击展开，拖仓库到此处可收进分组 →「x · N 个仓库（拖仓库进来可归组）」


### 11.5 交互复查修复（已完成）

> M11 落地后自查一轮，修掉误触与事件层隐患；清单与用户逐条确认过。

- [x] **IME 组合输入误触**：全局快捷键与 ContextMenu 键盘处理补 `isComposing` 守卫——
      中文输入按 Esc 取候选词不再关弹窗丢输入，按 Enter 确认候选词不再误执行菜单项
- [x] **Esc 通道收敛**：删掉 DiffViewer/SettingsModal 自挂的 window Esc 监听（后者从未清理过），
      diffState/showSettings/fileHistoryModal 收进 closeTopOverlay 分层链——一次 Esc 只关一层，
      FileHistoryModal 此前完全没有 Esc 处理也一并修上
- [x] **分支单击切换加护栏**：工作区有未提交改动时先确认（明示改动数与"git 拒绝时留在原分支"），
      干净时直接切；确认路径不嵌套 run（doSwitch 只做乐观更新+checkout，刷新交给外层 run）
- [x] **文件/历史行回退"单击选中、双击打开"**：单击高亮零代价（bg-primary/10），双击同一行才开
      diff 弹窗；HistoryGraph 与 ChangesPanel 同策略
- [x] **Stash 行单击不再直接 apply**：恢复动作收敛到 hover 图标——RotateCcw=恢复保留记录、
      ArchiveRestore=pop、Trash2=删除记录；行改为非点击态
- [x] **AI 生成/最近信息填入不再静默覆盖草稿**：草稿非空时结果挂起，行内条「覆盖 / 保留原内容」
- [x] **关闭选项卡 toast 提示**（根治方案"关闭保留最近列表"成本高，后议）
- [x] **克隆进行中 Esc 不关表单**（后台完成会自动切仓库，弹窗承担进度与取消入口）
- [x] **右键菜单一步换目标**：遮罩 contextmenu 关闭后按原坐标 elementFromPoint 重派发，
      不再需要先点空白关菜单
- [x] **菜单宽度收敛**（长 subject max-w-[440px] + truncate）；折叠展开箭头补 dblclick.stop

### 观察后推迟

- diff 语法高亮（需选型 + 大 diff 性能风险，单独立项评估）、图片 diff 预览、
  选项卡脏标记（需后台轮询全部仓库）、UI 整体缩放

## M12 工作流：多步 git 操作串联（已完成）

> 主题：把「切分支→拉取→合并→推送→切回」这类固定套路做成可配置的一键执行。
> 定位是**最小工作流引擎**：固定原语 + 顺序执行 + 出错即停，不做条件/循环/变量系统。

### 12.1 引擎（已完成）

- [x] **步骤原语（7 种，全部复用现有命令，零新增 Rust）**：切换分支（固定名 / `$起始分支` /
      运行时输入）、拉取、提交推送（可选 AI 生成信息，复用 M6 提示词；**有改动自动全部暂存**
      （git add . 免解析 rename 路径），干净时**跳过**）、**推送**（规划 6 种不够——发布流程
      在 merge 后需要独立推送，增补第 7 种）、合并（固定名 / `$起始分支`）、新建分支（运行时
      输入 + 可选前缀）、切回起始分支。语义决策：切换目标不存在=报错中止（要建分支就放新建
      原语）；AI 生成失败=步骤中止可重跑，不用固定文本兜底
- [x] **执行语义**：进入时自动记录当前分支为 `$起始分支`；任何一步失败**立即中止**——
      「有冲突停留」由此天然实现（merge 冲突即失败，停在目标分支待解决，后续推送/切回不执行）；
      结尾统一 refresh；执行期间走 busy 锁其它操作
- [x] **执行 UI**：选工作流 → 确认框展示解析后的步骤（`$起始分支` 显示实际分支名、
      运行时输入当场填）→ 进度弹窗逐步打勾、失败标红停住（错误走 humanize）；
      确认框提示「工作区有未提交改动时，pull/merge 可能失败或被带入提交」
- [x] **存储**：`gz.workflows`（localStorage），全局可用；工作流 = 名称 + 有序步骤数组

### 12.2 配置与模板（已完成）

- [x] **工作流管理（设置页）**：设置新增「工作流」导航页承载配置面（首版独立弹窗交互太挤，按反馈重做）——
      宽布局步骤卡（编号徽标 + 类型标签 + 参数行内编辑 + 大号 上移/下移/删除），添加步骤卡随类型出参数，
      删除为两段确认（点一次变「确认删除？」）；工作流状态抽 workflowStore（reactive+持久化，
      App 执行面与设置页管理面共享）；工具栏按钮从 Push 旁挪到工具组（divider 后、刷新前）
- [x] **内置模板**：首次启动种子两个普通工作流（可编辑可删）：
      ①「起新分支」：切 master → 拉取 → 新建分支（运行时输入）
      ②「发布到 dev」：提交推送（AI）→ 切 release/dev → 合并 $起始分支 → 推送 → 切回起始分支
- [x] **入口**：工具栏按钮下拉列出全部工作流，一键执行

### 明确不做

- 条件分支 / 循环 / 变量赋值。引擎级唯一的"智能"就是出错即停与干净时跳过提交，
  再往前一步就是自动化平台，违背「轻」定位

## M13 全面审查修复（已完成）

> 由 4 个并行审查单元（后端 / 前端架构 / UI 交互 / 功能缺口）产出报告，见 `docs/review/`。
> 本轮只做「最小改动、收益最大」的第一、二批；结构性改造留待单独排期。

### 13.1 正确性与安全（后端）

- [x] `run()` 失败时回退 stdout —— 修掉高频失败路径弹**空白错误框**的问题
- [x] 位置参数统一隔离：`check_positional()` + `--end-of-options`，覆盖 checkout / branch / tag / merge / push / config
      （push 场景 `--` 无效，已单独处理）
- [x] `git_push_force`：`--force-with-lease`，让 amend / 撤销提交的历史改写能闭环
- [x] `git_merge_abort`：冲突态的退出通道
- [x] `git_init`：新项目初始化入口
- [x] `capabilities/default.json` 补 `core:window:allow-set-title` —— 窗口标题此前因 ACL 未授权静默失效

### 13.2 并发与状态（前端）

- [x] `refresh()` / `loadMorePage()` / `execStep()` 补**仓库身份守卫**（快照 + 赋值前比对）
- [x] 工作流执行期锁定仓库，中途切走即中止，避免在错误仓库上 commit/push

### 13.3 交互与可及性

- [x] 组件级 Enter/Esc 统一 IME 守卫（`imeGuard()`，加在 `@keydown` 上）
- [x] 单文件暂存/取消暂存改**常显按钮 + aria-label**（原 hover-only 裸 svg 让键盘与触屏用户无法操作）
- [x] 重命名文件的 path 收敛（暂存/丢弃/diff 三入口此前集体失效）
- [x] 打开仓库先校验再落库（不再产生永久坏选项卡）
- [x] 冲突态横幅 + 「放弃合并」出口；冲突文案不再指向终端
- [x] 图表行补原生 `title`

### 13.4 弹层可及性（19 个模态弹层）

- [x] 新增 `src/lib/focusTrap.ts` 的 `v-trap` 指令（`src/main.ts` 全局注册）：
      打开时移入焦点、Tab/Shift+Tab 在弹层内循环、关闭时焦点归位；**刻意不管 Esc**
      （全局 `closeTopOverlay()` 已有分层关闭链，重复处理会打架）
- [x] 19 个模态弹层补 `v-trap` + `role="dialog"` + `aria-modal="true"` + 可访问名
      （17 个用 `aria-labelledby` 引可见标题、2 个切换器无标题元素故用 `aria-label`）
- [x] 4 个非模态层（`folderDd` / `dragOver` / `stashMenuOpen` / `ContextMenu` 覆盖层）**刻意排除**：
      它们是透明点击层，加陷阱会抢焦点、破坏「点外部关闭」
- [x] `FOCUSABLE_SELECTOR` 补 `summary` —— `<summary>` 默认可聚焦但没有 `tabindex` 属性，
      漏了它会让错误框的「详细信息」键盘不可达（陷阱内只剩「确认」一个元素时 Tab 被永远拦在它身上）

### 13.5 浮层优先级表（拆 App.vue 的第一步）

- [x] 抽出 `src/lib/overlays.ts`：`overlayOrder`（19 层优先级，全项目唯一一处定义）
      + `closeTop(layers)`；`OverlayName` 是由该表推出的联合类型
- [x] `App.vue` 的 `closeTopOverlay()` 从 18 行手写 if 链改为
      `Record<OverlayName, OverlayLayer>` 表 + 一行 `closeTop(overlayLayers)`。
      新增浮层忘了登记会 `error TS2741: Property '…' is missing`，而不是静默失效
- [x] 新增 `src/lib/overlays.test.ts` 自检（已加进 `tsconfig.json` 的 exclude 与 AGENTS.md）：
      逐层单独打开关掉的是它自己、多层同开取最上层、`locked`（克隆进行中）挡住下层不穿透、
      连按 Esc 逐层关到 null、优先级表无重名
- [x] 负向验证：临时删掉 `diff` 一层 → `vue-tsc` 报 `TS2741`（exit=2）；补回 → exit=0
- [ ] `App.vue` 其余部分（仓库选项卡与分组、仓库/分支切换器、AI Review、Release Notes、
      工作流执行）仍是单文件，继续拆需单独排期

### 13.6 清完「已确认但没修」的欠账（第三批）

审查报告里除了第一批（安全/正确性）与第二批（断头路），还留了一批「当时判定该修、但没排上」的项。
这一节把它们逐条清掉。**审查报告本身（`docs/review/*.md`）保持原样不改写**，只在这里记录修复。

#### 并发与状态

- [x] 切分支失败后界面停在假分支名（`docs/ANALYSIS.md` 真 Bug #1）：`doSwitch` 快照 + catch 回滚 + `throw`
- [x] 历史范围切换与仓库切换竞态（真 Bug #2）：watcher 内快照 `path`，赋值前比对；
      `finally` 里只在 `repo.value === path` 时碰遮罩
- [x] `refresh()` 无互斥：加 `refreshSeq`，只有最新一次刷新允许写状态与 LRU 缓存
- [x] `fetchLog()` 隐式读 `repo.value`（上面两条的共同根因）：改 `fetchLog(skip, path = repo.value)`，调用点全部显式传
- [x] 工作流 `push` 步骤用流程开始时的分支名（本轮新发现）：改现读 `api.status(path)`

#### 健壮性

- [x] 9 处裸 `JSON.parse(localStorage…)` → 新增 `src/lib/safeJson.ts`（+ 自检）；
      `gz.repos` / `gz.groups` / `gz.barOrder` 三处在 setup 期间同步执行，坏数据原本直接白屏
- [x] `settings.ts` 用 `as Settings` 让编译器闭嘴 → 改逐字段类型校验 + 缺省回退，不再读取已废弃历史字段
- [x] 全仓无崩溃兜底 → `src/main.ts` 挂 `errorHandler` + `unhandledrejection` + `error`（只记录，不重复弹 toast）
- [x] AI 请求无法取消、超时只是标志位 → `AbortController` 真取消 + 真超时，
      导出 `abortAi()` / `isAbortError()`；UI 侧用一个 watch 收口（任一 AI 弹层关闭即取消）

#### 交互与可及性

- [x] 关闭仓库选项卡 / 关闭其他：补确认框（判据是「会丢一条持久化记录、重开要再选一次目录」）
- [x] 删除工作流：两段式按钮 → 真确认浮层（初始焦点给「取消」，Esc 自捕获）
- [x] stash pop：补确认浮层
- [x] 侧栏拖宽上限不看窗口宽度 → `maxLeftW()` / `maxRightW()` 按 `innerWidth` 动态收敛；
      `clampSidebars()` 只改 ref 不写回 localStorage（保留用户在大窗口下的偏好）
- [x] 窗口 `focus` / `keydown` 监听从不清理 → `onUnmounted` 里移除并 `endResize()`
- [x] 模板里直接调 `remoteNodes()` → 改 `remoteNodeMap` computed
- [x] `syncBar()` 两次全量 `JSON.stringify` → 改 `sameBar()` 逐项比较
- [x] 对中文无意义的 `uppercase tracking-wider` 全部清掉（对中文不产生任何视觉差异）
- [x] WCAG 2.1 AA 对比度：修 `--muted-foreground` / `--primary` / `--destructive` / `--diff-add-text`
      （light / github-light / catppuccin-latte / one-dark / catppuccin-mocha），
      Badge 半透明底改实心 token 对，泳道连线 `--graph-line` token 化，
      新增 `--btn-danger-*` 让危险按钮与 `--destructive` 文字色解耦，泳道色改用亮度带
- [x] 新增 `scripts/check-contrast.mjs`：改主题时可回归（负向验证过）
- [ ] 「移除分组成员」**刻意不加确认**（决策，非缺陷）：同面板下方一次点击即可加回，
      属完全可逆操作；「危险操作到处确认会让确认失去意义」。只改了 `title` 让可逆性可见

#### 工程化

- [x] `gitApi.ts` ↔ `git.rs` 人工镜像零防护 → 新增 `scripts/check-contract.mjs`
      （双向注册检查 / 同步 command 检查 / struct ↔ interface 字段比对，负向验证 6 组）
- [x] `vite.config.js` 没有 `build` 段 → 补 `manualChunks` 拆包 + `build.target`（按 Tauri 平台注入的
      `TAURI_ENV_PLATFORM` 选 `chrome105` / `safari13`）+ `sourcemap` 说明；
      顺带 `server.watch.ignored: ["**/src-tauri/**"]`
- [x] `package.json` 加 `check:contract` 与 `verify`（契约检查 + 类型检查 + 5 个自检串起来）
- [x] 前端自检脚本从 1 个涨到 5 个，Rust 单测 **12** 个（`cargo test --lib`）

#### 收尾复核（又抓到四条）

把 `docs/review/*.md` 的 P1/P2 再逐条重读核对时发现的漏项，根因见 `docs/BUGS.md` 同名小节：

- [x] `git_diff_untracked` 的「上限」全在读完之后才生效（`std::fs::read` 整个读进内存）→
      抽 `read_preview()`，只读前 1 MiB 再判二进制/截行；新增单测 `read_preview_caps_bytes_read`
- [x] `git_get_user` 用 `unwrap_or_default()` 把「没配过」和「真失败」一起吞成空串 →
      改 `git config --default ""` + `?` 传播真错误；前端 `SettingsModal.vue` 的静默 catch 补日志；
      新增单测 `git_get_user_distinguishes_unset_from_failure`
- [x] 4 处 `await saveDialog(...)` 写在 `try` 外面（App.vue ×2 / DiffViewer.vue ×2）→
      全部移进 `try`，插件失败不再是一次「点了保存但没反应」的静默 rejection
- [x] `humanize()` 对 non-fast-forward 只给「先 Pull 再 Push」→ 改为按情形分岔并指向
      应用内的「强制推送（--force-with-lease）」，不再与 amend 互相打架
- [x] 全局快捷键不判焦点（`onGlobalKeydown` 只挡 `isComposing`）→ 加 `typing` 判断，
      输入框内只放行 `Esc` / `Ctrl+Tab` / 关掉自己正待着的切换器；`preventDefault()` 挪到确认有事可做之后
- [x] 危险确认框与错误框共用「确认」二字 → `ConfirmState.okText`，11 处危险框把后果写在按钮上，
      错误框改「知道了」
- [x] 分页无任何指示（`loadingMore` / `canLoadMore` 不进模板）→ `HistoryGraph` 增加两个 props，
      列表末尾渲染「正在加载更多…」/「已到底部」
- [x] 6 处组件内联错误直出英文 stderr → `humanize` 搬到 `src/lib/errors.ts`（加一行版 `humanizeMsg`），
      组件统一走它
- [x] 四套反馈机制无明确分工 → 写进 `docs/NOTES.md`「反馈机制的分工」，并把「不加确认也算对」的判据
      （可逆性）落成规则

### 13.7 交互收口（R3 的最后一段）

- [x] AI 输出里的链接会把 WebView 导航走（桌面应用没有后退键，点一下就被困住）→
      `ui/Md.vue` 拦截 `<a>` 点击改走系统浏览器 `openUrl`，只放行 http(s)
- [x] 关掉最后一个仓库时只清了 3 个状态 → 对齐 `activate()` 的完整重置清单
      （tags / canLoadMore / fileHistoryModal / historyFilePath / remoteRaw / remoteLink）
- [x] 错误框只有「确认」一个按钮，网络抖动失败也只能关窗重来 → `run()` 失败时挂 `retryFn`，
      错误框出现「重试」；`showError` 直调处不挂（校验类错误重试没意义）
- [x] `clipForAI()` 按 UTF-16 硬切 16KB，会切在 hunk 中间、可能劈开代理对 →
      退到最近的换行（整段无换行才硬切），并避免切在代理对中间
- [x] `humanize()` 兜底分支不剥 `Error: ` 前缀（用户会看到「Error: 磁盘已满」）→ 统一剥掉

### 明确不做（本轮）

- 拆 `App.vue` 的其余部分（同上）：纯重构、零功能收益，需单独排期并配套回归；
  本轮只先拆了风险最集中的浮层优先级（见 13.5）
- git 调用超时、弹层 `role="dialog"` + focus trap：已完成（见 13.1 / 13.4）
- 弹窗宽度 10 档、字号 8 档的统一尺度：已完成（见 14.1 / 14.4）
- `bg-black/50` 遮罩（19 处）不随主题：已完成，改走 `--scrim`（见 14.1）
- 骨架屏：现有「整块半透明遮罩 + Spinner」在历史区尺寸不变、内容跳变的抖动确实存在，
  但换骨架屏要重做 `HistoryGraph` 的空态分支，收益与风险不成比例；已用分页指示条
  缓解「不知道在不在加载」的核心问题
- `tauri.conf.json` 的 `csp: null`：收紧 CSP 会牵动 Vite dev 的 HMR（ws 与内联脚本），
  而唯一渲染外部文本的 `ui/Md.vue` 已经 `html: false` + `markdown-it` 默认 `validateLink`
  挡掉 `javascript:`/`data:`，本轮改为「链接一律走系统浏览器」后风险面已收窄；
  真要上 CSP 必须能把 `pnpm tauri dev` 跑起来验证，属于需要人工回归的改动
- `-c alias.X=X` 别名劫持防护覆盖不全：实测 `git config alias.log '!echo HIJACKED'` 后
  `git log` 仍走内置实现（`GIT_TRACE=1` 确认），**别名无法影子内置命令**，
  现有覆盖属纵深防御而非必需，不补齐
- `git_commits_range` 的 `from`/`to` 只拦 `-` 开头：rev 语法（`^`、`~`、`..`）是合法用法，
  真正的边界由 git 自己校验，加白名单反而会拦住正常用法
- `humanize()` 漏覆盖 git.rs 自造的中文错误（如「非法的 commit hash」）：那本来就已经是人话，
  再映射一层没有收益
- 4 个 `busy` 守卫缺口（`activate()` / `closeTab()` 可绕过）：刻意保持「仓库切换永远可响应」，
  安全性由 `refresh()` / `loadMorePage()` / 历史 watcher 的**仓库身份守卫 + seq 守卫**保证
  ——守卫加在「写入时」，而不是「入口处」，这样慢操作不会让界面失去响应

## M14 视觉系统：令牌化与现代化

起因：审查发现配色与尺度是「一处一处写出来的」，没有系统 —— 8 档字号（其中 111 处是任意值 px）、
7 档圆角、3 档阴影（24 个弹窗共用一个 `shadow-xl`，等于没有层次）、只有 3 层表面
（浮层与常驻面板同色，弹窗「浮」不起来）、遮罩写死 `bg-black/50` 不随主题、弹窗宽度 8 个写死 px。

**根本问题不是「颜色不好看」，是没有层次。** 一个界面的高级感来自「谁在谁上面」，不是来自色相。

### 14.1 令牌分层（`src/style.css`）

- [x] 表面四层：`--background`（画布）< `--muted`（内嵌区）< `--card`（面板）< `--elevated`（浮层）
- [x] 交互态不占层次：`--hover` / `--active` / `--primary-soft` / `--border-soft` 由 `color-mix()`
      从前景色派生（此前 hover 借用 `bg-muted`，而 `--muted` 是「内嵌区」语义，深色主题下与画布几乎同色）
- [x] 遮罩 `--scrim` 按主题给（深色 62% 黑、浅色 34% 深蓝），不再写死
- [x] 阴影四档 `--elev-1..4`，每档「紧贴投影 + 环境投影」两级并带顶部 1px 高光；
      浅色主题单独把关键色/环境色换成正蓝黑低透明度，否则白底上的黑影会发脏
- [x] 字号 6 档**全部改 rem**，跟随「设置 → 字号」缩放 ——
      此前一半文字用 px 硬写，改字号时只有另一半会变
- [x] 圆角 4 档（3 / 5 / 7 / 10px），按语义分配而非按大小分配
- [x] 时长 3 档 `--dur-fast/base/slow` + `--ease-out` / `--ease-spring` 两条曲线
- [x] 弹窗宽度 4 档 `w-dlg-sm/md/lg/xl`（rem）
- [x] 等宽字体栈自带中文回退（`ui/Md.vue` 原来硬编码 `Consolas`，中文代码块会掉字体）

### 14.2 工具类

- [x] `surface`（弹窗）/ `surface-menu`（菜单、气泡）/ `surface-panel`（卡片）三档浮层表面，
      底 + 描边 + 投影 + 高光一次给全，调用处不再重复写四个类
- [x] `pop-in` 入场动效（`@starting-style`，纯 CSS 无需 JS）；`slide-in-right`；`duration-fast/base/slow`

### 14.3 只往上加一层，不动既有配色

第一版为了让「四层」成立，把各主题画布整体压暗了一档，并把 Catppuccin Mocha / One Dark 的
`background` 与 `card` 对调 —— 用户第一反应是「没之前的背景色好看了」。

改回的做法：**各主题的 `--background` / `--card` / `--muted` 一律保持原值，只新增一个比画布亮的
`--elevated`**。用户唯一看到的差别就是「弹窗比背景亮」。
`--muted` 也不参与层次排名（深色主题里它在卡片之上，浅色主题里在画布之下，两种都对）。

硬约束只剩一条：`--elevated` 必须比它盖住的画布亮。
验收方式：改后与改前的 `style.css` 逐主题逐令牌 diff，**结果里只应出现新增的令牌名，
不能有任何一个既有令牌的值发生变化**。

### 14.4 应用到界面

- [x] 19 个弹窗：`surface rounded-lg p-5` + `pop-in`，宽度归到 4 档，
      标题统一 `text-base font-semibold` + `mb-3`，底部按钮区统一 `mt-5`
- [x] 窗口镶边（header / 选项卡栏 / footer）改 `bg-card`，工作区回落画布色 ——
      这样「激活页签跟内容同色」的连体页签才成立（此前激活页签是 `bg-card` 而背后是画布色，接不上）
- [x] 顶部显示「父目录 › 仓库名」而不是整条路径（完整路径留给 tooltip）
- [x] 空态重做：首屏欢迎页与「这个仓库还没有提交」都配了图标底盘与次级说明
- [x] 刷新 / 加载遮罩加 `backdrop-blur-[2px]`
- [x] `App.vue` 46 处任意值字号清零；`hover:bg-muted` → `hover:bg-hover`；
      所有过渡统一到 `duration-fast`，并给 14 处「有 hover 但颜色硬切」的元素补上过渡

### 14.5 应用到基础组件（`src/components/`）

- [x] 浮层表面：菜单/下拉/气泡 → `surface-menu rounded-sm` + `pop-in`；常驻面板保持 `bg-card` 不加阴影
- [x] 交互态：`hover:bg-muted` → `hover:bg-hover`；`bg-primary/10` → `bg-primary-soft`；补 `transition-colors duration-fast`
- [x] 任意值字号清零；圆角按语义归到 4 档（裸 `rounded` 清零）
- [x] 等宽只给「机器输出」（diff 正文 / hash / 行号 / key chip）——
      **文件路径是 UI 文本，不上等宽**：等宽字形平均字宽比比例字体宽约 19%，
      而文件列表是最窄的版面，上等宽只会少显示三四个字符
- [x] 小标题统一为「比正文更小、更重」：`text-2xs font-semibold tracking-wide text-muted-foreground`
- [x] 弹窗宽度三处漏网补齐（`ChangesPanel` ×2、`SettingsModal` ×1）；
      `SettingsModal` 的 `w-[880px]` 按判断保留（双栏设置页是唯一宽版布局，不为它单开一档）
- [x] `--elev-2` 落地到「整块可点的卡片」的悬停抬起（`hover:shadow-elev-2`）

### 14.6 复核中修掉的三处自埋缺陷

- [x] 弹窗宽度令牌原本写成 rem：默认字号 13px 下 22rem 只有 286px，比原来的 360px 窄两成。
      改回 px（384/448/520/640）——**字号档位是「正文变多大」，弹窗宽度是「一块版面有多宽」，两件事**
- [x] `@theme inline` 尾部残留 `--radius-md: var(--radius)`，把新定义的 `--radius-md: 7px`
      覆盖成 4.875px，整个圆角中档失效。删掉旧 token 与其在 `ui/Md.vue` 的唯一引用
- [x] 「打开仓库」弹窗三张卡片挤在 `grid-cols-2` 里，第三个成孤儿 → 横跨整行（`col-span-2`）；
      顺带把按钮内的 `<div>` 改成 `<span class="block">`（`<button>` 只允许短语内容）
- [x] `ui/Badge.vue` 的 `rounded-xs` 回退 `rounded-full`：**徽标是一颗「药丸」，形状本身就在
      表达「这是个标记」；圆角档位管的是矩形（按钮/卡片/弹窗），不辖制这种独立形状**
- [x] 顶部工具栏统一按钮高度（文字按钮去掉 `size="sm"`）：图标按钮 h-8 而文字按钮 h-7，
      同一行里差 4px，对齐看得很明显

## 需求池（无需关注，后面排期）

### Git 核心补全

- blame 独立视图（DiffViewer 内逐行 blame 已覆盖主场景，独立视图边际价值待评估）
- 多 remote 支持：push/pull 时可选 remote（目前写死 origin）
- tag 补全：重命名、推送全部（--tags）、删除远程同名标签（push origin :refs/tags/）

### 效率

- 文件列表目录树/平铺双视图切换
- 拖拽文件到暂存区批量 stage（「全部暂存」已覆盖主场景，优先级低）

### AI 拓展（衔接 M6）

- AI 从 CONTRIBUTING.md/仓库文档学习提交规范（不只靠近期提交推断）
- AI 总结单文件的演进历史（这个文件为什么长成这样）

### 体验

- i18n 英文界面
- 自定义主题色（目前固定紫罗兰）
- worktree 支持（列出/切换工作树）
- GitHub/GitLab 集成：PR 列表、CI 状态徽标（需 token，较重）
- [-] ~~多窗口展示~~（明确不做：状态全是模块级单例——repoCache/activateSeq/settings watcher，
  多窗口=第二份 JS 上下文需 store 重构，且违背「轻」定位；多仓库跳转由 Ctrl+P 切换器 +
  选项卡分组承接，见 M8）

### 实现落点（M12）

- 数据层 `src/workflow.ts`（纯函数可测）：原语类型 / describeStep / flowNeedsInput / 种子模板；
  自检 `node --experimental-strip-types src/workflow.test.ts`（describe 标签、输入判定、种子深拷贝）
- 执行器在 App.vue：起始分支执行时记录，进度弹窗逐步 pending/running/done/skip/fail，
  失败标红停住并保留弹窗（merge 冲突正好停在目标分支处理），成功自动关 + toast
- 管理弹窗：工作流增删重命名；步骤增删 / 上下移 / 参数行内编辑（引用三态、信息来源、前缀）
- 工具栏 Workflow 图标下拉一键执行；Esc 分层链纳入三个工作流浮层
