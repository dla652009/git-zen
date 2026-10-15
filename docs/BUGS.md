# git-zen Bug 记录

> 缺陷和优化点的记录，任务完成后修复这里的内容。

## 刷新 / 状态识别

- [x] 刷新识别不到「远程有新提交可拉取」（↓N 徽标不出现）→ **根因双重**：① refresh()（F5/刷新按钮）
      不 fetch——ahead/behind 是 `git status -b` 对本地 remote-tracking refs 算的，refs 只在
      fetch/pull 时更新，不 fetch 刷新多少遍都是旧 refs；② fetchOnce()（启动/切仓库的后台 fetch）
      完成后只重拉 branches 不重拉 status——refs 已更新但头部徽标/窗口标题还停在 fetch 前的值。
      修复：刷新按钮与 F5 走 `refresh({fetch:true})`（fetch 失败静默，离线仍刷本地；顺带补了
      busy 拦截防并发刷新）；fetchOnce 完成后 status+branches 一并重拉并同步 LRU 缓存快照，
      加 path 守卫丢弃切换期间的过期结果。操作后刷新（run()）不带 fetch——pull/pull 已更新 refs

- [x] 合并冲突时不弹提示、界面也不更新，要手动点刷新才看到冲突文件（用户反馈）→ **根因**：`src/App.vue`
      的 `run()` 只在 `try` 里 `await refresh()`，失败直接进 `catch` 只弹错误框。而 **merge 冲突恰恰是
      「命令报错但状态已改变」**：`git merge` 因冲突 exit 1 → `git_merge` 返回 Err → 走 catch → 不刷新
      → `status` 停在合并前的快照上。冲突横幅（`ChangesPanel.vue` 的 `conflictFiles`，由
      `props.status.files` 驱动）和冲突文件因此全都不出现——**界面明明有这个功能，只是永远拿不到数据**。
      修复两处：① `run()` 的 catch 里也 `await refresh()`（对所有失败操作生效，不只 merge）；② `askMerge`
      把「冲突」与「真失败」分开——冲突是 git 有意停在中途等用户解决，属合并的正常一步，不该弹红色错误框，
      改为刷新后 toast 提示冲突文件数，只有确实没有未合并文件时才当失败抛出。后端前提由 `src-tauri/src/git.rs`
      的 `merge_conflict_fails_but_state_changes` 钉住（断言命令返回 Err 的同时 status 里已出现冲突文件）。

- [x] 工作流执行期间点背景关掉进度弹窗，整个流程会半路崩掉且没有任何提示 → **根因**：进度弹窗用
      `@click.self="wfRun = null"` 关闭，而执行循环每一步都要读 `wfRun.value.states[i]`。弹窗一关
      `wfRun.value` 就是 null，而 `const st = wfRun.value.states[i]!` 这句在 `try` **之外**（内层 try
      只包住 `execStep` 那一次调用），于是抛出的 TypeError 直接穿透出去：`busy` 在 `finally` 里复位、
      剩下的步骤一步都不跑，用户只看到弹窗消失。修复：把「执行状态」与「弹窗是否可见」拆成两个 ref ——
      `wfRun`（状态，执行期间不清空）与 `wfRunOpen`（可见性）。关闭只是 `wfRunOpen = false`，
      失败时若弹窗已被关掉会重新打开，让用户看见失败原因。
      **教训**：拿同一个 ref 既当「数据」又当「这个弹窗开着吗」，就等于让关闭按钮具备清空业务状态的能力。
- [x] 同一个崩溃还有第二条路：执行期间按 **Esc**。上面那条只覆盖了「点背景」，而 Esc 走的是
      `src/lib/overlays.ts` 那张分层关闭表 —— `overlayLayers.flowRun` 当时写的是
      `close: () => (wfRun.value = null)`，绕过了带 `busy` 守卫的 `closeWfRun()`，
      于是 `wfRun.value.states[i]` 的老问题原样复发。两层一起修：
      ①`flowRun.close` 改调 `closeWfRun()`（与「点背景」同一条路：执行期间只把弹窗藏起来）；
      ②`executeFlow` 的循环不再读 `wfRun.value` —— 进循环前先 `const run = wfRun.value`
      再一律用 `run`，界面无论怎么关弹窗都动不了这个局部引用；失败重开时把 `run` 挂回去。
      **教训**：一个状态有两条关闭路径时，把守卫加在其中一条上等于没加。`overlayLayers`
      这种回调表最容易「补了 A 忘了 B」，所以关闭逻辑只该有一份实现，表里只做转发。

## T0 阻塞问题

- [x] 刚进入/切换选项卡加载仓库概率卡死、窗口无响应 → **根因**：Tauri v2 同步 command 在主线程执行，
      所有 git CLI 阻塞调用（log/status 大仓库慢、push/pull/fetch 网络慢）都会冻住 WebView → 假死。
      修复：全部 22 个命令改 `async fn` + `spawn_blocking` 下放线程池，主线程只管 UI
- [x] 操作期间容易卡死 → 同根因同修复；push/pull 网络操作不再阻塞 UI，只影响各自按钮的 Spinner
- [x] Command ai_stream not found → 根因：ai_stream 写进了 git.rs 但**漏注册** lib.rs 的 invoke_handler。已补注册
- [x] `Command git_show_file not found` → 又是**漏注册 lib.rs**（第三次：ai_stream/git_remote_url/git_show_file）。
      已补注册。以后 git.rs 新增命令后必须立即对账 lib.rs invoke_handler（NOTES.md 教训条目已存在）

## Diff 功能

- [x] Merge 的 diff 不展示 → `git show -m --first-parent`，对比第一父提交（已实测验证）
- [x] 冲突文件打开 diff 弹窗显示「没有文件变更」→ 根因：冲突中 `git diff` 输出 combined diff
      （`diff --cc <路径>`，无 a/ 前缀），切段只认 `diff --git a/` 导致全部丢行；且已暂存列表入口走
      `--cached`，git 对未合并路径只回 `* Unmerged path`（均已临时仓库实测）。修复：lib/patch.ts 支持
      combined 双状态列解析 + 冲突标记行琥珀高亮；ChangesPanel 对 unmerged（UU/AA/DD 等）强制
      cached=false 并传 conflict 标记；弹窗头部显示「合并冲突」徽标
- [x] DiffViewer 左侧文件列表只显示短名 → 改为显示完整路径（超长截断，title 兜底），列表加宽
- [x] 文件列表宽度固定不可调 → 新增拖宽把手（与主界面侧栏同款），160-560px，localStorage 持久化
- [x] diff 超长行文字超出容器 → 根因双重：`whitespace-pre` 从不折行 + flex 布局中 break-word 不影响
      min-content 宽度（子项拒绝收缩直接溢出）。改 `whitespace-pre-wrap [overflow-wrap:anywhere]`
      （anywhere 才参与 min-content 计算），DiffViewer 与 FileHistoryModal 同步修复
- [x] 行级「改动人」只是整个 commit 的作者，不是逐行归属 → 实装真 blame：后端新命令 `git_blame`
      （--porcelain 解析，含 sha 元信息缓存）；patch.ts 在 unified hunk 内跟踪 oldLine/newLine；
      DiffViewer 行级 tip——+ 行归属本次变更，context/- 行显示该行真正的最后修改人/时间/hash
      （commit 模式查父版本，文件模式查工作区），懒加载、失败静默降级
- [x] 右侧文件改点击展示 diff 弹窗；暂存/取消暂存改为 hover 出图标按钮（+ 暂存 / Undo2 取消），与点击不冲突
- [x] 弹窗固定 80vh 高度，加载中不再跳动
- [x] 多文件 patch 按文件分段，点文件头展开/收起

## 设置功能

- [x] 需要保存/取消按钮 → 草稿编辑模式：改动先进 draft，点「保存」才写回；取消直接关弹窗不生效
- [x] 保存后，变更立刻生效 → settings 的 watcher 现在同时调 persist() + applySettings()（之前只持久化没应用，是个真 bug）
- [x] 设置 UI 太丑 → codex 风格左右布局：左侧分类导航（外观/个性化），右侧内容区，底部固定操作条
- [x] 去除 diff 样式设置 → 已移除；diff 颜色回归各主题内置配色，applySettings 会清掉旧版本写入的覆盖
- [x] 分支前缀多个 → 个性化改为 tag 式编辑器（回车/逗号添加、×删除），存储仍是逗号分隔串；创建分支弹窗下拉自动同步；下拉换自研 ui/Select 组件（吃 token 样式）
- [x] 功能开关置顶 + Switch 组件 + 关闭时隐藏按钮 → 新增 ui/Switch.vue（shadcn 风格滑块）；
      AI 页顶部独立卡片放开关，关闭时下方配置项变灰禁用；
      关闭时隐藏 Sparkles/Bot/Review 三个入口（不再是点击后提示）
- [x] 新增远程 tab → 设置导航新增「远程」（Globe 图标）；「仓库网页链接」从个性化移入并更名
      「远程仓库路径」，默认填充 origin URL（与 origin 相同保存时视为自动推断）。
      首次打开输入框为空 → console 显示 `Command git_remote_url not found`：
      **命令漏注册 lib.rs**（与 ai_stream 同款失误，cargo check 不报错），已补注册

