# git-zen 界面优化提案：保留布局，精修视觉

状态：已实施视觉精修（2026-11-18），布局骨架保持不变；真实桌面冒烟仍待人工确认。日期：2026-11-18。

最新修复与验证记录见 [UI-POLISH.md](UI-POLISH.md)。文末两轮实施记录为过程快照，其中选中背景与历史元数据宽度已被后续修复替代。

用户确认的约束：保留原有布局结构。上一版「静谧工作台」中的任务切换和上下文详情改造已撤回；聊天中上一版交互示意不再代表当前方案。

## 布局与操作边界

完整保留现有结构与顺序：

- 顶部：TitleBar → 操作工具栏 → RepoBar，不交换层级、不移动现有按钮。
- 左栏：分支搜索、本地分支、远程分支、标签，保留原分组与交互。
- 中栏：历史筛选、搜索、提交泳道图与历史列表，继续常驻。
- 右栏：ChangesPanel 的已暂存、未暂存、提交区，保留现有顺序、位置和入口。
- diff：沿用现有 DiffViewer 的打开方式与展示位置。
- 保留用户设置的栏宽、字体、主题，以及现有折叠、快捷键、拖拽与操作确认行为。

不新增「工作区 / 提交历史」任务切换，不将右栏改为上下文详情，不扩大布局改动或重构组件、状态与后端。

## Impeccable 视觉精修

目标是在同一张界面里，改善文字层级、对齐、颜色和控件细节，让熟悉的界面更干净。

| 区域 | 计划调整 |
| --- | --- |
| 主题 | 沿用当前紫色强调及已有主题，仅微调局部表面、边框和选中态的对比；不默认更换青绿色 |
| 顶部工具栏 | 保持按钮位置与功能，统一高度、图标尺寸、图标文字间距和内边距，减少重复描边造成的噪声 |
| 仓库 tab | 沿用现有样式结构，加强激活与非激活的区分，细化关闭按钮和 hover；保留原排序与分组 |
| 分支导航 | 统一标题与分组字号层级、缩进、图标对齐和数量样式；当前分支强调清晰但不过亮 |
| 提交历史 | 保持单行、高密度结构和现有行高，调整主题、作者、时间、hash 的字重与明暗；统一 refs 标签高度、内边距与对齐 |
| 变更列表 | 保留暂存区顺序与控件位置，细化文件名、路径、状态标记及选中态；普通变更数量用中性表达，冲突和危险操作保留语义强调 |
| 提交输入与按钮 | 保留原位置、功能与用户字体偏好，统一边框、焦点、圆角、内边距以及主次按钮的视觉权重 |
| 菜单与弹窗 | 沿用现有尺寸体系，统一分隔线、间距、阴影与选中反馈；Windows 7 独立皮肤保持兼容 |

所有微调复用 style.css tokens 与 components/ui。默认不改变列表密度、默认栏宽或滚动方式；如后续确需改变，单独说明范围再确认。

## Animate 局部动效

保留现有布局及业务时序，仅在原交互位置打磨反馈。Animate 是 Impeccable 的动效流程，不要求新增运行时依赖。

- hover / 按下：约 100–120ms 的底色、文字或描边变化，不移动点击区域。
- 分支与列表选中：选中立即生效，背景变化约 100–150ms；不改变行高，不逐行入场，不重画泳道。
- 仓库 tab：仅细化激活态与关闭反馈，减少高频切仓库时现有整栏位移和延迟；保留拖拽机制。
- 菜单与弹窗：复用现有约 170ms 入场与更短退场，轻微淡变/位移；保留焦点与 Esc 行为。
- 分组展开：沿用现有折叠结构，统一箭头旋转与展开节奏。
- 暂存、提交及同步：保持当前真实操作与统一刷新机制，仅细化原位置的 loading、完成和失败反馈，不加入文件飞行动画或新的重排机制。

继续尊重 prefers-reduced-motion；减少动态效果时取消非必要位移与延迟，保留清楚的状态反馈。CSS 与 Vue Transition 能完成的效果不引入新依赖。

## 实施与验证

本轮先按现有界面完成视觉精修，再在相同布局上打磨动效。实施聚焦 style.css、必要的基础控件及各区域已有的样式类，不做结构重组。

实施后运行 pnpm verify，包括主题对比度、类型、自检与构建。UI 人工冒烟覆盖仓库切换、分支导航、历史滚动、暂存/取消暂存、提交、同步、diff、浮层、IME 和减少动态效果。跨公共模块或多文件的实施按项目规则做独立验收。仅在用户明确授权后调用浏览器测试或截图。

