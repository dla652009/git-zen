# AGENTS.md — git-zen 开发指引

轻量级 Git 图形客户端（Tauri 2 + Vue 3 + TS strict + Tailwind v4）。后端不依赖 libgit2，
所有 git 逻辑直接 spawn `git` CLI，输出即真相。**改代码前先读 `docs/NOTES.md`（踩坑记录）**。

## 目录

- `src/` — Vue 前端。`App.vue` 是状态中枢（仓库 tabs/刷新调度/弹窗），业务组件在 `components/`，
  shadcn 风格基础组件在 `components/ui/`，纯函数 `graph.ts`（泳道布局）、`branchTree.ts`、`lib/patch.ts`（diff 解析）
- `src-tauri/src/git.rs` — 全部后端逻辑，单文件，一个 command = 一次 git CLI 调用
- `docs/` — DESIGN（架构）/ NOTES（坑，必读）/ TASKS（里程碑与需求池）/ BUGS（缺陷+根因）

## 常用命令

```bash
pnpm tauri dev                                # 开发（首次 Rust 编译 3-5 分钟）
npx vue-tsc --noEmit                          # 类型检查（pnpm build 内置）
node --experimental-strip-types src/graph.test.ts        # 泳道布局自检（需 Node ≥22.6）
node --experimental-strip-types src/lib/patch.test.ts    # diff 解析自检
cd src-tauri && cargo check                   # Rust 检查
pnpm tauri build                              # release（产物 src-tauri/target/release/）
```

注意：两个 *.test.ts 自检脚本被 tsconfig exclude，不参与 vue-tsc；改布局/diff 解析后手动跑。

## 硬性架构规则（违反会炸或埋雷）

1. **新增 `#[tauri::command]` 必须立刻注册 `lib.rs` 的 invoke_handler**——cargo check 不报错，
   只有运行时 `Command xxx not found`。历史上栽过三次。
2. **所有 Tauri command 必须 `async fn` + `offload()`（spawn_blocking）**——同步 command 跑在主线程，
   git 慢调用会冻住整个窗口。
3. **`src/gitApi.ts` 的 interface 与 `git.rs` 的 serde struct 是人工镜像**——改一边必须同步另一边，无代码生成。
4. **刷新策略**：组件只 emit action，任何操作成功后由 `App.vue run()` 统一重拉 status/log/branches，不做增量更新。
5. **AI 功能全部只读**（只消费 diff/log 文本），提示词只允许写在 `src/ai.ts` 的 AI_PROMPTS。

## 编码约定

- 中文注释与 UI 文案；错误信息经 `App.vue humanize()` 映射成人话，原始 stderr 附显。
- git 调用统一走 `git.rs run()`（已注入 `-c core.quotepath=false`、`GIT_TERMINAL_PROMPT=0`、
  Windows `CREATE_NO_WINDOW`）；语义敏感命令（commit/revert 等）prepend `-c alias.X=X` 防别名劫持。
- UI 优先复用 `components/ui/`（Button/Input/Select/Tooltip/Spinner/Badge/Switch/Md），照 shadcn 源码拷新的，不引组件库。
- 逐行/diff 场景用原生 `title` 做 tooltip（数百行包 Tooltip 组件实例会卡）；按钮类才用 ui/Tooltip。
- writable computed 背后的存储必须响应式（per-repo 草稿用 `reactive(new Map())`）。
- 模板 `@click="fn"` 会把 MouseEvent 传成首参——带布尔形参的处理器写 `fn()` 或严格 `=== true` 判断。
- 拖拽一律鼠标事件方案或 vue-draggable-plus（`force-fallback: true`），**别用 HTML5 DnD API**（WebView2 里不可靠）。

## 平台与构建坑

- Windows GUI 下任何新子进程调用都要带 `CREATE_NO_WINDOW`（否则打包后每次调用闪黑框）。
- 换应用图标后必须 `cargo clean` 再构建（编译期内嵌，增量编译检测不到 ico 变化）。
- diff 解析支持 unified（`diff --git`）与合并冲突 combined（`diff --cc`）两种格式，行级 blame 依赖
  patch.ts 的 oldLine/newLine 行号跟踪——改解析先跑 `lib/patch.test.ts`。
- 文档纪律：修完 bug 更新 `docs/BUGS.md`（含根因）、完成功能更新 `docs/TASKS.md`，新决策进 `docs/NOTES.md`。