- [x] 设置页的快捷键清单**与实现对不上、也不全** → 根因不是「写错了」，是**这份清单是手写文案，
      没有任何东西把它和代码绑在一起**：改键位的人不会想起来同步它，而它看起来又一直是对的。
      实测查出的两处**不符**：「双击分支」（分支早已改成**单击**切换，当前分支不响应）、
      「双击历史行」（现在是单击选中、**再点一次**才打开，`onRowClick` 的两段式）；
      五处**缺失**：`Ctrl+B` 分支切换器、`Ctrl+Shift+L/R` 折叠左右侧栏、`Ctrl+F` 打开 diff 搜索、
      `Enter`/`Shift+Enter` 跳命中、`Alt+↑/↓` 移动工作流步骤。
      已按「全局 / 提交 / diff 阅读 / 工作流与设置 / 鼠标」五组重写（`SHORTCUT_GROUPS`），
      并补上一句「光标在输入框里时全局键让给输入法」—— 那条不是常识，是 `onGlobalKeydown` 里真实存在的分支

## 分支区（左侧栏）

- [x] 双击切换两级远程分支报 `pathspec 'dev' did not match` → **根因：前缀被剥两次**。
      远程树构建（remoteNodes）把 `origin/release/dev` 拷贝成剥掉远程前缀的展示名
      `release/dev` 用于树形嵌套；而 switchBranch/askMerge/askDelete 假设拿到的还是全名，
      `targetName()` 又剥一次第一段 → `release/dev` 变成 `dev`。一级分支（origin/main →
      main）碰巧不受影响，两级以上全部中招（合并远程分支、删远程分支同样错）。
      修复：树拷贝附 `originName` 保留完整引用名（BNode.branch 类型放宽）——checkout 直接用
      已剥名的 name（DWIM 自动建同名本地跟踪分支，完整名反而会 detached HEAD），
      合并/删除用 fullName（originName）拆远程名与分支名
- [x] 本地/origin 一级栏 → GitBranch / Cloud 图标 + font-medium 强调 + 数量徽标
- [x] 诡异空分支 → 根因：无 `/` 前缀或 `*/HEAD` 符号引用被剥前缀后变空串。已过滤 `*/HEAD` 和无效名，不再产生空项
- [x] 远程分支栏默认收起 → 远程组改记「展开」集合（openRemotes），默认全部收起，本地保持默认展开
- [x] 本地分支 ahead/behind 展示 → 后端 `%(upstream:track)` 解析，分支名旁 ↑N（蓝）↓M（黄）小字。首版解析器没剥 `[ahead 1]` 的方括号导致永远为 0，已实测修复
- [x] 合并到该分支后不切回 → 流程改为：切到目标 → merge 当前 → 留在目标分支；确认框文案同步
- [x] 远程分支删除 → 远程叶子 hover 出删除图标（仅删除，无重命名/合并），确认后 `push origin --delete <分支>`；新后端命令 `git_push_delete`。本地分支的删/改名/合并操作不变
- [x] 本地/远程折叠状态联动 → 根因：两侧共用 collapsedGroups 集合且折叠键相同——本地 dla/xxx
      与 origin/dla/xxx 剥前缀后键都是 "dla"。修复：buildNodes 加 keyPrefix 命名空间
      （local: / remote:origin:），两侧折叠状态完全独立
- [x] 删除远程分支功能入口缺失 → 功能代码早就有（BranchTree 远程叶子 Trash2 + askDelete + git_push_delete
      均已注册），但 **App.vue 的远程 BranchTree 忘传 manage prop** → 图标区不渲染 → 用户看不到入口。
      已补传 manage；刷新后展开 origin 组，hover 远程分支即出删除图标（走确认框直接作用于远程）

## commit 历史区（中间）

- [x] hover 展示详细 commit 信息（多行 tooltip：主题/hash/作者/时间/refs）
- [x] 双击展开 git diff 弹窗（单击不再触发）
- [x] 搜索时泳道图不展示/截断 → 重做连线算法：布局始终基于全量提交（泳道列稳定），过滤只决定哪些行可见；
      被过滤掉的中间提交由「沿 parent 链找最近可见祖先」跨过去连边，拓扑不断裂、不截断

## 暂存提交区（右侧栏）

- [x] 重设计：分节标题带计数徽标、文件行加图标圆角卡片式 hover、「全部暂存」收进未暂存节头、提交区固定底部卡片化
- [x] 文件名如果是汉字，展示的是一堆编码 → 根因：git 默认 core.quotepath=true 把非 ASCII 路径转八进制转义。run() 统一 prepend `-c core.quotepath=false`，所有命令一次修复
- [x] 暂存文件名是汉字的文件报 pathspec 错误 → 同根因：回传的是转义串匹配不到真实文件，随 quotepath 修复；status 解析另加剥首尾引号兑底
- [x] 新增文件 diff 弹窗“暂无diff” → 新增 `git_diff_untracked` 命令：读文件内容合成全新增预览（二进制提示不可预览，上限 2000 行）
- [x] 状态 Badge 图标化 → A新增(绿) FilePlus / M修改(蓝) FilePen / D删除(红) FileMinus / R重命名(紫) FileSymlink / 未跟踪·冲突(黄) FileQuestion，tooltip 带中文说明
- [x] 单击改双击打开 diff 弹窗；hover 操作图标保持单击
- [x] 已暂存节头新增「全部取消暂存」按钮
- [x] 提交是提交，而不是提交并推送 → 真相：代码从未 push，是「分支无远程上游时没有任何提示」造成误导。两步修复：① Push 按钮遇无上游自动 `push -u origin <分支>`；② 状态栏对无上游分支常驻「当前分支尚未推送到远程」徽标。上一条的 `-c alias.commit=commit` 别名防御保留（无害且防劫持）
- [x] 未暂存区整目录折叠成 src/ 且 diff 报 os error 5 → 根因：git status 默认把未跟踪目录折叠成 `src/`（路径是目录当然读不了）。status 加 `-uall` 展开为逐个文件；已暂存区正常是因为暂存文件本来就是逐个列的
- [x] 提交/Pull/Push loading → run() 记录当前操作名，Pull/Push 按钮图标切换成 Spinner；提交按钮显示「处理中...」+ Spinner
- [x] 提交草稿按仓库隔离 → message 改为 Map<repo, 草稿> 的 computed 读写，切选项卡互不串；提交成功清空对应仓库的草稿。
      **后续回归**：普通 Map 在 computed setter 里写入不触发响应式失效，导致 AI 生成结果不渲染（无报错无结果）。
      已改 reactive(new Map()) 修复——computed setter 背后的存储必须响应式
- [x] 提交并推送改勾选框 → 移除推送小按钮，提交区新增「提交后推送到远程」勾选框（默认不勾）；
      一切由提交按钮控制：勾选=提交并推送（无上游自动 -u），未勾选=仅提交
- [x] 文件历史改双栏弹窗报 `--follow requires exactly one pathspec` → **根因：参数顺序**——
      `--pretty=format:...` 被放在了 `-- path` 之后，git 把它当第二个 pathspec。已把 --pretty 挪到 `--` 之前，
      并在临时仓库实测（含重命名追踪 --follow 正常）。已移除"进入历史区文件模式"（顶栏 chip 已删），右键改为「查看文件变更历史」：
      新组件 FileHistoryModal 双栏展示——左侧该文件提交列表（--follow 追踪重命名），
      右侧选中提交中此文件的 +/- 着色 diff（新后端命令 git_show_file）；
      解析逻辑抽为 lib/patch.ts 供 DiffViewer 体系复用

- [x] 已暂存 / 未暂存的**计数徽标从未生效** → 根因：`<Badge>` 在模板里用了两次，但 `<script setup>` 里
      **从来没有 import 它** —— Vue 对没解析出来的标签不报错，直接当普通元素渲染，
      `variant="default"` / `variant="danger"` 整个属性被忽略，两个计数一直只是**没有任何样式的纯文本**。
      `vue-tsc` 不报（未知标签按原生元素处理是合法用法），`vite build` 也不报 —— 唯一的症状是「少了一层颜色」。
      改目录树时顺手发现（`docs/NOTES.md` 有同名条目）

- [x] **删除 stash 记录后暂存架列表不更新**（用户反馈）→ 不只显示旧数据：`stash@{n}` 里的 n 是**位置**
      不是身份，删掉一条之后其余记录整体前移，旧列表上的「恢复」会落到**另一条记录**上。
      根因：暂存架列表是 `ChangesPanel` 打开菜单时才懒加载的，不在 `App.vue run()` 统一重拉的
      status/log/branches 里，删完没有任何东西通知它重取；而菜单项都是 `@click.stop`，
      请求删除时浮层有意不关（方便连续删），于是旧列表就一直留在屏幕上。
      修法：`App.vue` 加 `stashRev` 自增值，`askStashDrop` 删成功后自增，经 `:stash-rev` 传给面板；
      面板把拉取抽成 `loadStash()`，菜单开着时收到通知就重取。

## 仓库选项卡

