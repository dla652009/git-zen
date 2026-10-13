# git-zen 开发笔记

> 决策记录、坑、约定。改代码前先看这里。

## 约定

- **语言**：前端 TypeScript（strict），`pnpm build` 内置 `vue-tsc --noEmit` 检查
- **后端**：所有 git 逻辑集中在 `src-tauri/src/git.rs` 单文件，一个 command 一次 CLI 调用
- **类型镜像**：`src/gitApi.ts` 的 interface 必须与 `git.rs` 的 serde struct 字段一致，改一边要同步另一边（没有代码生成，人工对齐）
- **刷新策略**：任何操作成功后由 `App.vue run()` 统一重拉 status/log/branches，组件只 emit action 不自己刷新
- **UI**：shadcn-vue 风格，自拷源码组件在 `src/components/ui/`（index.ts 转命名导出），暗色 token 在 `style.css`（Tailwind v4 `@theme inline`）。新 UI 组件照 shadcn 源码拷，优先不引 reka-ui
- **测试**：布局算法自检 `node --experimental-strip-types src/graph.test.ts`

## 坑与决策记录

### Windows spawn git 必须加 CREATE_NO_WINDOW

GUI 应用（windows_subsystem="windows"）里 std::process::Command 启动控制台程序
（git.exe）会弹黑框：dev 模式父进程在终端里看不出，打包后每次 git 调用都闪窗。
run() 已统一加 creation_flags(CREATE_NO_WINDOW)。以后任何新增的子进程调用都要带。

### 新增 command 必须注册 lib.rs invoke_handler（已踩三次，血泪）

写了 #[tauri::command] 但忘在 lib.rs `invoke_handler` 列表里登记 → 前端报
`Command xxx not found`，且 **cargo check 不报错**（Rust 侧看是合法代码），
只有运行时才炸。ai_stream、git_remote_url 都栽过。
**自检习惯**：git.rs 加新 pub 命令后，立刻去 lib.rs 加一行；或 grep 对账。

### Tauri command 必须 async + spawn_blocking

Tauri v2 的同步 #[tauri::command] 跑在主线程：任何 git CLI 慢调用（大仓库 log、
网络 push/pull/fetch）都会冻住整个窗口（假死、无响应）。git.rs 已全部改为
`async fn` + `offload()`（内部 spawn_blocking）。**以后新增命令一律照此写**，
直接同步写法就是给 T0 埋雷。

### 为什么不用 libgit2 / git2 crate

CLI 输出即真相：认证走系统 credential helper、ssh 走系统配置，零适配成本。
代价：解析 porcelain 格式。格式稳定，值得。

### GIT_TERMINAL_PROMPT=0

必须设。否则 push/pull 遇到需要输密码的远程会把子进程挂死，UI 卡住。
副作用：纯终端密码认证的远程会直接报错——这是特性不是 bug，快速失败。

### 泳道图不用 --graph ASCII 解析

试过思路就放弃：ASCII 字符画依赖 locale/宽度/版本行为，脆弱。
改拿 `%H%x1f%P` 结构化数据自己算泳道，纯函数可测。
已知天花板：连线交叉不最优（见 DESIGN.md 4.1）。

### Tauri 图标

