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

## M10 精细暂存与历史检视（规划）

> 主题：写路径补上"按块暂存"这块最大缺口，读路径补上提交对比与范围汇总；
> M10 做完核心 Git 功能基本齐平，之后里程碑可转向打磨与发布。

### 10.1 精细暂存与提交流

- [ ] **hunk 级暂存**：DiffViewer 每个 hunk 块头加 暂存/取消暂存 按钮。方案：前端按 hunk
      切分 patch 并重组（lib/patch.ts 已有 hunk 头解析基础），后端新命令经 stdin 喂
      `git apply --cached`（取消暂存加 `-R`）。风险点：行计数错误（必要时 `--recount`）、
      新增/删除/rename 文件的 hunk、二进制文件直接拒绝；需为 apply 链路补自检用例
- [ ] **右键「加入 .gitignore」**：未跟踪文件右键追加路径（已存在该行则跳过；复用 git_write_file）
- [ ] **cherry-pick 单提交**：历史右键 → 拣选该提交到当前分支（复用 revert 的确认套路；
      空提交/冲突走 humanize 兜底）
- [ ] **提交信息模板**：设置-个性化可配模板，提交框为空时预填；仓库有 .gitmessage 则优先读它

### 10.2 历史检视与 AI（衔接 M9 标签）

- [ ] **任意两提交对比（range diff）**：历史行右键「以此为基准」→ 顶部 chip 标注基准
      （同文件历史 chip 交互）→ 再右键另一提交「与基准对比」，DiffViewer 新增 range 模式
      （后端 `git_diff_range(A, B)`，文件列表 + patch）
- [ ] **历史区按文件路径过滤**：git_log 已支持 file_path 参数，前端补入口
      （文件右键「在历史区按此文件过滤」），与搜索框并存、chip 可退出
- [ ] **AI 生成 Release Notes**：选 tag 范围（默认 上一个 tag..HEAD）→ 汇总提交清单 →
      Markdown 报告（复用 AI Review 弹窗骨架 + 保存到本地），M9 的标签列表直接可用
- [ ] **AI 冲突解读**（可选）：冲突文件 diff 弹窗加按钮，读 combined diff 输出双方改动意图
      说明（只读，不做交互式解决）

## M11 打磨与手感：UI/UX 细节、交互与体验（规划）

> 主题：不加新能力，把已有的每个面打磨到"顺手"。三个方向：交互手感（键盘/反馈/性能）、
> 阅读细节（diff 与复制）、主题与可及性。可与 M10 交错排期。

### 11.1 交互手感

- [ ] **浮层键盘统一**：Esc 关闭一切浮层（右键菜单/stash 菜单/分组下拉/切换器，确认框=取消）；
      确认框打开时焦点落在「取消」键（危险操作的安全默认）、Enter 触发主按钮；
      右键菜单项支持 ↑↓ 移动 + 回车执行
- [ ] **成功反馈 toast**：错误仍是确认框，但成功操作给右下角自动消失的轻提示
      （"已提交 a1b2c3d" / "已暂存 3 个文件"），新 ui/Toast 组件，App.run() 统一触发
- [ ] **历史区虚拟滚动**：滚动加载无上限，几千提交时 DOM 行数与徽标爆炸；按 26px 固定行高
      做窗口化渲染（可视区 ± 缓冲行），泳道 SVG 同步偏移。体验债里唯一的性能项
- [ ] **侧栏折叠**：左/右栏一键收起（把手双击 + 快捷键），小屏幕给历史区让位，状态持久化
- [ ] **空态首屏 + 拖拽打开仓库**：无仓库时展示欢迎页（打开按钮 + 最近仓库列表）；
      文件夹拖进窗口任意位置即打开该仓库（Tauri drag-drop），空态页提示此操作
- [ ] **分支快速切换器（Ctrl+B）**：复用 Ctrl+P 弹窗骨架（模糊过滤 + ↑↓ + 回车），分支跳转不再依赖侧栏