- [x] 样式太丑了 → 重做成浏览器标签风：活动页 bg-card+上圆角+底边融合，状态色点指示，hover 才出关闭 X
- [x] 拖动排序功能不生效 → dataTransfer 补丁仍不可靠，最终放弃 HTML5 DnD，改纯鼠标事件实时换位（见 NOTES.md），稳定可用
- [x] 右键菜单 → 重命名… / 关闭 / 关闭其他，点击空白处关闭
- [x] 重命名改为弹窗输入（含完整路径提示，回车确定 Esc 取消）
- [x] 切换选项卡延迟 → activate() 现在立即盖 loading 遮罩 + nextTick 让 UI 先绘制再拉数据，不再感觉卡死；closeTab 同样处理
- [x] 鼠标拖动不了 → sortablejs 默认走原生 HTML5 DnD，在本 WebView2 里同样失效；加 `force-fallback: true` 让它用自带鼠标模拟拖拽，正常了
- [x] 快捷键切换卡顿 → activate() 改两段式刷新：先拉 status/branches 让侧栏状态栏立即就位并清空历史区，再拉 log 渲染泳道图（期间有 Spinner 遮罩），体感不再卡死
- [x] 选项卡切换先切再加载 → activate() 开头立即清空旧仓库的 status/commits/branchList，UI 马上呈现新选项卡的空态+loading 遮罩，不再残留上一个仓库的数据
- [x] 点击没反应/慢响应 → activate() 引入 seq token：每次切换递增序号，过期请求的结果直接丢弃不再覆盖 UI；
      旧数据立即清空所以点击必有反馈
- [x] 防抖频繁切选项卡 → 同上 token 机制即防抖：快速连续切换只有最后一次生效，中间的 CLI 调用结果被丢弃
- [x] 操作进行中点选项卡没反应 → **根因：`switchRepo()` 里有 `busy.value` 守卫，直接静默 `return`**
      （没有提示、没有视觉反馈，看起来就是「点了没生效」）；而 Ctrl+Tab / Ctrl+数字 走 `activate()`、
      **从不看 busy** —— 键盘能切、鼠标不能切，两条路径行为不一致。
      该守卫已删除：切仓库是「导航」不是「改动」，不该被一个正在跑的操作挡住；
      安全性由各处**已有**的仓库身份守卫保证（`refresh` / `fetchLog` / `loadMorePage` / `activate`
      都做了 path 快照比对，`executeFlow` 发现仓库变了会中止并提示「执行期间切换了仓库」）。
      **连带修掉三处「await 期间现读 repo」的越界**（此前只被 Ctrl+Tab 那条路暴露）：
      `ChangesPanel.doCommit`（提交与推送之间切走 → 改动会被推到**别的仓库**）、
      `App.askMergeInto`（在 A 里 checkout、在 B 里 merge）、
      `App.genReleaseNotes`（把 A 的提交写进 B 的报告）；
      `ChangesPanel.genCommitMsg` 另加一条「生成期间切走就丢弃结果」的守卫，避免 AI 结果串进新仓库的草稿。

## 分组管理

- [x] **拖得进、拖不出** → 归组有两条入口（把标签页拖到文件夹上、管理弹窗里点「添加仓库」），
      出组却只有一条（进管理弹窗 → 展开分组 → 点 ×），而下拉浮层里只有「打开」没有「移出」。
      根因是入口不对称，不是缺功能 —— `removeMember` 一直在，只是没接到手边。
      现在下拉里的成员行尾有 hover 出现的 ×（一键移出），也可以直接**拖到标签栏**移出、
      拖到另一个文件夹换组；管理弹窗里支持把成员直接拖到另一个分组。
- [x] **空分组提示指错位置** → 文案写「点**右下角**「管理分组」添加仓库」，而那个按钮在
      **选项卡栏最右侧**（右下角是状态栏）。改成「用选项卡栏右侧的『管理分组』添加仓库」。
- [x] **文件夹右键什么都不带** → 标签页有右键菜单（重命名 / 关闭 / 关闭其他），文件夹没有；
      「这个对象能做什么」只能靠点进去看。补上：重命名… / 管理分组… / 删除分组。
- [x] **归组后仓库从标签栏消失却没有任何提示** → 看起来像点坏了。现在 `addMember` / `removeMember` /
      删除分组都会给一句 toast。
- [x] **超长分组名把标签栏挤爆** → 名字加 `max-w-[140px] truncate`，并把成员数显示在名字右侧
      （`groupCount` 原先只出现在 title 和管理弹窗里）。

## AI 功能问题

- [x] AI Review 临时存储 → **升级为 localStorage 持久化**（gz.ai.review，FIFO 上限 30 条）：同分支二次打开/重启应用都能秒显上次报告 + 「重新生成」；Push 成功清除该键。
      顺手修了个真 bug：模板 @click="startReview" 把 MouseEvent 当 regen 传入导致永远跳过缓存，已改为仅显式传 true 才强制重生成。
      DiffViewer 解释面板同步持久化（commit 用 hash 键永久有效、文件用 路径+模式 键），markdown-it 渲染（html:false 防注入）
- [x] AI 报错一直挂在提交框里不消失（用户反馈，附截图）→ **根因是这一行位置在承载两种语义不同的东西，而两者都没有生命周期**：
      「AI 功能已关闭」/「先暂存文件」是「你点了但什么都没发生」的原因（状态）；
      「AI 请求失败（HTTP 402）：…或切换模型代号为 deepseek-flash 立即使用」是操作失败（事件），且带着可执行的解决办法。
      两者共用 `aiErr` 一个字符串，只在下次点击时才被清掉，于是永远留在提交框里。
      修法：分开处理 —— 前置条件提示**条件一达成自己退场**（因此不给关闭按钮，关掉它等于把「没做的事」说成做了）；
      请求失败给 × 由用户收起（**不猜秒数自动消失**：读到一半就没了比一直挂着更糟）；切仓库时一并清空。

## 样式、交互问题

- [x] tooltip 跟随主题 → 硬编码深色背景换成 bg-card/border-border/text-foreground token，浅色主题下自动变浅
- [x] 滚动条美化 → 宽度 9px→7px，颜色改用 --scrollbar-thumb 变量，六个主题各自适配
- [x] 搜索时泳道连线断裂 → 根因：过滤后父子提交被拆散，连线必然断。过滤模式下隐藏泳道改纯列表展示，清空搜索恢复图形
- [x] 主题配色重做 → 深空灰底（#101014）+ 紫罗兰主色（#8b7ff5），浅色主题同步调整；泳道图首道颜色对齐主色；Catppuccin/One/GitHub 预设不变
- [x] 其他主题配色统一 → Catppuccin/One/GitHub 预设的主色/危险色/diff 配色全部换成项目紫罗兰配色（#8b7ff5 深色系 / #6d5ef0 浅色系），只保留各主题自己的底色和滚动条颜色
- [x] app 图标重设计 → 圆形泳道主题：紫色外环 + 深空底 + 紫罗兰/青色双泳道 + 亮紫节点；`gen-icon.mjs` 加圆形裁剪，已重新生成（需重跑 `pnpm tauri build` 才会打进新 exe）
- [x] tooltip 贴边被截断 → 渲染后按实际尺寸收敛到视口内（8px 安全边距），靠近下边缘自动翻到鼠标上方
- [x] 整页刷新动画 → refreshing 时全页盖 bg-background/50 遮罩 + Spinner「刷新中…」（按钮 spin 动画保留）
- [x] 前缀下拉换 ui 组件 → 自研 ui/Select.vue（button+浮层列表，吃 border/bg token，支持键盘外点关闭），替换原生 select
- [x] UI 组件走查 → 下拉已全部换 ui/Select；checkbox 因 Windows 原生+accent-[var(--primary)] 观感尚可暂保留；
      Badge/Input/Button/Textarea/Tooltip/Spinner/Md 已全覆盖主要面
- [x] 操作按钮 tooltip 补齐 → 走查结果：工具栏 Pull/Push 补 title（说明含自动 -u 行为）、选项卡关闭 X 恢复 title、
      Review/新建/设置/打开本就有；AI 功能按钮与文件/分支行均已是 Tooltip 组件
- [x] tooltip 贴边截断 → 三级回退：右侧放不下→翻左侧；两侧都放不下→水平居中于鼠标且放到鼠标正上方；
      垂直贴底同理上翻。不再只压缩宽度
- [x] 默认字体现代化 → 默认栈换成 Segoe UI Variable Text（Win11 原生，平滑清晰），回退 Segoe UI/雅黑
- [x] 字体输入框改下拉 → ui/Select 组件，8 个热门选项（默认/Segoe UI Variable/雅黑/Inter/MiSans/HarmonyOS Sans/思源黑体/等宽），未安装的字体自动回退不会白屏
- [x] 按钮变禁用后 tooltip 不消失（用户反馈）→ 点「AI 生成提交信息」后提示一直挂在界面上。
      根因：那个按钮是 `:disabled="aiBusy || !staged.length || busy"`，**点下即变禁用**，而
      **Chrome 不会因为「指针底下那个元素被禁用」而补发 `mouseleave`**（指针不动就永远不重算
      hover），tooltip 的 leave 处理器收不到事件，于是它一直挂着直到鼠标移开。
      修在共用的 `ui/Tooltip.vue`，所以全应用的 tooltip 一起受益：展开时对触发元素挂
      `MutationObserver` 监听 `disabled` 属性，一出现就收起；另外 `@click` 上也收起
      （提示的使命就是把这次点击说清楚）。绑定放在每次 `enter()` 而不是 `onMounted()` ——
      槽位内容可能被 `v-if` 换掉，只绑一次会指向旧节点。
