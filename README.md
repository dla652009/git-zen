# git-zen

> 轻量级 Git 图形化客户端：启动快、操作快、不吃内存。
> Tauri 2 + Vue 3 · 安装包 ~10MB · 运行内存 ~100MB · 不内置 Chromium

---

## 为什么做这个

SourceTree 功能全但太卡。git-zen 只做日常高频操作，把资源花在刀刃上：

- **直接调用系统 git CLI**——认证、SSH、credential helper 全部复用本机 git 配置，零适配
- **Tauri 2 + 系统 WebView**——不打包浏览器内核
- **异步架构**——所有 git 调用跑在线程池，大仓库/慢网络都不会冻住界面

## 功能

### 核心

- 暂存 / 取消暂存（单文件、全部、右键丢弃更改）
- 提交（Ctrl+Enter）、可选「提交后自动推送」
- Push / Pull，ahead/behind 徽标，无上游分支自动 `push -u`；点击 ↑N 徽标可放弃未推送的提交（重置回远程）
- 分支树：本地/远程分组折叠、模糊搜索、创建（支持多前缀）/删除/重命名/合并
- 泳道提交历史：分页加载、搜索过滤、**当前分支/所有分支**切换

### 效率

- **仓库选项卡**：多仓库快速切换，LRU 缓存切回秒开（容量可调，设置-个性化，默认 5）
- **选项卡分组**：书签文件夹模式——组内仓库收进下拉不占选项卡，支持拖 tab 进文件夹归组，右侧按钮弹窗统一管理
- **Ctrl+P 切换器**：多仓库模糊搜索 + 最近使用排序，键盘党最爱
- 文件变更历史：右键文件 → 双栏弹窗（左提交列表 / 右该文件 diff，`--follow` 追踪重命名）
- DiffViewer 双栏：左侧文件列表（可拖宽）/ 右侧 diff，选中复制、逐行 blame 归属、支持合并冲突展示
- 拖拽调整侧栏宽度、整页刷新动画、窗口标题显示未推送数
- 提交统计热力图：设置-用户信息页，GitHub 风格 12 个月提交热力（随主题配色，按你的提交邮箱过滤）

### AI（可选，OpenAI 兼容协议）

- AI 生成提交信息（遵循 Conventional Commits，自动学习仓库提交风格，可配中文/English）
- AI 解释变更 / AI Review 未推送提交（问题/风险/建议分节报告）
- 支持任意 OpenAI 兼容服务（OpenAI / DeepSeek / Kimi / 本地 Ollama），Key 仅存本机
- 所有 AI 功能只读消费 diff/log，不写工作区；可在设置中一键关闭

## 环境要求

| 依赖 | 版本 |
| ------ | ------ |
| Node.js | ≥ 22.6 |
| pnpm | ≥ 10（v11 已验证） |
| Rust | stable（含 MSVC toolchain） |
| Git | 任意近期版本（CLI 需在 PATH 中） |

## 快速开始

```bash
# 安装依赖（首次会提示批准 esbuild 构建脚本，选允许）
pnpm install

# 开发模式（首次 Rust 编译约 3-5 分钟）
pnpm tauri dev

# 构建 release
pnpm tauri build
# 产物：src-tauri/target/release/git-zen.exe
# 安装包：src-tauri/target/release/bundle/nsis/*.exe
```

> **注意**：更换应用图标后需要 `cargo clean` 再重新构建，
> 否则增量编译不会刷新 exe 内嵌的图标资源（详见 `docs/NOTES.md`）。

## 快捷键

| 按键 | 功能 |
| ------ | ------ |
| `Ctrl + P` | 仓库快速切换器（模糊搜索 + 最近使用排序） |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | 下一个 / 上一个仓库选项卡 |
| `Ctrl + 1..9` | 跳到第 N 个仓库选项卡 |
| `F5` | 刷新仓库状态 |
| `Ctrl + Enter`（提交框内） | 提交 |
| 双击分支 | 切换 / 建立跟踪分支 |
| 双击历史行 / 文件 | 查看 commit diff / 文件变更历史 |
| `Esc` | 关闭弹窗 |

## 项目结构

```text
git-zen/
├── docs/                  # 设计 / 笔记 / 任务 / Bug 记录
│   ├── DESIGN.md          # 架构与关键决策
│   ├── NOTES.md           # 踩坑记录（改代码前先看）
│   ├── TASKS.md           # 里程碑与需求池
│   └── BUGS.md            # 缺陷跟踪
├── scripts/gen-icon.mjs   # 应用图标生成器（纯 Node，无依赖）
├── src/                   # Vue 前端（TypeScript strict）
│   ├── ai.ts              # AI 统一入口（提示词/错误映射/本地缓存）
│   ├── gitApi.ts          # 后端命令封装 + 类型镜像
│   ├── graph.ts           # 泳道布局纯函数（可单测）
│   ├── branchTree.ts      # 分支前缀树纯函数
│   ├── settings.ts        # 设置中心（主题/字体/AI 配置）
│   └── components/
│       ├── ui/            # 自研 shadcn 风格基础组件
│       └── ...            # 业务组件
└── src-tauri/
    └── src/git.rs         # 全部后端逻辑：22 个命令，一个命令一次 git CLI
```

## 设计决策速览

- **不用 libgit2**：CLI 输出即真相，认证/SSH 零适配
- **所有命令 async + spawn_blocking**：同步 command 会阻塞主线程（T0 教训）
- **`-c core.quotepath=false` 全局注入**：中文路径不乱码
- **`CREATE_NO_WINDOW`**：打包后 git 调用不闪终端黑框
- 泳道图不解析 `--graph` ASCII，基于 `%H%x1f%P` 自算布局（纯函数可测）
- 完整决策与踩坑记录见 [docs/DESIGN.md](docs/DESIGN.md) 与 [docs/NOTES.md](docs/NOTES.md)

## 已知限制

- NSIS 安装包构建需要访问 GitHub 下载工具链（网络受限环境仅 exe 可用）
- 历史默认加载 300 条，更早的提交滚动自动分页加载
- 冲突解决引导至终端处理（GUI 冲突编辑不在路线图内）

## 文档

- [设计文档](docs/DESIGN.md) — 架构、技术选型、关键决策
- [开发笔记](docs/NOTES.md) — 踩坑记录，改代码前必读
- [任务看板](docs/TASKS.md) — 里程碑进度与需求池
- [Bug 记录](docs/BUGS.md) — 缺陷跟踪（含根因分析）

## License

MIT
