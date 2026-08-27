# git-zen 设计文档

> 轻量级 Git 图形化客户端。对标 SourceTree 的功能子集，目标是快：启动快、操作快、不吃内存。

## 1. 背景与目标

SourceTree 基于 Electron，卡顿主要来自：大仓库全量渲染、Electron 内存占用、频繁的全量刷新。

git-zen 的对策：

| 目标 | 手段 |
| ------ | ------ |
| 轻 | Tauri 2（系统 WebView），安装包 ~10MB，内存 ~100MB |
| 快 | 直接 spawn `git` CLI，输出即真相；历史图分页渲染（300 条/页） |
| 简 | 核心四件套 + diff 查看 + 分支管理 + 仓库选项卡，其余进需求池 |

## 2. 技术选型

- **Tauri 2**：Rust 后端 + 系统 WebView，不打包 Chromium
- **Vue 3 + Vite + TypeScript**（strict，`pnpm build` 内置 vue-tsc 检查）
- **shadcn-vue 风格组件**：Tailwind CSS v4 + CVA，组件源码进仓库（`src/components/ui/`：Button/Badge/Input/Textarea/Tooltip/Spinner），零运行时组件库依赖；图标用 @lucide/vue
- **不用 libgit2 / gitoxide**：直接调 `git` CLI。理由：
  - 认证、credential helper、ssh 全部复用系统 git 配置，零适配
  - CLI 输出格式稳定，`--porcelain` 就是为脚本设计的
  - 少一个重型依赖，编译快
- **环境变量 `GIT_TERMINAL_PROMPT=0`**：需要密码时快速失败而不是挂死 UI
- **vue-draggable-plus**：列表拖拽排序统一用它，不自研 DnD
- **AI 能力（M6 规划）**：tauri-plugin-http 解决跨域，前端 TS 直调 OpenAI 兼容协议
  （Base URL 可配，通吃 OpenAI/DeepSeek/Ollama）；所有功能只读 diff/log 产文本，
  不写工作区；Key 存 localStorage

## 3. 架构

```text
┌──────────────────────────────────────────────────┐
│ Vue 前端 (WebView)                                │
│  App.vue            状态中枢：仓库tabs+刷新调度      │
│  │                   ├ 错误确认框 / 危险操作确认框    │
│  │                   └ 侧栏拖宽(持久化)             │
│  ├ RepoTabs         仓库选项卡：切换/重命名/删除/拖序   │
│  │                   （vue-draggable-plus 排序）        │
│  ├ BranchTree       分支前缀树（自递归）：切换/删除/   │
│  │                   重命名/合并，本地/远程共用       │
│  ├ HistoryGraph     泳道图+搜索过滤+滚动分页          │
│  ├ ChangesPanel     暂存区/提交框（点击看diff）        │
│  ├ DiffViewer       文件级/commit级 diff，分段折叠    │
│  ├ ChangesPanel     暂存区/提交框（双击看diff,右键丢弃） │
│  └ SettingsModal    codex风设置：用户/主题/字体/前缀    │
├──────────────────────────────────────────────────┤
│ Rust 后端 (src-tauri/src/git.rs)                  │
│  每个 command = 一次 git CLI 调用                   │
│  status / log(skip分页) / branches / diff(cached)  │
│  fetch / show(hash校验, -m --first-parent)          │
│  stage / unstage / commit / push / pull / checkout │
│  branch_create / branch_delete(-d/-D) / rename / merge│
│  push_delete(远程删支) / get_user / config_user        │
│  discard(丢弃) / revert                               │
└──────────────────────────────────────────────────┘
```

数据流：前端 invoke command → Rust spawn git → 返回 JSON（serde 序列化）→ 前端 reactive 更新。
每次操作成功后由 `App.vue run()` 统一重拉 status + log + branches，不做增量更新。
错误统一走 humanize 映射 → 居中确认框；危险操作（删分支/合并）先弹确认框再执行。

## 4. 关键设计决策

### 4.1 历史泳道图（src/graph.ts）

放弃解析 `git log --graph` 的 ASCII 字符画——脆弱且难测试。
改为 `--pretty=format:%H%x1f%P...` 拿到结构化 parent 列表，前端两遍扫描自算泳道：

1. **pass1**：顺序扫 commit，每条 lane 记录「下一个期待出现的 hash」，commit 出现即占列、其 parent 入空闲槽
2. **pass2**：收集 child→parent 连线，SVG 贝塞尔曲线绘制

好处：纯函数可单测（`node --experimental-strip-types src/graph.test.ts`）。
已知取舍：连线交叉不一定最优，要完美可上 dagre（见 NOTES.md）。

### 4.2 状态解析（porcelain v1）

`git status --porcelain=v1 -b`：

- 首行 `## branch...ahead N, behind M` 解析分支与领先落后数
- 其余行 `XY path`：X=暂存区状态码，Y=工作区状态码，`??`=未跟踪
- rename 行 `old -> new` 前端拆成删除线+箭头展示

### 4.3 分支前缀树（src/branchTree.ts）

分支名按 `/` 切开递归建树，相同前缀自动合并（feat/x、feat/y 归入 feat），
任意层级可折叠。本地/远程共用一套构建与渲染（BranchTree.vue 自递归组件），
远程组剥掉 `origin/` 前缀后再建树避免顶层重复。过滤 `*/HEAD` 符号引用。

### 4.4 设置系统（src/settings.ts）

- reactive settings + localStorage（`gz.settings`）持久化
- SettingsModal 用草稿模式编辑，「保存」才写回；watcher 同时 persist + applySettings（写 DOM：`data-theme`、字体字号）
- 主题 = CSS 变量集（`[data-theme=...]` 覆盖 token），内置 8 种：跟随系统/浅色/深色/Catppuccin Latte·Mocha/One Dark/GitHub Light·Dark
- diff 配色随主题走，不单独配置

### 4.5 明确不做的（YAGNI）

- rebase / cherry-pick 交互 UI → 终端更顺手
- 冲突解决 UI → 只做报错引导
- 自动轮询刷新 → fetch-once + 窗口聚焦刷新已够
- 其余见 TASKS.md 需求池

## 5. 目录结构

```text
git-zen/
├── docs/               # 设计/笔记/任务/Bug记录/BTW想法
├── scripts/gen-icon.mjs # 应用图标生成器（纯 node）
├── src/
│   ├── gitApi.ts       # invoke 封装 + 后端返回类型镜像（唯一与后端耦合处）
│   ├── graph.ts/.test.ts # 泳道布局纯函数 + 自检
│   ├── branchTree.ts   # 分支前缀树纯函数
│   ├── settings.ts     # 设置中心：持久化+应用（主题/字体）
│   ├── style.css       # Tailwind v4 入口 + 各主题 token
│   ├── shims-vue.d.ts
│   └── components/
│       ├── ui/         # shadcn 风格基础组件（Button/Badge/Input/Textarea/Tooltip/Spinner）
│       ├── HistoryGraph.vue / ChangesPanel.vue / DiffViewer.vue
│       ├── BranchTree.vue / SettingsModal.vue
├── src-tauri/
│   └── src/git.rs      # 所有后端逻辑，单文件
└── package.json
```
