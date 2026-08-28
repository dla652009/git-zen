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