- [x] 文件变更历史的 diff 弹窗没有全屏按钮（用户反馈）→ **同一个功能在两个组件里各写了一遍，
      只改了其中一处**：全屏是给 `DiffViewer.vue` 加的（见 14.12），`FileHistoryModal.vue` 里
      那第二个 diff 面一直没有，用户直接指出了这一处。补全屏时一并补上它缺失的
      `aria-label="关闭"`（图标按钮没有可访问名，而 DiffViewer 那侧本来是有的）。
      连带修掉两个「不点就发现不了」的交互缺陷：①关掉搜索栏时输入框随 `v-if` 卸载，
      浏览器把焦点丢回 `body`，而 `v-trap` 的 Tab 循环是绑在弹层容器上的
      （`focusTrap.ts` 的 `el.addEventListener`）—— 焦点一旦离开容器，那个「拉回来」分支
      收不到事件，下一次 Tab 直接穿透到弹层背后；②`Ctrl+F` 判焦点归属时把 `body` 当成
      「别处在用」，于是点过 diff 文本（`select-text`）之后再按 Ctrl+F 毫无反应 ——
      而这个组件挂载期间，它自己就是打开着的那个弹窗。
- [x] 下拉框的长值折行溢出（用户反馈）→ 工作流「新建分支名」那行的前缀下拉，选中的
      `dla-feature/` 在 96px 宽的触发器里折成两行、撑破固定的 `h-8`。根因在共用的
      `ui/Select.vue`：**触发器是固定高度的 flex 行，却没有 `whitespace-nowrap`；
      装值的那一侧也没有 `truncate`** —— 于是文本会在字符自带的软换行点（连字符）折叠，
      高度不受控。修在共用组件（全应用的下拉一起受益）：触发器加 `whitespace-nowrap`、
      值加 `truncate`（`truncate` 带 `overflow: hidden`，会把 flex 子项的自动最小尺寸
      从 `auto` 变成 0，所以省略号真的会出现）、被截断时用原生 `title` 兜底；下拉面板改
      `w-max min-w-full`、选项加 `whitespace-nowrap`，长选项按内容撑开而不是挤在 96px
      里折行。顺带修同排的尺寸不一致：那个下拉是 `h-8`/`text-base`，紧挨着的输入框是
      `h-7`/`text-xs`，同排差 4px、字号还大一档。

## 全面审查修复（M13）

> 来源：四个审查视角的独立报告 + Lead 逐条实证复现，见 `docs/review/`。以下每条都记根因，
> 避免只贴症状。

### 错误信息

- [x] **失败时弹空白错误框** → 根因：`run()` 只取 `stderr` 当错误文本，但大量 git 失败信息走 **stdout**。
      实证：`git commit -m x`（无暂存）exit=1、stdout 54 字符 `nothing to commit, working tree clean`、**stderr 长度 0**；
      `git merge --edit side`（冲突）同样 stderr 为空。修复：stderr 为空时回落 stdout。
      连带修复：`humanize()` 里 `nothing to commit` 与 `conflict` 两条规则此前**永不命中**（死规则），现已生效，
      且冲突文案不再把用户赶去终端。

### 选项注入（位置参数未隔离）

- [x] **分支/标签/路径名以 `-` 开头会被 git 当选项** → 根因：用户输入直接放在位置参数位。
      实证危害：`git checkout -f` **exit=0 并静默丢弃未提交改动**（数据丢失级）；`git checkout --detach` exit=0 进入游离 HEAD；
      `git branch -m feature -f` exit=0 **静默不生效**（用户看到「成功」但分支没改名）。
      修复：新增 `check_positional()`（拒绝 `-` 开头 / 含 `..` / 空 / 含换行），并在命令末尾加 `--end-of-options`。
      **坑**：push 场景 `--` 无效（实测 `git push ... -- --mirror` 仍报 `src refspec ... does not match any`），
      必须用 `--end-of-options`。
- [x] **push 回退分支可注入 → 全量分支外泄** → 根因：`git_push` 在无上游时回退 `push -u origin <branch>`，
      分支名叫 `--mirror` 时实测把**所有**分支推到远程（含用户从未打算公开的分支）。修复同上。
- [x] `git_config_user` 无 `--` → 实测 `git config user.name --global` exit=0 且把 `--global` 写成用户名。

### 并发与状态

- [x] **刷新结果串仓库** → 根因：`refresh()` / `loadMorePage()` / `execStep()` 在 `await` 前没锁仓库身份，
      而 Ctrl+Tab、Ctrl+1..9 直接调 `activate()` **绕过 busy 检查**。后果不只是视图脏：`cachePut()` 会把 A 仓库的
      status/log 写进 B 的 LRU 槽位（切回来还是错数据），工作流甚至可能在**错误的仓库上 commit/push**。
      修复：入口快照 `const path = repo.value`，赋值前 `if (repo.value !== path) return`。

### 路径与文件

- [x] **重命名文件在暂存/丢弃/diff 三入口集体失效** → 根因：porcelain 的 `R  a.txt -> b.txt` 被整串当作 path
      （`line[3..]`），`git add -- "a.txt -> b.txt"` exit=128 `pathspec ... did not match any files`。
      修复：`ChangesPanel.filePath()` 取 `.split(" -> ").pop()`（5 处调用点统一收敛）。
- [x] **打开仓库不校验目录** → 根因：`openRepo()` 直接 `addRepo()` 落库，选错目录得到**永久坏选项卡**（每次点击都报错），
      而拖拽入口 `openDropped()` 反而有校验——两条路径行为不一致。修复：先 `checkRepo()` 再落库。
- [x] **没有 `git init` 入口** → 新项目无路可走，只能先去终端。修复：新增 `git_init` command + 打开仓库弹窗第三个入口。
- [x] **仓库外路径可被读/删/写（越界）** → 根因：`git_discard`（untracked 分支）、`git_diff_untracked`、`git_write_file`、
      `git_ignore_add` 都直接 `Path::new(&repo).join(&path)`，而 `join` 遇到 `..` 与绝对路径会**逃出仓库**。
      端到端实证（Rust 真机复现）：`repo.join("../IMPORTANT-OUTSIDE")` → `is_dir()==true` →
      **`remove_dir_all` 真的把仓库外那个目录连同 `important.txt` 一起删掉了**（数据丢失级）。
      修复：新增 `check_repo_path()`（拒绝绝对路径/盘符/`..`/空/控制字符）。
      **坑**：最初实现只检查**第一个** component，于是 `a/../../x` 这种「以正常目录开头」的逃逸被漏掉——
      单测抓到了，改成遍历全部 component。正常路径（`src/App.vue`）零回归。

### 健壮性与超时（第二轮遗留清理）

- [x] **所有 git 子进程无超时** → 根因：`run()` 用 `cmd.output()` 阻塞等到底，Cargo.toml 也没有 `wait-timeout`。
      fetch/pull/clone 在认证挂起或网络黑洞时会**永久卡住**，占满 `spawn_blocking` 线程池，
      前端的加载遮罩再也消失不了。修复：`git.rs` 手写 `output_with_timeout()`，
      **本地命令 120s / 网络命令（clone/fetch/pull/push/ls-remote）600s**，超时后 kill 子进程并返回中文提示。
      **三个实现要点**（每一个都写成了单测）：
      1. **两个管道必须并发读**：等进程退出再读，输出超过管道缓冲区（约 64KB）即死锁。
      2. **不能靠 `join()` 收结果**：kill 只杀得掉直接子进程，git 派生的孙进程（`git-remote-https` /
         `ssh` / 凭据助手）继承着管道写端，`join()` 会一直阻塞到它自己退出——超时形同虚设。
         实测：`cmd /C ping -n 30` 被 kill 后读线程仍阻塞了 29.4 秒。
         改用 `mpsc` + `recv_timeout` 限时收集（且消息带 is_err 标记，不能靠到达顺序区分，两个读线程是竞速的）。
         修完测试耗时从 29.78s 降到 3.56s。
      3. **读线程要边读边发**：`read_to_end` 只在 EOF 时返回，孙进程可能让管道**永不 EOF**，
         那样输出永远送不回来（成功后静默丢掉整个 diff）。改为每读一块就 send，
         外加一个 `None` 消息标记「该管道 EOF」，主线程集齐两个标记才提前结束。
      4. **不引 `wait-timeout` crate**：它只解决 wait 超时，管道仍需自己并发读，
         省不了几行却多一个依赖（项目刻意保持轻）。
- [x] **`git_pull` 缺 `--no-edit`** → 根因：pull 内层会 merge，需要写合并信息时**弹出编辑器**，
      而 GUI 下没有可用终端 → 挂死。`git_merge` 早就传了 `--no-edit`，pull 漏了。已补齐。
- [x] **`git_ignore_add` 会把非 UTF-8 的 .gitignore 静默清空** → 根因：
      `read_to_string(&f).unwrap_or_default()` 把 `Err(stream did not contain valid UTF-8)` 吞成空串，
      随后写回 → **原内容全丢**（GBK 编码在中文 Windows 上很常见）。修复：读失败时报错而不是当空文件。
- [x] **空仓库 / 游离 HEAD 下分支名被解析成提示语句** → 根因：`rest.split("...").next()` 在没有 `...` 时
      原样返回整行，于是 `## No commits yet on master` → 分支名 `"No commits yet on master"`，
      `## HEAD (no branch)` → `"HEAD (no branch)"`。后果：状态栏显示错乱，
      且该值会被当作 `push` 的目标分支（首次推送时报 `invalid refspec`）。修复：专门处理这两种首行。
