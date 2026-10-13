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
- **AI 能力（M6 已落地）**：`src/ai.ts` 经 tauri-plugin-http 直调 OpenAI 兼容协议
  （Base URL/Key/Model 存设置）；功能=生成提交信息、解释变更、Review 未推送提交，
  全部只读 diff/log 产文本不写工作区；diff 超 16KB 自动截断喂给模型

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
│  remote_url / write_file / diff_unpushed / ai_stream  │
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

### 4.5 视觉系统：令牌分层（src/style.css）

界面观感的问题往往被归到「颜色不好看」，但真正的病因通常是**没有层次**——
一个界面的高级感来自「谁在谁上面」，不是来自色相。所以第一版做的是层次，不是调色。

- **表面分四层，但只有浮层有硬约束**：`--background`（画布）/ `--card`（面板、窗口镶边）/
  `--elevated`（浮层）/ `--muted`（叠在表面上的填充）。旧版本浮层与常驻面板共用 `--card`，
  弹窗与侧栏同色，只能靠阴影硬撑「浮」起来
- **`--muted` 不参与层次排名**：深色主题里它比卡片亮（读作抬起），浅色主题里比画布暗（读作内嵌），
  两种都成立——它总是叠在别的表面上。硬把它塞进一条「越靠上越亮」的阶梯里，
  就会被迫去改各主题的 `--background` / `--card`，而那正是用户挑好的配色
- **唯一不可让渡的约束：`--elevated` 必须比它盖住的画布亮**，否则弹窗显得比背景还凹。
  浅色主题里卡片本身就是 `#ffffff`，浮层到顶了，层次交给阴影
- **除 `--elevated` 外，所有既有颜色一律不动**：新增一层应该往上加，不是把画布压暗来腾地方
- **交互态不占层次**：`--hover` / `--active` / `--primary-soft` / `--border-soft` 用 `color-mix()`
  从前景色派生。过去 hover 借用 `--muted`，那是「填充」语义，深色主题下与画布几乎同色
- **遮罩 `--scrim` 按主题给**，不再是写死的 `bg-black/50`（浅色主题下会把界面压成灰色）
- **阴影四档 `--elev-1..4`**，每档「紧贴投影 + 环境投影」两级并带顶部 1px 高光；浅色主题单独换色，
  否则白底上的黑影会发脏
- **尺度按语义分档而非按大小**：字号 6 档（全 rem，跟随「设置 → 字号」缩放）、
  圆角 4 档、时长 3 档、弹窗宽度 4 档。此前字号 8 档中有 111 处是任意值 px，
  导致改字号设置时只有一半文字会跟着变
- **`surface` / `surface-menu` / `surface-panel` 三档组合式工具类**：底 + 描边 + 投影 + 高光一次给全。
  注意它们在产物 CSS 里排在核心工具类**之后**，所以不能与 `bg-*` / `border-*` 同元素覆盖（见 NOTES.md）
- **不用 `oklch()`**：`vite.config.js` 的 `build.target` 是 `safari13`，`oklch()` 需要 Safari 15.4+，
  Tailwind 不会替你做降级；`color-mix()` 可用（Tailwind v4 的 `/opacity` 本身就编译成它）

### 4.6 明确不做的（YAGNI）

- rebase / cherry-pick 交互 UI → 终端更顺手
- 冲突解决 UI → 只做报错引导
- 自动轮询刷新 → fetch-once + 窗口聚焦刷新已够
- 多窗口展示 → 状态全是模块级单例（repoCache/activateSeq/settings watcher），第二窗口即第二份
  JS 上下文，得先做 store 重构且违背「轻」定位；多仓库跳转由 Ctrl+P 切换器 + 选项卡分组承接
- 其余见 TASKS.md 需求池

## 5. 目录结构

```text
git-zen/
├── docs/               # 设计/笔记/任务/Bug记录/BTW想法
├── scripts/
│   ├── gen-icon.mjs         # 应用图标生成器（纯 node）
│   ├── check-contract.mjs   # git.rs ↔ lib.rs ↔ gitApi.ts 契约检查（硬性规则 1 / 3）
│   └── check-contrast.mjs   # 7 套主题的 WCAG 对比度检查
├── src/
│   ├── gitApi.ts       # invoke 封装 + 后端返回类型镜像（唯一与后端耦合处）
│   ├── graph.ts/.test.ts # 泳道布局纯函数 + 自检
│   ├── branchTree.ts   # 分支前缀树纯函数
│   ├── settings.ts     # 设置中心：持久化+应用（主题/字体）
│   ├── style.css       # Tailwind v4 入口 + 各主题 token + 组合式工具类
│   ├── lib/            # 无 DOM 依赖或可独立自检的纯模块
│   │   ├── patch.ts         # unified / combined diff 解析
│   │   ├── safeJson.ts      # localStorage 安全解析
│   │   ├── errors.ts        # humanize：git 错误 → 人话
│   │   ├── overlays.ts      # 浮层优先级表（Esc 分层关闭）
│   │   └── focusTrap.ts     # v-trap 指令
│   ├── shims-vue.d.ts
│   └── components/
│       ├── ui/         # shadcn 风格基础组件（Button/Badge/Input/Textarea/Select/Switch/Tooltip/Spinner/Toast/Md/ContextMenu）
│       ├── HistoryGraph.vue / ChangesPanel.vue / DiffViewer.vue
│       ├── BranchTree.vue / SettingsModal.vue / FileHistoryModal.vue / CommitHeatmap.vue
├── src-tauri/
│   └── src/git.rs      # 所有后端逻辑，单文件
└── package.json
```
