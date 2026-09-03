# git-zen 项目分析（2026-09-03）

> 当前版本 0.1.0 · 分支 feature/0.1（与 main 同步）· 全量代码走查 + 健康度实测

## 一、总体进展：M1–M7 全部完成，处于「v0.1 功能完备、待补工程化」阶段

Tauri 2 + Vue 3 轻量 Git 客户端，约 4300 行代码。按 TASKS.md 规划，**7 个里程碑全部完成**：
核心四件套（暂存/提交/Push/Pull）、分支树管理、泳道历史图、仓库选项卡（LRU 缓存）、
DiffViewer 双栏、文件历史、AI 三件套（生成提交信息/解释变更/Review 未推送提交）。

实测健康度指标（2026-09-03）：

- `vue-tsc --noEmit` 类型检查通过 ✓
- `node --experimental-strip-types src/graph.test.ts` 布局自检通过 ✓
- git.rs 的 26 个命令在 lib.rs 全部注册（历史上栽过 3 次的坑现已对齐）✓
- 文档纪律好：BUGS.md 每个缺陷有根因分析，NOTES.md 沉淀 20+ 条踩坑约定

## 二、缺少的功能

### Git 核心能力缺口（需求池已自知，按影响排序）

1. **Tag 完全没有支持**——列表/创建/删除/推送都没有，最明显的缺口
2. **Stash 管理**——开发者高频操作，目前只能去终端
3. **Amend / 撤销上次提交**——写错提交信息只能去终端
4. **Blame 视图**——DiffViewer 的行级「改动人」目前只是整个 commit 的作者，非真正逐行归属
5. **多 remote 支持**——push/pull/删远程分支写死 `origin`（git.rs:453 等处）
6. 其余：cherry-pick、hunk 级暂存、右键加入 .gitignore、range diff

### 工程化缺口（文档未列，发布前必须补）

- **零自动化测试**——只有 graph.ts 纯函数自检；组件层、Rust 层、e2e 全空白。
  App.vue 是 1162 行状态中枢，重构没有安全网
- **无 CI**（无 .github 目录）——类型检查/测试/构建都不在流水线上，全靠本机手动
- **NSIS 安装包未产出**（网络受限，README 已注明），无正式发布产物
- 界面仅中文（i18n 排在需求池末位）

## 三、存在的问题

### 真 Bug（建议优先修）

1. **切换分支乐观更新失败不回滚**
   `App.vue:536-537` 先改 `status.branch` 和分支树 current 标志，但 `run()`（App.vue:210-224）
   **只在成功时 refresh，失败只弹错误框**。checkout 失败后界面停留在假分支名。
   BTW.md 声称「失败自动回滚」与代码不符——疑似某次重构把 refresh 挪进 try 块引入的回归。
2. **历史范围切换有竞态**
   `App.vue:179-191` 的 `historyMode` watcher 没有 seq token（`activate()` 有）。
   切「当前/所有分支」后立刻切仓库，旧仓库请求后返回会覆盖新仓库的历史列表，
   loading 遮罩也会被提前关掉。
3. **git.rs 死代码**
   `git_status` 中 git.rs:77-90 的第一段 ahead 解析循环完全冗余，
   会被 git.rs:91-98 无条件覆盖。功能没错，但应清理。

### 行为不一致 / 体验问题

4. **刷新无互斥**——窗口聚焦和 F5 直接调 `refresh()`，不检查 `busy`，会与进行中的
   提交/推送并发拉数据（最终一致但会闪旧状态）；且快捷键 Ctrl+Tab 走 `activate()`
   绕过 `switchRepo` 的 busy 拦截——鼠标被拦、键盘不被拦。
5. **泳道连线颜色硬编码** `#3a4450`（HistoryGraph.vue:121），不吃主题 token，
   8 套主题下连线颜色不变。
6. **detached HEAD 状态栏显示原始串**「HEAD (no branch)」（git_status 的
   `split("...")` 解析粗糙）。

### 性能隐患（与「快」的定位相悖）

7. **历史列表无虚拟化**——滚动分页每页 300 条，DOM 行数无上限，且每行包一个
   Tooltip 组件实例。NOTES.md 已总结过「别逐行包组件」的教训（diff 场景已改原生
   title），历史行仍是组件方案。大仓库滚几页后会卡。DiffViewer 万行级 diff 也是全量渲染。

### 小问题

- settings.ts:48-51 用 `as Settings` 保留 4 个已废弃的历史字段（diffAddBg 等），类型上撒谎
- CSP 为 null 且 http/https 全放行——本地工具可接受，发布建议收紧
- ai.ts:116 注释引用的 `src/ai/skills/git-commit-message/SKILL.md` 路径在仓库中不存在
- 文档漂移：BUGS.md 说「搜索时改纯列表」，代码实际已升级为跨隐藏节点连线（代码比文档新）

## 四、总结与建议优先级

功能层面 0.1 版本已达到「日常可用」，文档质量是亮点。当前最大的短板：一是
tag/stash/amend 三个高频 Git 能力缺口，二是零测试、无 CI 的工程化空白。

建议动作排序：

1. 修本篇三（1）（2）两个真 Bug（分支切换不回滚、历史切换竞态）
2. 补一层组件测试兜底，再给 App.vue 拆 composables（useRepoTabs / useBranches / useAIReview）
3. 补 CI（vue-tsc + graph 自检 + cargo check 就够起步）
4. 需求池按 tag → stash → amend 顺序排期