- [x] **hex 校验放行空串** → `"".chars().all(is_ascii_hexdigit)` 恒为 true，四处校验都放行空 hash。
      **定级更正（别夸大）**：实测把空串作为**真实 argv 元素**传给 show / revert / cherry-pick / log / rev-parse，
      git **全部 exit=128**（`ambiguous argument ''` / `bad revision ''`），**并不会静默作用到 HEAD**。
      所以这是健壮性问题（提前给中文报错，而不是把 git 的 ambiguous argument 抛给用户），不是静默改错目标。
      **踩坑**：用 PowerShell 验证这条会得到**相反的错误结论** —— PS 会把空串参数整个吞掉，
      实际执行的是「不带该参数」，而 `git show` 不带参数默认就是 HEAD（exit=0）。
      要测空 argv 必须用 Rust/Node 这类如实传递参数的宿主。

### 平台与 ACL

- [x] **窗口标题静默失效** → 根因：`core:default` 只展开 `core:window:default`（读取权限），
      **不含 `allow-set-title`**（写入权限），`setTitle` 被 ACL 拒绝且产生未捕获 promise rejection。
      修复：`capabilities/default.json` 显式补 `core:window:allow-set-title`（1 行）+ 调用处 `.catch(() => {})`。
- [x] **lib.rs 漏注册 command（AGENTS.md 硬规则 1 第四次踩中）** → 本轮新增 `git_push_force` / `git_merge_abort` 时
      漏加 `invoke_handler` 条目；`cargo check` 完全不报错。同时 `git.rs` 残留一个游离 `}` 导致编译失败。
      提醒：**改完 Rust 一定要 `cargo check`，新增 command 一定要顺手注册**。

### 交互与可及性

- [x] **组件级 Enter/Esc 没有 IME 守卫** → 中文组词时 Enter 是「确认候选词」，会误触发建分支/建标签/提交/切仓库/关弹窗。
      全局 `keydown` 早有 `isComposing` 守卫，但组件级 13+ 处没有。
      **关键坑：IME 组合期间 `keyup` 的 `isComposing` 已经回到 false**，所以守卫加在 `@keyup` 上无效，必须逐个改到 `@keydown`。
      修复：新增统一的 `imeGuard()` 包装 + 三处漏网（仓库切换器、分支切换器、设置页前缀输入）。
- [x] **单文件暂存按钮 hover-only** → 根因：`opacity-0 group-hover:opacity-100` 的裸 `<svg>`，
      键盘与触屏用户**做不了单文件暂存**（核心操作不可达）。修复：改常显 `Button` + `aria-label`。
- [x] 图表行缺 `title`（历史图/热力图）→ 补原生 `title`，不包 Tooltip 组件（数百行会卡）

## 全面审查修复（第三批：把「已确认但没修」的清完）

> 前三节是审查当轮改的；这一节是随后逐条清掉审查报告里**已确认但当时未修**的欠账。
> 审查报告（`docs/review/*.md`）保持原样不改写，只在这里记录修复。

### 并发与状态（假 Bug 与真 Bug）

- [x] **切分支失败后界面停在假分支名**（`docs/ANALYSIS.md` 真 Bug #1，一直没修）→
      根因：`switchBranch` 先乐观改 `status.branch` 与分支树 `current`，而 `run()` **只在成功时**
      `await refresh()`，失败只弹错误框。修复：`doSwitch` 先快照 `prevBranch` / `prevCurrent`，
      catch 里回滚后 `throw`（交回 `run()` 弹框）。
- [x] **历史范围切换与仓库切换竞态**（真 Bug #2）→ 根因：`historyMode`/`historyFilePath` 的 watcher
      全程没有 seq token 也没有 `repo.value` 比对，切走之后旧仓库结果会覆盖新仓库历史、还会提前关遮罩。
      修复：进入时快照 `path`，赋值前比对；`finally` 里只在 `repo.value === path` 时才碰遮罩。
- [x] **`refresh()` 无互斥**（`docs/ANALYSIS.md` 三-4）→ 根因：窗口聚焦与 F5 直接调 `refresh()`，
      不看 `busy`；先发起的旧请求晚回来会把提交后的新状态覆盖回旧值。
      修复：加 `refreshSeq` 序号，只有最新一次刷新允许写入状态与 LRU 缓存。
- [x] **`fetchLog()` 隐式读 `repo.value`** → 这是上面两个跨仓库串台的**共同根因**：
      调用方无法把「这次请求属于哪个仓库」和结果对应起来。修复：`fetchLog(skip, path = repo.value)`
      显式收 path，4 个调用点全部显式传。
- [x] **工作流 `push` 步骤用过期分支名**（本轮新发现）→ 根因：`execStep` 的 `case "push"` 传
      `status.value?.branch`，但 `status` 在流程跑完前不刷新；若流程前面有 `checkout` 步骤，
      这里拿到的是**切换前**的分支名。后果不只是「推错分支」——`git_push` 在「无上游」时会
      `push -u origin <branch>`，于是给一个不相干的分支建立了远程跟踪。
      修复：`push` 步骤现读 `api.status(path)` 拿真实当前分支。

### 健壮性：坏数据与无出口的请求

- [x] **localStorage 坏数据导致白屏** → 根因：9 处裸 `JSON.parse(localStorage.getItem(...))` 无保护，
      其中 `gz.repos` / `gz.groups` / `gz.barOrder` 三处在 setup 期间**同步执行**，
      坏数据直接白屏且用户点不到设置入口自救。
      修复：新增 `src/lib/safeJson.ts`（`parseJson` / `parseJsonArray` / `parseJsonObject` +
      `read*` 薄包装，`Storage` 取不到时返回 fallback，覆盖隐私模式），9 处全部接线。
      自检 `src/lib/safeJson.test.ts` 覆盖 `"undefined"`（`JSON.parse` 会抛）、`"{"`、形状不对等。
- [x] **`settings.ts` 用 `as Settings` 撒谎** → 根因：`{ ...DEFAULTS, ...saved } as Settings` 只是让编译器
      闭嘴，存坏的 `fontSize: "big"` 照样进 reactive 并生效；还靠 `diffAddBg: undefined` 之类的字段
      「保留」已废弃的历史键。修复：逐字段 `pickStr` / `pickNum` 取值 + 类型校验 + 缺省回退，
      历史字段不再读取。
- [x] **全仓没有崩溃兜底** → 根因：grep `errorHandler` / `unhandledrejection` 零命中，
      任何未捕获异常/未处理 rejection 都无声无息。修复：`src/main.ts` 挂 `app.config.errorHandler`
      （组件名取 `name ?? __name`）+ `unhandledrejection` + `error` 监听，**只记录不弹 toast**
      （业务错误路径已有 `showError`，再弹一次只是重复打扰）。
- [x] **AI 请求无法取消，超时只是标志位** → 根因：`TIMEOUT_MS` 只用来判「算不算超时」，
      底下的 fetch 会一直挂着；关掉 AI 弹窗后请求仍跑满 30s。
      修复：`src/ai.ts` 用 `AbortController` 真取消 + 真超时，导出 `abortAi()` / `AbortError` /
      `isAbortError()`；`abortable()` 让 abort **立刻 reject**，不等宿主 promise settle
      （tauri-plugin-http 的 fetch 被 abort 后不保证 settle）。
      **根因延伸**：取消会把响应体读取掐断，若不额外判定，取消会冒成「HTTP 500」或
      「AI 返回了无法解析的内容」——故两处响应体读取点都加了 `seq !== abortSeq` 判定。
      UI 侧在 App.vue 用一个 watch 收口：`reviewOpen` / `notesOpen` / `showSettings` / diff 弹层
      任一关闭即 `abortAi()`（比在 6 个关闭点上各调一次更不容易漏）。

### 交互：把危险操作和可达性补齐

- [x] **关闭仓库选项卡 / 关闭其他 没有确认，但菜单却标了 `danger: true`** → 根因：危险等级与防护强度
      反着来。修复：两者都走 `openConfirm`。判据是「关闭会把仓库从持久化的 `gz.repos` 里摘掉，
      重开必须再走一次系统目录选择框」，与「删除分支 / 删除工作流」同类。
      「关闭其他」还会先统计数量，为 0 时改为 toast 提示而不是弹一个空确认框。
- [x] **删除工作流只是两段式按钮**（点一次变「确认删除？」，2.5s 自动复位）→ 既容易误点，
      也没说清删的是哪个工作流。修复：`SettingsModal.vue` 内改用真确认浮层
      （`v-trap` + `role="dialog"` + `aria-modal` + `aria-labelledby`，危险按钮 `variant="destructive"`，
      初始焦点给「取消」）。
      **Esc 的处理**：这张表（`overlayOrder`）是 App.vue 顶层浮层的，组件内层浮层进不去，
      故按 `ContextMenu` 的既有先例自己 `@keydown.esc.stop` 捕获——否则 App 层的 `settings`
      会吃掉 Esc 直接关掉整个设置页。
- [x] **侧栏拖宽上限不看窗口宽度** → 根因：固定 `Math.min(420,…)` / `Math.min(520,…)`，
      而最小窗口 860px 下左右侧栏已占 61%。修复：`maxLeftW()` / `maxRightW()` 按
      `window.innerWidth - 另一侧 - MIN_CENTER(460)` 动态收敛，并加 `resize` 时 `clampSidebars()`。
      **`clampSidebars` 只改 ref 不写回 localStorage**——用户在大窗口下的偏好宽度应当保留，
      缩窗只是临时压制。
- [x] **窗口 `focus` / `keydown` 监听从不清理** → 根因：`onMounted` 里匿名注册，
      `onUnmounted` 里没得可删；拖动侧栏中途卸载还会留下 `col-resize` 光标。
      修复：抽出具名 `onWindowFocus`，`onUnmounted` 里移除三个监听 + `endResize()`。