### 11.2 阅读细节

- [ ] **diff 行号栏**：patch.ts 已跟踪 oldLine/newLine，行左侧显示 旧/新 双列行号，便于引用与定位
- [ ] **diff 折行开关**：7.4 改为永远折行后加一个 折行/不折行 切换按钮，localStorage 记忆
- [ ] **导出 patch**：DiffViewer 头部「导出 .patch」，当前 commit/文件 diff 存盘（复用保存对话框）
- [ ] **右键复制补齐**：历史行右键加 复制提交信息/作者/短 hash；文件行右键加 复制路径
- [ ] **最近提交信息复用**：提交框为空时出最近 5 条提交信息下拉一键填入（与 M10 模板互补）
- [ ] **搜索命中高亮**：历史区过滤时高亮命中关键词（过滤逻辑已有，只差渲染）

### 11.3 主题与可及性

- [ ] **跟随系统深浅色**：外观设置加「自动」档，监听 prefers-color-scheme 切换深/浅 token
- [ ] **可及性走查**：图标按钮补 aria-label（现有 Tooltip 仅 hover 可见）；统一 :focus-visible
      焦点环；prefers-reduced-motion 时降动画；浅色主题下 muted 文本对比度抽查
- [ ] **微动效**：弹窗/菜单入场 150ms fade+scale（尊重 reduced-motion），保持克制不上头

### 观察后推迟

- diff 语法高亮（需选型 + 大 diff 性能风险，单独立项评估）、图片 diff 预览、
  选项卡脏标记（需后台轮询全部仓库）、UI 整体缩放

## M12 工作流：多步 git 操作串联（规划）

> 主题：把「切分支→拉取→合并→推送→切回」这类固定套路做成可配置的一键执行。
> 定位是**最小工作流引擎**：固定原语 + 顺序执行 + 出错即停，不做条件/循环/变量系统。

### 12.1 引擎

- [ ] **步骤原语（6 种，全部复用现有命令，零新增 Rust）**：切换分支（固定名 / `$起始分支` /
      运行时输入）、拉取、提交推送（可选 AI 生成信息，复用 M6 提示词；工作区干净时**跳过**）、
      合并（固定名 / `$起始分支`）、新建分支（运行时输入 + 可选前缀）、切回起始分支
- [ ] **执行语义**：进入时自动记录当前分支为 `$起始分支`；任何一步失败**立即中止**——
      「有冲突停留」由此天然实现（merge 冲突即失败，停在目标分支待解决，后续推送/切回不执行）；
      结尾统一 refresh；执行期间走 busy 锁其它操作
- [ ] **执行 UI**：选工作流 → 确认框展示解析后的步骤（`$起始分支` 显示实际分支名、
      运行时输入当场填）→ 进度弹窗逐步打勾、失败标红停住（错误走 humanize）；
      确认框提示「工作区有未提交改动时，pull/merge 可能失败或被带入提交」
- [ ] **存储**：`gz.workflows`（localStorage），全局可用；工作流 = 名称 + 有序步骤数组

### 12.2 配置与模板

- [ ] **工作流管理弹窗**：仿分组管理——新建/重命名/删除工作流，步骤增删 + 上下排序，参数行内编辑
- [ ] **内置模板**：首次启动种子两个普通工作流（可编辑可删）：
      ①「起新分支」：切 master → 拉取 → 新建分支（运行时输入）
      ②「发布到 dev」：提交推送（AI）→ 切 release/dev → 合并 $起始分支 → 推送 → 切回起始分支
- [ ] **入口**：工具栏按钮下拉列出全部工作流，一键执行

### 明确不做

- 条件分支 / 循环 / 变量赋值。引擎级唯一的"智能"就是出错即停与干净时跳过提交，
  再往前一步就是自动化平台，违背「轻」定位

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
