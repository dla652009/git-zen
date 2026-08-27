# git-zen Bug 记录

> 缺陷和优化点的记录，任务完成后修复这里的内容。

## T0 阻塞问题

- [x] 刚进入/切换选项卡加载仓库概率卡死、窗口无响应 → **根因**：Tauri v2 同步 command 在主线程执行，
      所有 git CLI 阻塞调用（log/status 大仓库慢、push/pull/fetch 网络慢）都会冻住 WebView → 假死。
      修复：全部 22 个命令改 `async fn` + `spawn_blocking` 下放线程池，主线程只管 UI
- [x] 操作期间容易卡死 → 同根因同修复；push/pull 网络操作不再阻塞 UI，只影响各自按钮的 Spinner

## Diff 功能

- [x] Merge 的 diff 不展示 → `git show -m --first-parent`，对比第一父提交（已实测验证）
- [x] 右侧文件改点击展示 diff 弹窗；暂存/取消暂存改为 hover 出图标按钮（+ 暂存 / Undo2 取消），与点击不冲突
- [x] 弹窗固定 80vh 高度，加载中不再跳动
- [x] 多文件 patch 按文件分段，点文件头展开/收起

## 设置功能

- [x] 需要保存/取消按钮 → 草稿编辑模式：改动先进 draft，点「保存」才写回；取消直接关弹窗不生效
- [x] 保存后，变更立刻生效 → settings 的 watcher 现在同时调 persist() + applySettings()（之前只持久化没应用，是个真 bug）
- [x] 设置 UI 太丑 → codex 风格左右布局：左侧分类导航（外观/个性化），右侧内容区，底部固定操作条
- [x] 去除 diff 样式设置 → 已移除；diff 颜色回归各主题内置配色，applySettings 会清掉旧版本写入的覆盖
- [x] 分支前缀多个 → 个性化改为 tag 式编辑器（回车/逗号添加、×删除），存储仍是逗号分隔串；创建分支弹窗下拉自动同步；下拉换自研 ui/Select 组件（吃 token 样式）

## 分支区（左侧栏）

- [x] 本地/origin 一级栏 → GitBranch / Cloud 图标 + font-medium 强调 + 数量徽标
- [x] 诡异空分支 → 根因：无 `/` 前缀或 `*/HEAD` 符号引用被剥前缀后变空串。已过滤 `*/HEAD` 和无效名，不再产生空项
- [x] 远程分支栏默认收起 → 远程组改记「展开」集合（openRemotes），默认全部收起，本地保持默认展开
- [x] 本地分支 ahead/behind 展示 → 后端 `%(upstream:track)` 解析，分支名旁 ↑N（蓝）↓M（黄）小字。首版解析器没剥 `[ahead 1]` 的方括号导致永远为 0，已实测修复
- [x] 合并到该分支后不切回 → 流程改为：切到目标 → merge 当前 → 留在目标分支；确认框文案同步
- [x] 远程分支删除 → 远程叶子 hover 出删除图标（仅删除，无重命名/合并），确认后 `push origin --delete <分支>`；新后端命令 `git_push_delete`。本地分支的删/改名/合并操作不变

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
- [ ] commit message 输入框的内容需要每个选项卡下的仓库单独保存

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

## AI 功能问题

- [x] AI Review 临时存储 → **升级为 localStorage 持久化**（gz.ai.review，FIFO 上限 30 条）：同分支二次打开/重启应用都能秒显上次报告 + 「重新生成」；Push 成功清除该键。
      顺手修了个真 bug：模板 @click="startReview" 把 MouseEvent 当 regen 传入导致永远跳过缓存，已改为仅显式传 true 才强制重生成。
      DiffViewer 解释面板同步持久化（commit 用 hash 键永久有效、文件用 路径+模式 键），markdown-it 渲染（html:false 防注入）

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