- [ ] **「移除分组成员」刻意不加确认**（决策，非缺陷）→ 同面板下方「添加仓库」列表一次点击即可加回，
      属完全可逆操作。注释写明：**危险操作到处确认会让确认失去意义**。
      改进方向是可逆性的**可见度**而不是再加一层确认：按钮 `title` 改成
      「移出分组（回到标签栏，可在下方列表点回来）」。
- [x] **模板里直接调用 `remoteNodes()`** → 每次重渲染都把每个展开的远程组全量重建一遍树。
      修复：改 `remoteNodeMap` computed（按 prefix 缓存），模板读 map。
- [x] **`syncBar()` 每次深变做两次全量 `JSON.stringify`** → 它挂在 deep watcher 上，拖拽/重命名会
      反复触发；叠加另外 3 个 deep watcher。修复：改 `sameBar()` 逐项比较，只在真正变化时赋值。

### 视觉：WCAG 2.1 AA 对比度

- [x] **`catppuccin-latte` 与浅色主题下大量文字对不达标** → 实测 latte 有 **12 项**低于 4.5:1
      （R3 报告记的是 10 项，差异在报告把 `muted-foreground/--muted` 只算了一项）。
      修复：调 `--muted-foreground` / `--primary` / `--destructive` / `--diff-add-text`
      （light、github-light、catppuccin-latte、one-dark、catppuccin-mocha 五套主题）。
      关键项改前→改后：次要文字/卡片 light 4.49→5.19、latte 3.25→5.77、one-dark 4.10→6.60；
      次要文字/浅层 light 3.95→4.57、latte 2.56→4.55、one-dark 2.81→4.52。
- [x] **Badge 用半透明底导致所有主题都不达标** → 根因：`bg-xxx/15` 是**合成色**，
      合成结果取决于底下的实际颜色，无法静态判定达标。修复：改实心 token 对
      （`--badge-{default,info,warning,danger}-{bg,fg}`，7 套主题 × 4 对 = 28 个 token），
      改后 24 项全部 ≥4.52。**取舍**：深色主题的 info 系从 4.83~5.05 统一到 4.52，
      用「消除半透明合成的不确定性」换「深色那几项略微变差」，都达标。
- [x] **危险按钮（`Button` 的 `destructive` 变体）在 3 套主题不达标、hover 六套全不达标** →
      根因：`bg-destructive/15 text-destructive` 同样是合成色。试过的两条错路：
      ①调暗 `--destructive` —— 不行，它同时被当**文字色**用在 25 处，语义不同不能动；
      ②改实心 `bg-destructive text-white` —— 也不行，白字对 `#f26d78` 只有 2.90。
      修复：新增**按钮专用**的 `--btn-danger-bg / -fg / -bg-hover`（7 套），与 `--destructive` 解耦；
      深色主题用深字压红底（6.48），浅色主题用白字压深红（4.72 / 5.53）。
      normal 3.82/3.65/4.27 → 4.72/5.53/6.48，hover 3.13~4.14 → 5.39~7.02。
      **根因延伸**：同一个 token 兼任「文字色」和「按钮底色」时，两边的对比度要求会互相拉扯——
      解耦比调色更根本。
- [x] **`Switch` 关闭态轨道在浅色主题下几乎看不见** → 根因：`bg-muted-foreground/40` 合成后
      对卡片底 light 只有 1.74、latte 只有 2.19，白滑块与轨道的边界消失。
      修复：改不透明 `--switch-off-bg`（light 5.19、latte 4.89）。
      **顺带更正一个误判**：滑块 `bg-white` 本身不是缺陷——它压在**有色彩的轨道**上，
      不压页面浅色底，所以「对背景 1.04」是个伪命题。
- [x] **泳道连线色硬编码，浅色主题下 4 个低于 3:1** → 根因：`HistoryGraph.vue` 的
      `stroke="#3a4450"` 不吃主题 token；`src/graph.ts` 的 `LANE_COLORS` 同理，
      且 7 个色有 4 个在浅色主题下低到 1.89。
      修复：连线改 `--graph-line` token（对 7 套 `--background` 全部 ≥3）；
      圆点色改用**亮度带**——把 7 个色的相对亮度 L 都调进 `[0.1750, 0.2595]`，
      可证明对全部主题背景同时满足 3:1，最差从 1.89 提到 3.07，7 个色相一个没丢。
      不变量已断言在 `src/graph.test.ts` 里。
- [x] **SVG 表现属性里用 `var()` 在三端不可靠** → 上面把 `stroke` 改成 `var(--graph-line)` 之后
      引入的新风险：表现属性对 `var()` 的支持在 WebKitGTK 上不稳，而**失效方式是整个属性被忽略**
      （`stroke` 回到初始值 `none`）→ 连线**直接消失**，不是退化成灰色。
      修复：改用内联样式绑定 `:style="{ stroke: 'var(--graph-line)' }"`（标准 CSS 解析路径，三端都稳）。
- [x] **实心主按钮文字在浅色主题不达标**（由新加的检查脚本暴露，属 task-10 的漏项）→
      light / github-light 的 `--primary-foreground` `#12101c` → `#ffffff`，4.04 → 4.76。
- [x] **新增 `scripts/check-contrast.mjs`**（纯 Node 内置，解析 `src/style.css` 含 `var()` 间接引用）：
      7 套主题 168 项 —— 文字对 63（≥4.5）、徽标 28（≥4.5）、危险按钮 14（含 hover，≥4.5）、
      图形 63（≥3）。**负向验证**：把 latte 的 `--muted-foreground` 改成 `#cccccc` →
      exit 1 并逐行报出 1.42 / 1.32 / 1.04；还原后文件 sha256 逐字节相同。

### 工程化：让「忘了」变成会失败的检查

- [x] **`gitApi.ts` ↔ `git.rs` 人工镜像零防护**（AGENTS.md 硬规则 3 只有文字约定）→
      新增 `scripts/check-contract.mjs`（纯 Node 内置模块，无新依赖）：
      ①`#[tauri::command]` ↔ `lib.rs` 的 `invoke_handler` **双向**注册检查（硬规则 1，历史栽过三次）
      ②`#[derive(Serialize)]` struct ↔ `gitApi.ts` interface 字段名双向比对（硬规则 3，
      兼容有/无 `pub` 前缀与 `serde(rename/skip)`）③`#[tauri::command]` 后面不是 `pub async fn`（硬规则 2）。
      **负向验证 6 组全过**（注销一行注册 / 双向改字段名 / 改 struct 名 / 把 `ahead: u32` 改成 `String` /
      去掉 `async`）——改坏的 5 组全部 exit 1 并指出行号，还原后 `git diff` 为空。
      挂进 `package.json` 的 `check:contract`，并与类型检查 + 5 个自检串成 `pnpm verify`。
- [x] **`vite.config.js` 完全没有 `build` 段** → 单 chunk、无 target、无 sourcemap 说明。
      修复：`manualChunks` 按包拆 `vendor-vue` / `vendor-markdown` / `vendor-icons`；
      `target: isWindows ? "chrome105" : "safari13"`（Tauri CLI 注入 `TAURI_ENV_PLATFORM`）；
      `sourcemap: false` + 开启方法注释。顺带补 `server.watch.ignored: ["**/src-tauri/**"]`
      （Tauri 官方模板做法，避免 chokidar 白盯上千个 cargo 产物）。
      **实测（同源 clean build 四组对照）**：拆包本身**不增加**体积（仅拆包 499.96 kB vs 改前 499.99 kB），
      标记扫描确认四个 chunk 无模块重复；非 Windows 兜底 `safari13` 会让总量 +1.53 kB（全是 target
      下调带来的转译），而 Windows 真实发版路径（`chrome105`）是 **496.00 kB，比改前小 3.99 kB**。

### 收尾：复核审查报告时又抓到的四条

清完前三批后再把 `docs/review/*.md` 的每条 P1/P2 重读一遍逐条核对，四条当时漏掉的：

- [x] **`git_diff_untracked` 的「上限」全在读完之后才生效**（`src-tauri/src/git.rs:502`）：
  原实现 `std::fs::read(&p)` 一次性把整个文件读进内存，**然后**才判二进制（`bytes.contains(&0)`）、
  才 `lines().take(2000)`——注释里写着「上限 2000 行，二进制文件提示」，实际内存上限为零。
  一个 GB 级的未跟踪文件（镜像、数据库转储）足以把内存打满。
  修复：抽出 `read_preview()`，`File::open` + `by_ref().take(MAX_PREVIEW=1 MiB)` + `read_to_end`，
  只读前 1 MiB 再判二进制/截行。**新增 Rust 单测 `read_preview_caps_bytes_read`**
  （5 MiB 文件只读到 1 MiB；小文件完整读到）。
- [x] **`git_get_user` 把「没配过」和「真失败」一起吞成空串**（`src-tauri/src/git.rs:535`）：
  原来是 `run(&repo, &["config", "user.name"]).unwrap_or_default()`。实测（Node 如实传 argv
  才测得准，PowerShell 会吞掉空串）：
  `git config user.name` 在**未配置**时 exit 1 / stdout 空 / **stderr 空**；
  而 `git config --default "" user.name` 对「未配置」是 **exit 0 + 空输出**，对真正的失败
  （目录不存在）仍然是 Err。改用 `--default ""` 后 `?` 传播真错误。
  前端 `SettingsModal.vue` 的 `catch {}` 同步补日志（原来注释写「非 git 目录时静默」，
  现在后端能区分了，真失败不该无声无息）。**新增 Rust 单测
  `git_get_user_distinguishes_unset_from_failure`**（配过→真实值；`--unset` 且屏蔽
  `GIT_CONFIG_GLOBAL`→空串不报错；目录不存在→必须 Err）。