换图标后必须 `cargo clean`（或删 target/*/build）再重新构建：Windows 图标在编译期
经 tauri-build 嵌进 exe 资源段，增量编译检测不到 .ico 内容变化，dev 窗口和 release
都会是旧图标。另外任务栏/资源管理器还有一层 Windows 图标缓存会撒谎——重建后还显示
旧图的话执行 `ie4uinit.exe -show` 或重启 explorer。cargo clean 若报拒绝访问，先杀掉
残留的 git-zen.exe / rust-analyzer 句柄再清。

`tauri.conf.json` 引用 `icons/icon.ico`，缺文件 Windows 构建会挂。
当前是脚本生成的纯色占位图，出正式包前换真图标。

### Node 版本

`node --experimental-strip-types` 需 Node ≥22.6。本机 22.23 可用。

## 待观察

- porcelain v1 的 rename 行是 `R  old -> new` 整串显示，未拆分。碍事再拆。
- `--max-count=300` 大仓库看不到头，用户反馈再加"加载更多"。

## 踩坑记录

- pnpm v11: 构建脚本批准写在 pnpm-workspace.yaml 的 `allowBuilds: {esbuild: true}`，package.json 的 pnpm 字段已废弃
- pnpm-workspace.yaml 不接受 verify-deps-before-run（schema 校验拒绝）

### 让「忘了登记」变成编译错误

Esc 关闭浮层原来是 `App.vue` 里一条 18 行手写 if 链，优先级就是 if 的顺序——新增浮层时
很容易漏加一行，漏了的后果是 Esc 关不掉它、或者关错了层，而且没有任何提示。

改成 `src/lib/overlays.ts` 的 `overlayOrder`（`as const` 数组）推出 `OverlayName` 联合类型，
`App.vue` 那边用 `Record<OverlayName, OverlayLayer>` 建表。**关键是 Record 的键必须齐全**：
只往 `overlayOrder` 里加名字、忘了补层，`vue-tsc` 直接报
`error TS2741: Property 'diff' is missing in type '{…}' but required in type 'Record<…>'`（已实测）。

一般化：把「藏在控制流顺序里的隐式约定」提成一张有名字的表，再用 `Record<联合类型, …>`
逼调用方补齐。同类场景：新增 command 忘了注册 `lib.rs`（硬性规则 1，那条至今只能靠人记）。

### NSIS 安装包

本机到 GitHub 的下载超时，tauri 拿不到 nsis-3.11.zip，安装包打不出来；exe 本身不受影响。
有网环境重跑 `pnpm tauri build` 即可（bundle targets 已配为 nsis）。WiX/MSI 同理，已弃用。

### merge commit 的 diff

`git show <merge>` 默认输出为空（clean merge 无 combined diff）。必须用 `-m --first-parent`
对比第一父提交。已在临时仓库实测验证。

### %(upstream:track) 的真实格式

输出带方括号：`[ahead 1]`、`[behind 2, ahead 3]`、`[gone]`，无上游时为空串。
解析前必须先剥掉 `[]` 和 `,`（第一版没剥导致徽标永远不显示，已在临时仓库实测拿到真实字节后修复）。
另外注意：`git push` 不会更新 remote-tracking refs，测试上游跟踪要先 fetch。

### core.quotepath 必须 false

git 默认把非 ASCII 路径转成 `ã...` 八进制转义并加引号。run() 已统一 prepend
`-c core.quotepath=false`——不加的话中文文件名展示乱码、回传 pathspec 匹配不到直接报错。
status 解析里还留了一层剥首尾引号的兑底（含特殊字符的路径仍会被 git 加引号）。

### 提交命令要防别名劫持

用户全局配置可能把 `alias.commit` 定义成“commit 后顺便 push”。所有语义敏感的 git 调用
（commit 等）都应 prepend `-c alias.<name>=<name>` 强制走内置命令。post-commit hook
无法用 flag 跳过，属用户仓库自身行为。

### push 无上游自动 -u

git_push 先普通 push，失败且 stderr 含 no upstream/no tracking information 时自动改
`push -u origin <分支>`。分支名由前端从 status.branch 传入。Branch.upstream 为空串
即"远程还没有这个分支"，状态栏据此常驻提示。

### AI 生成提交信息遵循 git-commit-message 规范

提示词已吸收 src/ai/skills/git-commit-message/SKILL.md：跟随仓库近期提交风格优先、
否则 Conventional Commits、祈使语气无尾句号、跟随仓库主导语言、只基于 diff 不臆造。
实现上 genCommitMsg 会把最近 10 条 subject 拼进 user prompt 作风格参考。

### computed setter 背后的存储必须响应式

writable computed 的 setter 写普通 Map/对象不会触发任何失效——请求成功、无报错、
但界面永远不更新（AI 生成提交信息回归就栽在这）。per-key 草稿这类结构用
`reactive(new Map())` + computed get/set。

### 行级 tooltip 用容器委托，别逐行包组件

数百行 diff 若每行包一个 Tooltip 组件 = 数百实例+监听器+Teleport，性能不可接受。
方案 = `ui/LineTooltips.vue`：容器 mouseover 委托 + e.target.closest('[data-tip]') 找行，
500ms 延迟后显示共享浮层；行上只加纯 data-tip 属性（零开销）。

**最终结论（已回退为原生 title）**：委托方案修了两轮仍不够稳（关闭不可靠、
锚定错位、修一处坏一处），复杂度远超收益。diff 逐行场景原生 title 的延迟展示
反而是对的：零代码、零性能开销、浏览器原生定位永不 bug。
按钮类 tooltip 仍用 ui/Tooltip 组件（单实例场景无此问题）。

同时警惕：批量替换时"守卫性 replace"可能误删结构性标签（曾删掉双栏行容器
导致 Invalid end tag，build 才暴露）。

### Vue 模板事件传参的隐坑

@click="fn" 会把 MouseEvent 作为第一参数传入。带布尔形参的处理函数必须写成
@click="fn()" 或在函数内严格判断 === true——否则参数是 truthy 的 event 对象，
AI Review 缓存跳过就是这个原因。

### AI 结果本地缓存

ai.ts 提供 aiCacheRead/Write/Delete（localStorage gz.ai.* bucket，FIFO 上限 30 条）：

- review bucket：键 repo::分支，Push 成功后删除
- explain bucket：commit 用 hash 键永久有效；工作区文件用 路径+暂存模式 键
注意 DiffViewer 缓存命中只预填解释面板，diff 主区照常请求加载。

### AI 流式输出（已取消）

曾实现过 Rust ai_stream SSE 转发方案，因部分模型/中转不支持 SSE 而回退，
统一用非流式 aiComplete + Spinner。若将来重做：plugin-http 的 fetch 会整体缓冲
拿不到 chunk，必须 Rust 侧转发 SSE；且 `tauri_plugin_http::reqwest` re-export
版本必须与显式依赖一致（混装 0.12/0.13 会导致 .json() 等方法丢失）。

**注意**：@click="fn" 会把 MouseEvent 传成首参，处理函数带布尔形参时模板要写
fn() 或函数内严格 === true 判断（AI Review 缓存曾踩过）。

### WebView2 的 HTML5 拖拽（已弃用）

HTML5 DnD 在 WebView2 里不可靠：补了 dataTransfer.setData 后 drop 仍时灵时不灵。
选项卡排序最终方案 = 纯鼠标事件（mousedown → 移动超 5px 激活 → 按 clientX 与各 tab
中点比较实时换位 → mouseup 收尾 + 吞掉补偿 click）。以后需要拖拽一律用这套，别碰 DnD API。

注意两个细节：

- mousedown 要 preventDefault 防止触发文字选中拖拽
- 拖完松手浏览器会补发一次 click，用 suppressClick + setTimeout(0) 吞掉

### vue-draggable-plus：禁止落点的位置要用 onMove 拦，别在 onEnd 里"事后收拾"

标签栏拖 tab 进文件夹的教训：Sortable 默认把列表里每一项都当排序目标——悬停文件夹时
实时把文件夹挤开腾位（DOM 被库搬走），此时在 onEnd 里改自己的数据源（归组 → syncBar
整体替换数组）会与库内部 onUpdate 的 model splice 竞争，barOrder 被写脏，模板读
item.kind 直接报 null TypeError。

正确姿势：**onMove 返回 false 拒绝不合法的落点**（仓库→文件夹位置），让库自己走
"无位移"复位分支；自己的数据变更推迟到 nextTick 等落子流程结束；数据源侧再用
syncBar 过滤脏值兜底。三个都做才稳，只做其一都会偶发复现。

### for-each-ref 的 format 不支持 %x1f，pretty format 支持

同一台 git（2.47）：`git log --pretty=format:%x1f` 会输出真实的 0x1F 控制字节
（stash list 底层是 log，同样支持，git_stash_list 靠它分隔字段）；但
`git for-each-ref --format=%x1f` 会**原样输出 `%x1f` 四个字符**——它用的是自己的
%(atom) 插值语言，不认 pretty 的 %xNN 转义。for-each-ref 要分隔字段就用真实字符：
tab 安全（ref 名禁止控制字符，contents:subject 恒为单行），git_tag_list 用 tab 分隔。

### git apply 的 --whitespace 没有 nofix 这个值

合法值只有 nowarn / warn / fix / error / error-all（实测 2.47 报
"unrecognized whitespace option 'nofix'"）。**默认行为就是不修正只警告**，
想要"绝不改动补丁内容"直接不加 --whitespace 参数即可。

### stash push 没有改动时退出码是 0

`git stash push` 在工作区干净时不报错，而是输出 "No local changes to save" 并以
退出码 0 结束——run() 按 stderr 判错完全探测不到。git_stash_push 对 stdout 做了
检查并转成明确中文报错；以后包"空操作成功"类命令时记得查 stdout 文案。

### 撤销/改写提交的"已推送"判定

amend 和撤销上次提交都要判断最近一次提交是否已在远程：**分支有上游且 ahead==0**
即本地与远程一致（上次提交就在远程），确认框给出改写历史/需强制推送的警告；
ahead>0 或无上游则操作安全。撤销根提交（仓库唯一提交）时 HEAD~1 不存在会报错，
前端按已加载提交数 ≤1 禁用按钮兜底。

### 隔离位置参数要用 --end-of-options，`--` 不是万能的

用户可控的名字（分支/标签/路径）落在位置参数位时，以 `-` 开头会被 git 当成选项——
`git checkout -f` 会静默丢弃未提交改动，`git branch -m feature -f` 会 exit=0 但静默不生效。
`--end-of-options` 能终止选项解析并保留位置参数语义，已验证对 checkout / branch -D/-m /
tag -d / config / push -u / push --force-with-lease / push --delete / merge / show 全部有效，
且带斜杠分支名、中文分支名、中文用户名**零回归**。

**注意 push 是例外**：`git push ... -- <ref>` 里的 `<ref>` 仍被当作 refspec 解析，
实测 `git push origin -- --mirror` 依然报 `src refspec --mirror does not match any`。
push 的位置参数（远程名、refspec）必须靠 `check_positional()` 自己拦。

### 强制推送用 --force-with-lease，不用 --force

amend / 撤销提交会改写历史，之后普通 push 必被拒（non-fast-forward）。此时给的是
`--force-with-lease`：只在远程分支仍停在本地已知位置时才覆盖，他人推过新提交就失败，
而不是像 `--force` 那样静默覆盖别人的工作。UI 出口放在顶部 ↑N 徽标的下拉菜单里，
amend/撤销的确认框文案也改成指向它（原先写的是「去终端执行」——应用内能做的事不该推给终端）。

### keyup 的 isComposing 已经回 false，IME 守卫必须加在 keydown

中文输入法组词时按 Enter 是「确认候选词」，不该触发提交/建分支/切仓库。全局 `keydown`
监听有 `isComposing` 守卫，但组件级用了 `@keyup.enter` 的地方**守卫加在 keyup 上无效**：
组合期间 keyup 触发时 `isComposing` 已回到 false。统一改用 `@keydown` + `imeGuard()` 包装。

### Path::join 会逃出仓库，校验必须遍历全部 component

`Path::new(&repo).join(user_path)` 不是"拼接"而是**路径解析**：`..` 会往上一级，
绝对路径 / 盘符会**直接替换** base。实测 `repo.join("../IMPORTANT-OUTSIDE")` → `is_dir()==true`，
接着 `remove_dir_all` 真的把仓库外那个目录连文件一起删了。凡是用户可控的 path 进
文件系统操作（读/写/删），一律先过 `check_repo_path()`。

**实现坑**：第一版只看了 `components().next()`（第一个 component），于是 `a/../../x`
这种"以正常目录开头"的逃逸被漏掉——是单测抓出来的。必须 `for c in path.components()`
遍历全部，对 `Prefix`/`RootDir`/`ParentDir` 三类一律拒绝。

### 用 PowerShell 验证「空参数」会得出相反的错误结论

PowerShell 会把空字符串参数**整个吞掉**，于是 `& git show ''` 实际执行的是 `git show`
（不带参数）——而 `git show` 不带参数默认就是 HEAD，exit=0。据此会误判成
「空 hash 会静默作用到 HEAD」，把一个 P3 健壮性问题写成数据安全问题。

真实行为（用 Rust 的 `std::process::Command` 如实传空 argv 元素）：show / revert /
cherry-pick / log / rev-parse **全部 exit=128**（`ambiguous argument ''` / `bad revision ''`）。

**教训**：验证"空参数 / 含空格 / 含特殊字符的参数"时，测试宿主必须如实传递 argv，
不能用会吞参数或做二次解析的 shell。同理适用于验证引号、`$`、反引号。

### 所有外部进程调用都要有超时

`cmd.output()` 会阻塞等到底。git 在认证挂起（凭据弹窗、ssh 卡住）或网络黑洞时不会自己退出，
`spawn_blocking` 的线程会被永久占住，前端遮罩再也消失不了。`run()` 现在**本地 120s / 网络 600s** 超时。

自己实现超时（`git.rs` 的 `output_with_timeout()`）时会撞上三个坑，都已有单测守着：

1. **两个管道必须并发读**。先 `wait()` 再读管道，输出超过管道缓冲区（约 64KB）时子进程阻塞在写、
   我们阻塞在读 → 死锁。std 的 `Command::output()` 内部就是这么做的，自己写容易漏。
2. **不能靠线程 `join()` 收结果**。`kill()` 只杀得掉**直接子进程**；git 会派生孙进程
   （`git-remote-https` / `ssh` / 凭据助手），它们**继承了管道写端**，`join()` 会一直阻塞到孙进程
   自己退出——超时形同虚设。实测 `cmd /C ping -n 30`：kill 掉 `cmd.exe` 后读线程仍阻塞 **29.4 秒**。
   正确做法是读线程把结果 `send` 回来，主线程 `recv_timeout` 限时收集，超时就直接放弃这些字节。
3. **读线程要边读边发，不能读完了再发一次**。`read_to_end` 只在 EOF 时返回，而孙进程可能让管道
   **永不 EOF**——那样这批输出就永远送不回来（成功后静默丢掉整个 diff）。
   改成每读一块就 `send`，并用一个 `None` 消息标记「这个管道 EOF 了」，
   主线程收到两个 EOF 标记才提前结束，否则按预算收尾。
4. **别靠消息到达顺序区分 stdout/stderr**——两个读线程是竞速的，消息必须自带标记。

另外：`wait-timeout` 这类 crate 只解决 wait 的超时，管道还是得自己并发读，省不了几行却多一个依赖，
所以这里选择手写。

### 焦点陷阱的可聚焦选择器：`<summary>` 没有 tabindex 属性

写 focus trap 时用 `[tabindex]:not([tabindex="-1"])` 是匹配不到 `<details>` 的 `<summary>` 的——
它由浏览器**隐式**赋予可聚焦性，DOM 上并没有 `tabindex` 属性，必须把 `summary` 单独写进选择器。

这个漏项会造成**真回归**而不是小瑕疵：陷阱内若只剩一个被匹配到的元素（典型是错误框里
「详细信息」+「确认」，只有「确认」匹配得上），`first === last`，Tab / Shift+Tab 双向都被拦回它自己，
`summary` 彻底键盘不可达。**加焦点陷阱是在改键盘可达性，必须核对陷阱内每个原本可达的元素仍可达。**

### read_to_string().unwrap_or_default() 会把文件清空

`git_ignore_add` 原本 `read_to_string(&f).unwrap_or_default()`：遇到非 UTF-8 的 .gitignore
（中文 Windows 上的 GBK 文件很常见）返回空串，随后把「空串 + 新行」写回 → **原内容全丢**。
读文件失败要报错，不要降级成"当作空文件"，因为下一步往往是写回。

### SVG 表现属性里的 var() 不能赌

`stroke="var(--graph-line)"` 看着和 CSS 里一样，但它是 **SVG 表现属性**，不是 CSS 声明。
表现属性按 CSS 值解析时对 `var()` 的支持在 WebKitGTK 上不可靠；而这个项目要同时跑
Windows(WebView2) / macOS(WKWebView) / Linux(WebKitGTK) 三端。

要命的是它**失效的方式**：变量解析不出来，属性值整体非法 → 该属性被整个忽略，
`stroke` 回到初始值 `none` → **连线直接消失**，而不是退化成灰色或黑色。
一个静默的、只在某个平台上出现的视觉回归。

改法：凡是靠 CSS 变量给色的 SVG 绘制，都走内联样式绑定，
`:style="{ stroke: 'var(--graph-line)' }"`。内联样式是标准 CSS 解析路径，三端都稳。

### 与主题无关的颜色，用「亮度带」而不是 7 套 token

泳道连线色（`src/graph.ts` 的 `LANE_COLORS`）原本是 7 个固定 hex，在浅色主题下有 4 个
低于 3:1。直觉方案是「每个主题各一套 token」，但那要求把颜色提到 CSS 里，
又撞上上一条的表现属性问题，还得给 `graph.ts` 的纯函数塞进主题概念。

更好的做法是算一下**可行区间**：设色的相对亮度为 L。前景比背景亮时
`(L_fg+0.05)/(L_bg+0.05) ≥ 3` → `L_fg ≥ 3·L_bg + 0.10`；前景比背景暗时反过来。
于是对每个背景各得一条界：

| 背景 | L | 给出的界 |
|---|---|---|
| `#101014` dark | 0.0053 | L ≥ 0.1159 |
| `#1e1e2e` mocha | 0.0140 | L ≥ 0.1421 |
| `#282c34` one-dark | 0.0250 | **L ≥ 0.1750** ← 下界 |
| `#0d1117` gh-dark | 0.0055 | L ≥ 0.1164 |
| `#ffffff` light | 1.0000 | L ≤ 0.3000 |
| `#eff1f5` latte | 0.8785 | **L ≤ 0.2595** ← 上界 |

正确带是 **[0.1750, 0.2595]**。

**这里是本人踩过的坑**：第一版我拿「最暗的背景 `#0d1117`」当约束算出了 `L ≥ 0.117`，
但那个方向是反的。对**暗色**背景，紧的那一端是**最亮的**那个（one-dark `#282c34`），
不是最暗的——背景越亮，前景就越得跟着亮才够 3:1。
用 `L ≥ 0.117` 去卡，会放过 L=0.1195 的 `#616161`：它对 dark 3.07 ✓、对 gh-dark 3.06 ✓，
但对 mocha 只有 2.65 ✗、对 one-dark 只有 2.26 ✗。（对手证明完毕。）
**推广：算极值区间时，要问的是「哪一端最紧」，而不是「哪个最极端」。**

有了这个带，只要把 7 个色相各自调明度落进去，一份颜色就够用了——不动主题系统，
不在 SVG 里用变量，还能在 `src/graph.test.ts` 里把这个不等式**断言死**。
本轮实测最差对比从 1.89 提到 3.07，7 个色相一个没丢（只压明度）。

**推广**：需要「在浅色和深色下都成立」的颜色，先别急着做主题变体，
先算可行区间。区间非空就说明一份值够用，把不变量的推导（连同每个背景贡献哪一条界）
写进测试注释。

### `git config` 读不到值时，用 `--default ""` 区分「没配」和「失败」

`git config user.name` 在**键不存在**时返回 exit 1、stdout 空、**stderr 也空**
——注意 stderr 是空的，所以 `run()` 连诊断信息都拿不到。如果这里用
`.unwrap_or_default()` 兜住，就会把「没配过」和「仓库根本打不开」一起吞成空串，
设置页只显示两个空输入框，用户以为是自己的问题。

`git config --default "" user.name` 把「没配」变成 **exit 0 + 空输出**，
而真正的失败（目录不存在 → 进程起不来）仍然是 Err。于是可以用 `?` 正常传播真错误。

> 实测必须用 Node（或 Rust）如实传 argv。用 PowerShell 测这条会得到**相反**的结论：
> `--default ""` 里的空串会被 PowerShell 吞掉，参数错位成 exit 129
> `error: wrong number of arguments`，看起来像是这个选项不存在。见上面那条「空参数」的坑。

### 反馈机制的分工（四套机制各管一段，别混用）

同一个「删除」动作，改造前在四处遇到四种防护：删分支弹 420px 红框、删标签弹红框、
删工作流连点两次同一个按钮、关选项卡什么都不问。用户无法形成稳定预期。
以此为界固定下来：

| 机制 | 管什么 | 判据 |
|---|---|---|
| 居中确认框（`openConfirm`） | **可能丢失工作区改动或已保存记录**的操作 | 丢了要重新做一遍（重选目录、重新合并、重新生成） |
| toast（`ui/toast.ts`） | 操作**成功**的反馈，以及事后补偿式提示 | 只报「已发生」，不要求用户决策 |
| 右键菜单（`ui/ContextMenu.vue`） | 同一对象的**次要操作入口** | 主路径单击、次要路径进菜单 |
| 原生 `title` | 逐行/大量元素上的补充说明 | 数量级在几百，包组件会卡（`ui/Tooltip` 只给按钮类） |

两条由此得出的具体规则：
- **不加确认也算对**：「移出分组」不加确认是刻意的——同一面板下方一次点击就能加回来，
  完全可逆。危险操作到处确认会让确认失去意义。
- **可逆操作要让它看起来可逆**：不加确认时，把「怎么撤销」写进 `title`
  （「移出分组（回到标签栏，可在下方列表点回来）」）。

### 按钮文案要写后果，不要写「确认」

同一个「确认」并排出现在两个弹窗里，意思却相反：危险框里是「**执行这个不可逆操作**」，
错误框里是「**我知道了，关掉**」。用户建立了「看到确认要小心」的直觉后会在错误框里犹豫；
反过来习惯了「确认 = 关窗」之后，会在危险框里形成误点惯性。
现在 `ConfirmState.okText` 让危险框直接写动词（「删除分支」「丢弃这些提交」「放弃合并」），
错误框改成「知道了」，默认回落到「确认执行」。
**把后果写在按钮上，比任何警告文案都有效。**

### 全局快捷键必须先判焦点

`onGlobalKeydown` 原来只挡 `e.isComposing`，于是 `Ctrl+1..9` / `Ctrl+B` / `Ctrl+Shift+L/R` /
`F5` 在**任何输入框里都会生效**。最难受的一例：在设置弹窗的输入框里按 `Ctrl+B`，
分支切换器（z-50）直接盖在设置弹窗（z-30）之上，层级瞬间错乱。

两条断言：
1. 输入框内只放行 `Esc`（要能关弹层）、`Ctrl+Tab`（切标签是全局导航），
   以及「关掉自己正待着的那个切换器」——在切换器搜索框里按 `Ctrl+P` / `Ctrl+B` 得能关。
2. `preventDefault()` 要放在**确认确实有可做的事之后**。过去它在最前面，
   一个仓库都没有时 `Ctrl+P` / `Ctrl+1` 也被吃掉，用户按下去毫无反馈——这叫按键吞噬。

### Tailwind v4 只把「用到的」令牌写进产物

首轮 `@theme` 加完令牌后 grep 产物，`--text-2xs` / `--radius-xs` / `--container-dlg-sm` /
`bg-elevated` / `shadow-elev-1` / `.surface` **全部 MISS**——看着像没注册，其实只是没人用。

验证方法：临时建一个 `src/__twprobe.ts`，内容是一个包含所有新类名的字符串常量，
`vite build` 后 grep 产物，验完删掉。**「产物里没有」不等于「没注册」，
但「产物里有」才等于「真的能用」**，而后者才是要验的。

### `duration-*` 在 v4 里没有命名空间

`tailwindcss/theme.css` 只有 `--default-transition-duration: 150ms` 与 `--ease-*`，
**没有 `--duration-*`**——`duration-150` 这类只吃裸数值。所以
`@theme { --duration-fast: 110ms }` 不会生成 `duration-fast`。
改法：时长变量放 `:root`，再用 `@utility duration-fast { transition-duration: var(--dur-fast); }` 包一层。

### `@utility` 定义的类排在核心工具类**之后**

实测构建产物的字节偏移：`.border-destructive` 17616、`.bg-elevated` 20715、`.text-base` 25337，
而 `.surface` 在 **29129**。同一元素上两者优先级相同（都是单类选择器），**后出现的赢**。

因为 `.surface` 里写的是 `background:` 和 `border:` 简写，于是：

- `class="surface border-destructive/40"` → 红边被还原成 `var(--border)`
- `class="surface bg-primary-soft"` → 底色被还原成 `var(--elevated)`

规则：这类「组合式表面」工具类只能用在**默认描边 + 默认底色**的标准情形；
要改底色或描边色就手写那一组（`bg-elevated border border-<色> shadow-elev-4`）。
抽象掉的东西一旦要破例，破例的成本会立刻暴露出来。

### 加一层要往「上」加，不要往下腾地方
**这一条是踩了坑之后改回来的，前一版的做法是错的。**

为了给浮层腾出第四层，我第一版把各主题的画布整体压暗了一档（默认深色 `#101014` → `#0d0d12`），
并把 Catppuccin Mocha / One Dark 的 `background` 与 `card` 对调。结果用户第一句话就是
「我感觉没之前的背景色好看了」——**因为配色是用户挑的，而层次是新需求；不能为了满足新需求去动用户已经认可的东西。**

正确的做法是**只往上加**：原封不动保留各主题的 `--background` / `--card` / `--muted`，
只新增一个比画布亮的 `--elevated` 给浮层用。用户唯一看到的差别就是「弹窗比背景亮」，其余一切照旧。

同理，`--muted` **不参与层次排名**：它在深色主题里比卡片亮（读作抬起），在浅色主题里比画布暗（读作内嵌），
两种都成立 —— 因为它总是叠在别的表面上，不是一层独立的表面。硬要把它塞进「越靠上越亮」的阶梯里，
就会像我第一版那样被迫去改 `--card` 与 `--background`。

唯一不可让渡的约束只有一条：**`--elevated` 必须比它盖住的画布亮**，否则弹窗显得比背景还凹。
（浅色主题里卡片本来就是 `#ffffff`，浮层到顶了，那层次就靠阴影区分。）

验证方法：把改后的 `style.css` 与改前的逐主题、逐令牌名做一次 diff，**结果里应该只有新增的令牌名，
没有一个既有令牌的值发生变化**。

### 换令牌系统时，旧令牌的「残留引用」比新令牌的缺失更危险

新令牌没生效，通常一眼能看出来（样式是 0）；但旧令牌残留会**静默地把新值改回旧值**，
看起来「设置了但没反应」。这次踩到两处，都是我自己埋的：

1. **`@theme inline` 尾部留了一行旧映射**：`--radius-md: var(--radius)`。Tailwind v4 的 `@theme`
   与 `@theme inline` 写进同一组 CSS 变量，**后写的赢**，于是 `@theme` 里新定义的
   `--radius-md: 7px` 被改回 `var(--radius)`（`0.375rem`）。整个圆角中档失效，而 `grep --radius-md`
   在源码里看到的是 7px —— 只有把**产物**里解析出来的值打出来才发现是 4.875px。
2. **`rem` 在本项目不等于 16px**。`src/settings.ts` 把 `html { font-size: settings.fontSize + "px" }`
   写成用户可调（默认 13px），所以 `22rem = 286px` 而不是 352px。我把弹窗宽度写成 rem 并注释成
   「352px」，实际渲染出来窄了两成。**字号档位是「正文变多大」（该跟 rem），
   弹窗宽度是「一块版面有多宽」（该用 px），两件事。**

规则：**改令牌系统时，先 `grep` 旧令牌名的全部引用（含 `@theme` / `@theme inline` 这类映射），
再在 clean build 之后从产物里核对解析值**——源码里的定义正确，不等于浏览器算出来的正确。

### 输入框的底色不要和它所在的表面拉开色差，形状交给描边

输入框沿用 `--background`（画布色）本来是通的——浅色主题下画布比卡片暗一点点，
看着就是个内嵌的框。问题出在深色主题：新加的浮层 `--elevated` 比画布**亮**，
于是画布色填进去就成了「比弹窗更黑的洞」，加上 `--border` 对这个表面几乎不可见
（描边和底色差值只有 1.1x），整个控件读起来就是**禁用态**——用户的原话。

**但第一版的修法只对了一半。** 我按「比所在表面差一档才看得出是输入框」的思路，
深色往上抬、浅色往下压（light `#efeff0` / latte `#e7e7eb`）。用户截图回了一句
「还是很深」——采样发现弹窗底是 `#FFFFFF`、输入框是 `#E7E7EB`，
而他原来的输入框是画布色 `#EFF1F5`。**我把它改得更深了。**

三条结论：

1. **控件的底色要相对于「它所在的表面」定，不是相对于画布定。** 输入框几乎都出现在弹窗
   （`--elevated`）里，所以该和 `--elevated` 比。这也解释了为什么 `--muted` 在这里不好用：
   它在深色主题里比 `--elevated` 还暗。
2. **方向是「靠近所在表面」，不是「拉开一档」。** 深色主题取比所在表面**亮**一档
   （不亮就是个更黑的洞）；浅色主题**直接取白**——白底 + 描边就是标准做法，
   给灰底才会读成「已禁用」。**「差一档才看得出是输入框」是我自己编的规则，
   而真实的形状线索是描边，不是底色。**
3. **亮多少不是审美问题，是可测量的上限。** 底色越亮，浅色文字（placeholder 用
   `--muted-foreground`）的对比度越低。扫一遍「在所在表面上叠 `--foreground` 百分之几」
   就能求出深色主题的最大值：dark 4.5% / mocha 8.0% / one-dark 5.0% / github-dark 5.0%。
   注意 one-dark 只能抬 1.10x —— 它的 `--foreground` 本来对比度就低，没有余量。
   **这就是为什么这类值要写进 `check-contrast.mjs`，光靠眼睛调会调出可达性回归。**

教训一句话：**用户说「太深」的时候，先确认你要改的那个值现在是多少、原来是多少——
我当时的「修」是把浅色主题从 `#EFF1F5` 改到 `#E7E7EB`，方向正好相反。**