方案判断基于源码审视；实际实施记录与验证结果见文末「实施记录」与「第二轮局部补丁」。

## 参考

- [Impeccable 官方指引](https://github.com/pbakaus/impeccable/blob/main/skill/SKILL.src.md)
- [Animate 官方指引](https://github.com/pbakaus/impeccable/blob/main/skill/reference/animate.md)

本轮沿用上一轮已读取的官方指引；上一轮安装拉取超时，未完成技能安装。

## 实施记录（2026-11-18）

本轮只改样式、模板类名与少量展示结构（提交区标题行、历史行短 hash），没有改布局顺序、
数据流、git 调用、组件职责或后端。DiffViewer 的打开方式、虚拟滚动、行高、用户栏宽与字体设置全部保留。

### 改动文件

| 文件 | 内容 |
| --- | --- |
| `src/style.css` | 新增 `--row-selected-bg` / `--row-selected-strong` / `--focus-ring` 派生令牌并注册到 Tailwind；切仓库位移 16→10px、stagger 30/60→20/40ms；reduced-motion 去掉非必要位移与按钮缩放 |
| `src/App.vue` | 工具栏分三段、统一图标尺寸与分隔线；分支组标题字号/数量右对齐/图标对齐；历史范围下拉加宽 |
| `src/components/RepoBar.vue` | 页签激活态改为顶部 2px 主色条 + 接回内容区底色；hover 文字提亮；关闭键常驻占位（激活页签常态可见） |
| `src/components/BranchTree.vue` | 当前分支改为「选中底色 + 前景色 + semibold」；层级引导线降为 `--border-soft`；平铺/树两种视图同步 |
| `src/components/HistoryGraph.vue` | subject 与元信息拉开层级（作者/7 位 hash/相对时间，元信息固定窄列）；refs 徽标统一行高；单选/多选分别用弱/强选中底色 + 左侧主色条；泳道圆点加画布色描边 |
| `src/components/ChangesPanel.vue` | 未暂存计数由危险红改中性徽标；分区标题提为 `text-xs`；选中文件行用统一选中令牌；提交区增加「提交信息」标题行，AI 生成入口从输入框内移到标题行 |
| `src/components/DiffViewer.vue` | 头部按钮统一 h-6，AI 解释改为带文字的 quiet 按钮，关闭键与搜索/全屏/导出同高；选中文件行用统一选中令牌 |
| `src/components/ui/*` | Button 统一 `[&_svg]:shrink-0` + `select-none`；Input/Textarea/Select 增加基于 `--focus-ring` 的键盘焦点环；ContextMenu 改为内缩圆角悬停 |

### 主题覆盖表

新增颜色全部由各主题既有的 `--primary` / `--primary-soft` / `--foreground` / `--border` 派生，
**没有新增任何 `data-theme` 专用选择器或写死色值**。两套皮肤层（Win7 / XP）零改动。

| 主题 | 选中底色来源 | 页签/焦点强调 | 输入与文字 | 皮肤层 |
| --- | --- | --- | --- | --- |
| 默认深色 `dark`（`:root`） | `--primary-soft`（主色 16%） | `#8b7ff5` | 选中文字用 `--foreground`；hash/元信息用 `--muted-foreground` | 无 |
| 默认浅色 `light` | `--primary-soft` | `#6b5cf0` | 同上；浅色选中底上不再用主色文字（对比 3.71 < 4.5） | 无 |
| Catppuccin Mocha | `--primary-soft` | `#8b7ff5` | 同上 | 无 |
| Catppuccin Latte | `--primary-soft` | `#5e4eef` | 同上 | 无 |
| Windows 7 | token 块覆盖 `--primary-soft: #dceffc`，选中态自动变成 Aero 淡蓝 | 钢蓝 `#2f6f9f` 顶部条 | `.gz-field` / `.gz-btn` 的立体皮肤与虚点焦点框保持原样 | 未改 |
| Windows XP | token 块覆盖 `--primary-soft: #dbe4f7`，选中态变成 Luna 淡蓝 | 钢蓝 `#2a4fbd` 顶部条 | 同上，Luna 内凹输入框与虚点焦点框保持原样 | 未改 |

### 动效

- hover / 按下 / 选中：`--dur-fast`（110ms），只改底色/文字/描边，不移动点击区域。
- 页签、分支、列表选中：立即生效，背景 110ms 过渡；行高与虚拟滚动未改。
- 菜单 / 弹窗 / 折叠：沿用 `--dur-base`（170ms）与既有 `pop-in` / `collapse`。
- 切仓库：三栏位移 10px、stagger 20/40ms，总时长仍由 170ms + 收尾定时器控制。
- `prefers-reduced-motion: reduce`：切仓库改为纯淡入、按钮取消按压缩放、行进出场与弹层退场取消位移、stagger 延时归零。

### 验证结果

命令：`pnpm verify`（2026-11-18）。

- 契约检查：62 个 command 全部注册，13 个 serde struct 与 `gitApi.ts` 一致。
- 对比度检查：6 套主题（dark / light / catppuccin-mocha / catppuccin-latte / win7 / xp）共 228 项全部通过（文字 78、徽标 24、危险按钮 12、语义色 60、图形 54）。
- 类型检查：`vue-tsc --noEmit` 通过。
- 前端自检：13 个 `*.test.ts` 全部通过。
- 构建：`vite build` 通过（`dist/assets/index-*.css` 69KB 级）。
- 产物抽查：新令牌与工具类 `--row-selected-bg`、`bg-row-selected`、`bg-row-selected-strong`、`focus-visible:ring-focus-ring`、`border-t-primary` 均出现在构建产物中。
- 额外人工计算：主色文字压在 16% 主色选中底上的对比度为 3.71–4.57（light/mocha/latte 不足 4.5），因此当前分支文字改用前景色，主色只用于左侧条与图标。

### 限制与待办

本轮按要求没有调用浏览器、没有截图、没有运行 UI 单测；以下真实桌面验证尚未执行，不能视为已验证：

1. `pnpm tauri dev` 启动后逐一切换 6 套主题（设置 › 外观）。
2. 检查工具栏按钮/图标基线、页签激活与关闭键、分支组数量对齐、当前分支底色。
3. 检查历史行 subject/refs/作者/hash/时间是否在窄栏下仍不互相挤压，选中/多选/悬停是否清楚。
4. 检查右栏「已暂存/未暂存」计数、空态、提交区标题与 AI 入口、提交按钮禁用态。
5. 打开文件 diff 与提交 diff，检查头部按钮同高、文件列表选中态。
6. 在系统「减少动态效果」开启时切仓库、暂存/取消暂存、开关菜单，确认无位移动画。
7. 重点复核 Windows 7 / XP 皮肤下的页签顶部条、输入框焦点与按钮立体感。

## 第二轮局部补丁（2026-11-18）

本轮在上一轮基础上只做局部视觉/动效补丁，不改布局顺序、数据流、git 调用、组件职责或后端；不新增依赖，不新增任务 tabs 或上下文详情。

### 改动文件

| 文件 | 内容 |
| --- | --- |
| `src/components/BranchTree.vue` | 文件夹数量与一级分组同一列右对齐（`ml-auto`），深层目录不再让数字随名字漂移；叶子行补 `select-none`，避免单击切分支时误选文字 |
| `src/components/HistoryGraph.vue` | 作者 / 短 hash / 相对时间统一 `text-xs`（hash 不再单独降到 `text-2xs`），元信息列 11.5→12rem；选中行仍统一回到前景色，保持 subject 与 metadata 的层级 |
| `src/components/ChangesPanel.vue` | 已暂存计数由紫色实心徽标改为中性徽标，与未暂存一致；普通变更计数不再使用危险红，颜色只留给冲突/删除 |
| `src/components/DiffViewer.vue` | 头部搜索/视图切换/全屏/导出由 `ghost` 改为 `quiet`，与 AI 解释、关闭键统一为同高的 24px 次级图标按钮；分隔线只留在 AI 与关闭之间 |
| `src/components/FileHistoryModal.vue` | 头部 AI/搜索/全屏/关闭统一为 `quiet` + `h-6 w-6`，与 DiffViewer 头部同一套控件语法 |
| `src/components/SettingsModal.vue` | 左侧导航、模式按钮、配色卡片的选中态改用 `bg-row-selected` + 前景色，图标保留主色；分支前缀 chip 与工作流步骤序号改用前景色，避免浅色主题淡主色底上主色文字对比不足 |
| `src/components/GroupManagerModal.vue` | 展开分组行的选中态改用 `bg-row-selected` + 前景色，与列表选中态一致 |
| `src/style.css` | Win7 / XP 的 `--dur-fast` 由 90ms 提到 100ms，落在 100–170ms 区间；`prefers-reduced-motion` 下三栏保留 110ms 纯淡入（去掉位移与 stagger 延迟），其余过渡仍即时生效 |

### 主题覆盖表（第二轮）

本轮没有新增任何主题专用选择器或写死色值；新增/沿用的颜色全部来自各主题已有 token。6 套主题的枚举与 `src/settings.ts` 的 `THEME_SCHEMES`、`src/style.css` 的 `[data-theme]` 块一致。

| 主题 | 选中底色 | 选中文字 | 焦点环 | 计数/徽标 | 皮肤层 |
| --- | --- | --- | --- | --- | --- |
| 默认深色 `dark`（`:root`） | `--primary-soft`（主色 16%） | `--foreground` | `--focus-ring`（主色 26%） | `--muted` 中性底 | 无 |
| 默认浅色 `light` | `--primary-soft` | `--foreground` | `--focus-ring` | `--muted` | 无 |
| Catppuccin Mocha | `--primary-soft` | `--foreground` | `--focus-ring` | `--muted` | 无 |
| Catppuccin Latte | `--primary-soft` | `--foreground` | `--focus-ring` | `--muted` | 无 |
| Windows 7 | token 块覆盖 `--primary-soft: #dceffc`（Aero 淡蓝） | `--foreground` | `--focus-ring`（钢蓝 26%） | `--muted` | `.gz-field` / `.gz-btn` 立体皮肤未改；`--dur-fast` 100ms |
| Windows XP | token 块覆盖 `--primary-soft: #dbe4f7`（Luna 淡蓝） | `--foreground` | `--focus-ring`（Luna 蓝 26%） | `--muted` | 同上；`--dur-fast` 100ms |

`--row-selected-strong`（多选强选中，主色 24%）只在深色/浅色 token 的 `--primary` 上派生；Win7/XP 的 `--primary` 是各自钢蓝/Luna 蓝，因此强选中也自动跟随皮肤。

`settings.ts` 的 `THEME_SCHEMES` 共 6 个方案（上表全部覆盖）；`system` 只是模式，不是独立皮肤，按系统明暗解析到 light 或 dark 方案，因此不需要单独一行。

### 动效

- hover / 选中 / 焦点：`--dur-fast` 100–110ms，只改变底色、文字、描边，不移动点击区域。
- 弹层 / 折叠：`--dur-base` 170ms，沿用现有 `pop-in` / `collapse` / `dlg`。
- 仓库切换：三栏位移 10px、stagger 20/40ms，总时长仍由 170ms + 收尾定时器控制。
- `prefers-reduced-motion: reduce`：三栏改为 110ms 纯淡入，位移与 stagger 延迟归零；按钮取消按压缩放；行进出场与弹层退场取消位移。

### 验证结果

命令：`pnpm verify`（2026-11-18，第二轮补丁后）。

- 契约检查：62 个 command 全部注册，13 个 serde struct 与 `gitApi.ts` 字段一致。
- 对比度检查：6 套主题共 252 项全部通过 —— 文字 78、徽标 24、危险按钮 12、语义色 60、图形 54、选中行 24（正文与元信息 ≥4.5）。
- 类型检查：`vue-tsc --noEmit` 通过。
- 前端自检：14 个 `*.test.ts` 全部通过。
- 构建：`vite build` 通过（`dist/assets/index-*.css` 68.64KB）。
- 产物抽查：`--row-selected`、`--focus-ring`、`.bg-row-selected`、`.bg-row-selected-strong`、`duration-fast`、`border-t-primary` 均出现在构建产物中。

### 限制与待办

本轮按要求没有调用浏览器、没有截图、没有运行 UI 单测；以下真实桌面验证尚未执行，不能视为已验证：

1. `pnpm tauri dev` 启动后逐一切换 6 套主题（设置 › 外观），确认设置页导航/模式/配色卡片选中态在浅色与深色主题下都清楚。
2. 检查顶部工具栏按钮与图标基线、Pull/Push 与纯图标按钮的同高关系。
3. 检查仓库页签激活/hover/关闭键、分支一级组与文件夹数量是否同列右对齐、当前分支底色。
4. 检查历史行 subject / refs / 作者 / hash / 时间的层级，单选与 Ctrl/Shift 多选是否清楚。
5. 检查右栏「已暂存/未暂存」中性计数、文件选中态、提交区标题/AI 入口/提交按钮禁用态。
6. 打开 DiffViewer 与 FileHistoryModal，确认头部按钮同高、quiet 态与关闭键层级一致。
7. 在系统「减少动态效果」开启时切仓库、暂存/取消暂存、开关菜单，确认无位移与延迟，只保留短暂淡入。
8. 重点复核 Windows 7 / XP 皮肤下的页签、输入框焦点、按钮立体感与 100ms 过渡。