- [x] **4 处 `await saveDialog(...)` 写在 try 外面**（`src/App.vue` 保存 AI Review / Release Notes、
  `src/components/DiffViewer.vue` 保存 AI 解释 / 导出 patch）：保存对话框是插件调用，
  ACL 未授权或后端异常时会 reject，而它恰好在 try 之外 → 用户「点了保存、什么都没发生、
  也没有任何提示」，只有一条没人接的未处理 rejection。修复：四处的 `saveDialog` 全部移进 try。
- [x] **`humanize()` 对 non-fast-forward 只给「先 Pull 再 Push」**（`src/App.vue:87`）：
  这条文案与「amend / 撤销提交」是**互相打架**的——用户刚 amend 完，正确的动作是用
  `--force-with-lease` 覆盖自己那一条，而旧文案会把他引去把远程旧提交合回来、造出多余的合并提交
  （正是 R4 点出的「断头路」）。修复：文案改为按情形分岔，并指向顶部 ↑N 里的「强制推送」。

**判定为不是缺陷、刻意保留的 `unwrap_or_default()`**（以免下一轮重复排查）：

- `git_remote_url`（`src-tauri/src/git.rs:687`）：空串就是「没有 origin」的正常答案。
  真失败（仓库读不了）也退化成空串，但 UI 只是「不显示网页链接」，无破坏、无错误动作。
- `git_latest_tag`（`src-tauri/src/git.rs:1319`）：空串 =「没有 tag」，而前端
  `src/App.vue:998` 本来就是 `await api.latestTag(...).catch(() => "")` + `notesLatest.value || "__all__"`，
  两边语义一致。真要区分「无 tag」与「真失败」，只能去匹配 git 的英文 stderr
  （`fatal: No names found`）——那正是本项目在别处刻意避免的脆弱做法，不值得。
- `git_check_repo`（`src-tauri/src/git.rs:1331`）：它是**谓词**，`false` =「不是一个可用的工作树」，
  对任何非 yes（非仓库、目录不存在、git 起不来）都是正确答案，调用方也只据此拒绝添加选项卡。
- 唯一真正会误导用户的是 `git_get_user`——它的返回值会填进**可编辑表单**，用户看到空框会以为
  是自己没配，然后去保存覆盖一遍。所以只改它一个。

### 交互与反馈（R3 审查的最后三条）

#### `onGlobalKeydown` 不判焦点，输入框里也在抢键

**根因**：`src/App.vue` 的全局快捷键处理器只挡了 `e.isComposing`（IME 组合态），
没有判断 `document.activeElement` 是不是输入框。于是 `Ctrl+1..9` / `Ctrl+P` / `Ctrl+B` /
`Ctrl+Shift+L` / `Ctrl+Shift+R` / `F5` 在**任何**输入框里都生效。
最难受的一例：在设置弹窗的输入框里按 `Ctrl+B`，分支切换器（`z-50`）直接盖在设置弹窗
（`z-30`）之上，层级瞬间错乱。次要问题是按键吞噬——`preventDefault()` 写在各分支最前面，
一个仓库都没有时按 `Ctrl+P` / `Ctrl+1` 也被吃掉，用户毫无反馈。

**修复**：先算 `typing`（`INPUT` / `TEXTAREA` / `isContentEditable`），输入框内只放行
`Esc`、`Ctrl+Tab`，以及「关掉自己正待着的那个切换器」（在切换器搜索框里按 `Ctrl+P`/`Ctrl+B`
得能关）；`preventDefault()` 全部挪到「确认确实有可做的事」之后。

#### 危险确认框与错误框共用「确认」二字，语义相反

**根因**：`ConfirmState` 没有按钮文案字段，危险框与错误框都渲染「确认」。
危险框里它的意思是「执行这个不可逆操作」，错误框里是「我知道了，关掉」——
用户建立起的直觉在另一个框里恰好是错的，两边都会犹豫或误点。
另外「确定 / 确认」在中文里没有可感知差异，却在不同弹窗里随机使用。

**修复**：`ConfirmState` 增加 `okText?: string`，默认「确认执行」；11 处危险确认框
（删除分支/远程分支/标签/分组/stash 记录、强制删除、丢弃未推送提交、放弃合并、强制推送、
关闭选项卡、关闭其他）改成把后果写在按钮上；错误框按钮改为「知道了」。

#### 分页与内联错误没有任何反馈

**根因**：① `loadingMore` / `canLoadMore` 两个 ref 只参与脚本逻辑，模板里没有任何渲染——
用户滚到 300 条底部时页面完全静止，无法分辨「到底了」「正在加载」「卡住了」。
② `humanize()` 定义在 `App.vue` 内部，只覆盖 `run()` / `showError()` 一条路径；
AI 生成、diff 加载、文件历史、stash 列表这 6 处都是 `String(e).replace(/^Error: /, "")`
直出，用户会看到 `fatal: not a git repository` 这类英文原文。

**修复**：`humanize` 搬到 `src/lib/errors.ts`（新增一行版 `humanizeMsg`），6 处内联错误改走它；
`HistoryGraph` 增加 `loadingMore` / `canLoadMore` props 并在列表末尾渲染
「正在加载更多…」/「已到底部」。

## 视觉短板（M14：令牌化与现代化）

这一节的「缺陷」不是功能错，是**尺度与层次没有系统**。根因高度一致：
**每个值都是在用到它的那一刻就地决定的，没有一个地方规定过「一共几档」**。

### 字号有 8 档，其中 111 处是任意值 px

**根因**：`src/settings.ts` 把 `html { font-size: settings.fontSize + "px" }`（默认 13px），
于是 Tailwind 的 `text-xs` = 0.75rem = **9.75px**、`text-sm` = 0.875rem = **11.375px**——
按浏览器默认的 16px 基数设计的档位，在 13px 基数下全都偏小。
作者想要的尺寸在这两档之间，于是就地写 `text-[11px]`（73 处）、`text-[10.5px]`（10 处）……

**后果不只是丑**：用户调「设置 → 字号」，用 rem 的那一半会跟着变，用 px 硬写的另一半不变，
**同一屏里的相对大小会错乱**。

**修复**：字号 6 档全部改 rem（`--text-2xs` 0.75rem / `--text-xs` 0.8125rem / `--text-sm` 0.90625rem /
`--text-base` 1rem / `--text-lg` 1.1875rem / `--text-xl` 1.375rem），任意值清零。
`text-xs` / `text-sm` / `text-base` 是**覆盖** Tailwind 默认值，不是新增档位——这样旧代码里的
命名档位不需要改也自动归位。

### 表面只有 3 层，浮层与常驻面板同色

**根因**：`--background` / `--card` / `--muted` 三色既要表达「内嵌区比画布低」，
又要表达「浮层比画布高」，两个相反的方向挤在同一组色阶上。
结果是 19 个弹窗都写 `border border-border bg-card`——**背景色和它下面的侧栏面板一模一样**，
只能靠 `shadow-xl` 硬撑，而 24 个弹窗全都用同一个 `shadow-xl`，等于没有层次。

**修复**：加第四层 `--elevated`，明确 `--background` < `--muted` < `--card` < `--elevated`；
阴影拆成 `--elev-1..4` 四档（每档「紧贴投影 + 环境投影」两级 + 顶部 1px 高光）；
交互态（`--hover` / `--active`）用 `color-mix()` 从前景色派生，**不占层次**——
过去 hover 借用 `bg-muted`，而 `--muted` 是「内嵌区」语义，深色主题下它与画布几乎同色，hover 几乎看不见。

### 遮罩写死 `bg-black/50`，21 处不随主题

**根因**：遮罩是在第一次写弹窗时就地决定的，之后被复制了 20 次。
深色主题下 50% 黑正常，浅色主题下它把整个界面压成灰色——**浅色主题的弹窗看起来像蒙了层灰布**。

**修复**：`--scrim` 按主题给（深色 62% 黑、浅色 34% 深蓝、`one-dark` 58%），
`bg-black/50` 全仓清零。

### 弹窗宽度 8 个写死 px，内部节奏各不相同

**根因**：同上——宽度是在写每个弹窗时按内容临时估的（360 / 400 / 420 / 440 / 460 / 480 / 520 / 640），
内边距（`p-4`）、标题（`mb-2` / `mb-1.5` / `mb-3` + `font-medium` 三种写法）、
底部按钮区间距（`mt-3`）也各自为政。**19 个弹窗放在一起看就是 19 种设计**。

**修复**：宽度归到 4 档（`w-dlg-sm/md/lg/xl`，rem 跟随字号设置）；
标题统一 `mb-3 text-base font-semibold`；按钮区统一 `mt-5`；内边距统一 `p-5`（带边框的内部区块 `px-5 py-3`）。
配合 `surface` 工具类，弹窗的类名从「四个类描述外观」变成「一个类表达意图」。

### 等宽字体栈硬编码 `Consolas`，中文掉字体

**根因**：`src/components/ui/Md.vue` 给代码块写 `font-family: Consolas, monospace`。
Consolas **没有中文字形**，代码块里出现中文注释时会掉到系统兜底字体，与周围拉丁字符错位。

**修复**：统一走 `--font-mono`（`ui-monospace` → `Cascadia Mono` → `SF Mono` → `JetBrains Mono` →
`Menlo` → `Consolas` → `Microsoft YaHei UI` → …），中文回退在栈内。

### 全局没有任何过渡时长基准

**根因**：`transition` 出现 33 次，`duration` 只出现在两处（`duration-150` / `duration-500`），
其余全是默认的 150ms；另有 14 处元素「有 hover 变色但没写 transition」，颜色是硬切的。
**同一屏里有的元素滑顺、有的元素闪跳**，这是「廉价感」最直接的来源。

**修复**：`--dur-fast/base/slow` 三档 + `--ease-out` / `--ease-spring` 两条曲线；
过渡统一到 `duration-fast`（交互反馈）/ `duration-base`（浮层入场）/ `duration-slow`（大面积变化）。
`prefers-reduced-motion: reduce` 下三档全部压到 0.01ms。

### 输入框的底色让它读起来像禁用态（用户反馈，两轮）

**现象**：用户原话「表单的背景色太深了，有点像禁用的颜色」，改完后又回「还是很深」（附截图）。

**根因**：`ui/Input.vue` / `ui/Textarea.vue` / `ui/Select.vue` 的底色都是 `--background`（画布色）。
浅色主题下画布比卡片暗一点点，看着正常；深色主题下新加的浮层 `--elevated` 比画布**亮**，
于是弹窗里的输入框成了「比弹窗更黑的洞」。**控件底色相对于画布是对的，相对于它所在的表面才是错的那一半**——
输入框几乎都出现在弹窗里，它该跟 `--elevated` 比，不该跟 `--background` 比。
放大这个问题的是 `--border`：它对本主题 `--elevated` 的对比只有 1.1x（描边看不见），
一个没有边框的暗块，读起来就是禁用态。

**第一次修复走反了方向**：我按「比所在表面差一档才看得出是输入框」的想法，深色往上抬、
浅色往下压（light `#efeff0` / latte `#e7e7eb`）。用户截图后采样确认：弹窗底 `#FFFFFF`、
输入框 `#E7E7EB`，而他原来用的是画布色 `#EFF1F5` —— **我把它改得更深了**。
「差一档才看得出是输入框」是我自己编的规则；真实的形状线索是**描边**，不是底色差。

**修复**：新增 `--input-bg`（六个主题各一个值，`@theme inline` 加 `--color-input-bg`），
四个使用点改用它。规则只有一条 —— **不要和它所在的表面拉开明显色差**：
深色主题取比所在表面**亮**一档（`#2d2d36` / `#323249` / `#3a3f49` / `#262d36`），
浅色主题一律 `#ffffff`，形状交给描边。`--muted` 在深色主题里同样不好用——它比 `--elevated` 还暗。

**深色取值不是挑的，是算的**：底色越亮，placeholder（`--muted-foreground`）对比度越低。
求出「在所在表面上叠 `--foreground` 的最大比例」即上限：dark 4.5% / mocha 8.0% /
one-dark 5.0% / github-dark 5.0%。
`check-contrast.mjs` 的 `TEXT_PAIRS` 增加 `--foreground`/`--input-bg` 与
`--muted-foreground`/`--input-bg` 两对（182 → 196 项），并做了负向验证：
把 dark 的输入框调亮到 `#4a4a58` → placeholder 掉到 2.91，脚本 exit 1。

**连带**：设置页「启用 AI 功能」那行的 `bg-muted/40` 放到 `bg-muted/25` ——
输入框变白之后，它是表单区里唯一还在发灰的块。

### `--c-conf` 在 catppuccin-latte 上当文字只有 4.05:1（用户反馈带出来的）

**现象**：用户指着一个具体色值说 `#a16207`「太丑了，土里土气的」。
听上去是纯审美意见，查下去发现它还是一条**真实的对比度缺陷**。

**根因**：同一个 `#a16207` 在 `light` / `github-light` / `catppuccin-latte` 三个块里担了两个角色 ——
`--c-conf`（状态语义色）与 `--badge-warning-bg`（徽标底）。
`--c-conf` 会被**当文字**渲染（`App.vue` 的侧栏「↓N 落后」计数、`BranchTree.vue` 同一处），
而 `check-contrast.mjs` 从来没有检查过任何 `--c-*` 语义色：
**它们被当成了「只给图标上色」，但 `--c-conf` 不是。**
latte 的 `--card` 是 `#e6e9ef`（比白卡暗），深色文字压在上面对比度进一步下降 →
`#a16207` 只有 **4.05:1**（对 `--background` 4.35）。

**修复**（两轮，第一轮被否决）：
- `check-contrast.mjs` 新增第 4 组「状态语义色」（196 → **266** 项）：
  `--c-add/mod/del/ren` 只给图标上色，走图形阈值 3:1；`--c-conf` 当文字用，走 4.5:1。
  负向验证：改回 `#a16207` → `catppuccin-latte | --c-conf | --card | 4.05 | 4.5`，脚本 exit 1
- 第一轮把 `--c-conf` 换成青铜 `#8f5300`、`--badge-warning-bg` 换成金色 `#e5a821` ——
  **被用户否决：「不要大地色系，太土了」。** 只把一个褐色换成另一个褐色，没看到问题的结构。
- **真正的约束**：`--c-conf` 兼作文字色 → 必须够深（≥4.5:1）；而**黄色的深色版必然是橄榄色、
  橙色的深色版必然是赭石色**，就是大地色系。所以「黄/橙」这一族在「不要大地色系」下**无解**，
  除非 `--c-conf` 换色系。做成色卡让用户选 → 选定**湖蓝 cyan**。
- 第二轮（最终）：`--c-conf: #0b5f77`（对 `--card` 5.92 / 对 `--background` 6.37）、
  `--badge-warning-bg: #0e7490` + `--badge-warning-fg: #ffffff`（对 5.36）。
  与紫色主色 `#6f60f3` 同侧（冷色），离 `--c-add`（绿）/`--c-del`（红）都够远。

**只动浅色主题的这几个值，深色主题一个字节没碰** —— 上一次「顺手把各主题画布压暗」已经被用户否决过一次，
教训是：用户没说的地方不要动。

### 徽标长成了「按钮」（用户反馈）

**现象**：用户截了顶栏的 `↑16` 与提交历史里的分支名，说「这种胶囊样式很丑」。

**根因**：`ui/Badge.vue` 的四个彩色变体都是 **饱和实心底 + 白字 + `rounded-full`** ——
那是按钮的配方，不是标注的配方。后果有两层：

1. **形状**：全圆角 + 实心填充 = 药丸，读起来像「可以点」。
2. **对比度过剩**：实心底为了压住白字，文字对比被拉到 12:1 以上；
   而一排提交里最吵的就是这些标签，**注意力被标注抢走了，提交信息反而成了配角**。
   深色主题的 `--badge-warning-bg: #a87d2e` 还是琥珀/赭石色，正是上一轮被否定的那个色系 ——
   它只因为不在浅色主题里而逃过了一轮。

**修复**：
- 形状 `rounded-full` → `rounded-xs`（尺度表里 chip 那一档），`px-2` → `px-1.5`
- 48 个令牌（7 套主题 × 4 变体 × 底色/字色）改成「不透明淡色 tint + 同色系文字」，
  文字取刚过 5.0:1 的位置 —— 满足可读性即可，**高于需要的对比全是噪音**
- 顶栏 `↑N` 的 hover 由 `hover:bg-primary/30`（会换掉整个底色）改成同色描边环

### 右下角提示压住了「提交」按钮（用户反馈）

**现象**：用户说右下角的提示「挡着我操作了」。

**根因**：`ui/Toast.vue` 定位在 `right-4 bottom-10`，而应用的**右下角恰恰是主操作区** ——
右栏底部依次是提交信息输入框、「提交后推送到远程」开关和整宽的「提交」按钮。
提示容器本身有 `pointer-events-none`（不吃点击），但**看不见按钮和不能点是一回事**。

**修复**：改到底部居中（`left-1/2 -translate-x-1/2`，`max-w-[420px]` 防长消息横贯全屏）。
中间列的底部是唯一没有常驻控件的区域 —— 左栏底部是标签区、右栏底部是提交区、
顶栏和底栏各有控件。提示 2.4 秒自动消失、最多叠 4 条，短暂遮挡可以接受。

### 搜索框的放大镜图标偏下 4px（用户反馈）

**现象**：用户截图指出左栏「搜索分支」输入框的放大镜没和文字对齐。

**根因**：图标的定位父级是 `relative px-2.5 pb-2` —— **只有下内边距**。图标写的是 `top-1/2`
（相对**父级**高度的一半），而父级高度 = 输入框 28px + `pb-2` 8px = 36px，于是 `top-1/2` = 18px；
输入框自身的中心在 14px。**差的正好是半个下边距。**

**修复**：不是把 `top-1/2` 换成写死的 `top-3.5`，而是让 `relative` 只包住 `Input` ——
居中基准变成输入框本身，由结构保证，以后改外层内边距也不会再错。

**范围**：全仓 `absolute top-1/2` 共 4 处，另外 3 处（提交搜索框、仓库切换器、分支切换器）
的定位父级要么没有内边距、要么上下内边距对称（`p-2`），都不受影响。

