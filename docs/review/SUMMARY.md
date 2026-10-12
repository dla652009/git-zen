# git-zen 全面审查 · 总览与修复优先级

> 审查对象：git-zen v0.1.0（工作区 HEAD `06e4bcc`）
> 审查方式：4 个并行审查单元 **纯只读静态审查**（未启动应用、未截图、未修改任何源码），
> 辅以 `%TEMP%` 独立临时仓库对 git 2.47.1.windows.2 的行为实证。
> 全过程 `git status` 仅新增 `docs/review/`。

> **修复状态（后续更新）**：本文件记录的是**审查当时（HEAD `06e4bcc`）的发现**，保持原样不改写。
> 其中第一批 + 第二批已全部修完（含下方「建议的修复顺序」第 1–9 条），落地记录与根因见
> [docs/BUGS.md](../BUGS.md) 的「全面审查修复（M13）」与 [docs/TASKS.md](../TASKS.md) 的 M13 小节；
> 关键取舍记入 [docs/NOTES.md](../NOTES.md)。第三批（拆 `App.vue`、git 调用超时、弹层 dialog 语义）
> 按计划**留待单独排期**，故下面相关内容仍为未修状态。

## 分报告

| 报告 | 范围 | 规模 | P0 / P1 / P2 / P3 |
|---|---|---|---|
| [R1-backend.md](R1-backend.md) | `src-tauri/src/git.rs`、`lib.rs`、`main.rs`、`capabilities/` | 347 行 | 4 / 6 / 9 / 6 |
| [R2-frontend-arch.md](R2-frontend-arch.md) | `App.vue`、`gitApi.ts`、`ai.ts`、`workflow*.ts`、纯函数模块、全部组件 script | 1094 行 | 3 / 6 / 14 / 10 |
| [R3-ui-ux.md](R3-ui-ux.md) | `App.vue` template、`components/**`、`components/ui/**`、`style.css` | 437 行 | 3 / 7 / 8 / 一节 |
| [R4-features.md](R4-features.md) | README / TASKS / DESIGN / BTW / ANALYSIS / BUGS 对照代码 | 341 行 | 按功能分级，非 P 分级 |

---

## 一句话结论

**底子是好的，坏在「最后一公里」。** 类型纪律、命令注册、async+offload、主题 token 化、
虚拟滚动、diff 解析这些**需要功力的地方都做对了**；真正会伤到用户的问题集中在三类：

1. **异步时序没有「仓库身份」概念** —— 切仓库时旧请求返回会污染新仓库的视图**和 LRU 缓存**，
   极端情况下工作流会在**错误的仓库上 commit / push**。
2. **用户可控字符串直接当 git 位置参数** —— `git checkout -f` 能静默丢弃工作区改动，
   `--mirror` / `--force` 能把全部分支推上远程。属于数据丢失级。
3. **功能做了前半段，没接后半段** —— amend 做了但没有 force push；冲突提示「请去终端解决」
   但没有 `--abort` 出口；单文件暂存做了但只能 hover 才能点到。

---

## 健康面（先说不该动的）

避免误读成「一团糟」，以下经核实**确实做对了**，不要为了「重构」去动它们：

- 45 个 `#[tauri::command]` **全部已注册**，与 `lib.rs:10-54` 的 `generate_handler!` 一一对应，
  0 缺失 / 0 多余 / 0 重复 —— AGENTS.md 规则 1 当前未被违反。
- **45/45 全部 `async fn` + `offload()`**，无同步 command —— 规则 2 未被违反。
- 全项目 **0 处 `unwrap()/expect()/panic!`**（仅 `lib.rs:57` 启动期 `expect`，可接受）；
  **0 共享可变状态**（无 `static`/`Mutex`/`RwLock`）；**无 shell 拼接**；
  `CREATE_NO_WINDOW` 覆盖 **1/1**（全项目只有 `git.rs:4-30` 一个子进程创建点）。
- 前端类型纪律极强：`any` / `as any` / `@ts-ignore` / `@ts-expect-error` / `as unknown as`
  **全仓零命中**。
- `gitApi.ts` ↔ `git.rs` 的 9 个 serde struct **字段名 / 顺序 / 类型零漂移** —— 规则 3 当前未漂移。
- 虚拟滚动**真实生效**（不是摆设）；watch 链路**无自触发死循环**。
- 7 套主题全部走 CSS 变量 token（`style.css:5-160`），零 Tailwind 具名色，硬编码语义色仅 3 处；
  全局 `:focus-visible` 焦点环与 `prefers-reduced-motion` 降级都做了。

---

## P0 · 建议立刻修（8 条）

### 1. 跨仓库状态串台（数据错乱，触发路径 100% 可达）
**位置**：`src/App.vue:174-197`（`refresh`）、`src/App.vue:280-294`（`run()` 期间 `await refresh()`）、
触发点 `src/App.vue:1551` / `src/App.vue:1556`（Ctrl+Tab / Ctrl+1..9 **直接调 `activate()`，不检查 `busy`**）

`refresh()` 的四个 invoke 绑定「调用瞬间」的 `repo.value`，但赋值前**不做任何比对**：
```ts
// src/App.vue:182-193
const [s, l, b, tg] = await Promise.all([
  api.status(repo.value), fetchLog(0), api.branches(repo.value), api.tagList(repo.value),
]);
status.value = s; commits.value = l; branchList.value = b; tags.value = tg;
cachePut(repo.value, { status: s, commits: l, branchList: b, tags: tg }); // ← 用「当前」repo.value
```
「点 Pull → 立刻 Ctrl+Tab」即可复现：**A 仓库的数据被写进 B 的视图**，
且 `cachePut` 把 A 写进 B 的 LRU 槽位，切回 B 仍读出 A 的数据。

**同族问题**：`loadMorePage()` 无守卫（翻页结果 push 进另一个仓库的数组）；
工作流多步执行期间切仓库，**后续步骤会在错误的仓库上 commit / push**。

**最小修复**：`const path = repo.value` 快照 + 赋值前 `if (repo.value !== path) return`（各 1-2 行）。

### 2. `git checkout` 选项注入 → 静默丢弃工作区改动
**位置**：`src-tauri/src/git.rs:533` — `run(&repo, &["checkout", &name])`，`name` 无任何校验、无 `--`。

实测（git 2.47.1.windows.2）：工作区 `a.txt` 有未提交改动时执行 `git checkout -f`
→ **exit=0 静默成功**，未提交改动**永久丢失**。
`git update-ref refs/heads/-f HEAD` 实测 exit=0，可造出 `-` 开头的分支（从远端 fetch 也能带入）。

**最小修复**：`run(&repo, &["checkout", "--end-of-options", &name])`。
实测 `git checkout --end-of-options -f` → exit=1（选项被隔离），且正常切换分支无回归。

### 3. `git push` 可被 `--mirror` 注入 → 全量分支外泄
**位置**：`src-tauri/src/git.rs:518` — `run(&repo, &["push", "-u", "origin", &branch])`。

实测 `git push -u origin --mirror` 把**全部本地分支**推到远程。
同类：`git_merge`(`git.rs:570`)、`git_branch_delete`(`git.rs:552`)。

### 4. `run()` 失败时丢弃 stdout → 高频失败显示**空白错误框**
**位置**：`src-tauri/src/git.rs:22-29`
```rust
let out = cmd.output().map_err(|e| format!("无法启动 git: {e}"))?;
if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).into_owned()) }
else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }  // ← 只看 stderr
```
`git commit` 无内容、`git merge` 冲突这两类**最高频**失败的诊断信息都在 **stdout**，
stderr 为空 → 前端 `humanize()` 收到空串 → 用户看到完全空白的错误框。

**最小修复**：失败时优先 stderr，为空则回退 stdout。

### 5. `git tag_push` 的 tag 名可被当选项 → `--force` 强推覆盖远程
**位置**：`src-tauri/src/git.rs:908`。

### 6. 窗口标题功能因 ACL 未授权而**静默失效**
**位置**：`src/App.vue:3`（`import { getCurrentWindow }`）、`src/App.vue:202`
（`getCurrentWindow().setTitle(...)`）、`src/App.vue:204`（`watch(status, updateTitle)`）；
`src-tauri/capabilities/default.json:7` 只给了 `core:default`。

**取证**：`src-tauri/gen/schemas/desktop-schema.json` 中 `core:default` 展开为
`core:window:default`，而其包含清单为 `allow-title`（**读**标题）等 28 项，
**不含 `allow-set-title`（写标题）**；全仓 grep `allow-set-title` 在 `capabilities/` 下**零命中**。

**影响**：README 承诺的「窗口标题显示未推送数」从未生效，且每次 `status` 变化产生一个
**未捕获 promise rejection**（`watch(status, updateTitle)` 无 catch）。

**最小修复**：`capabilities/default.json` 的 `permissions` 加 `"core:window:allow-set-title"`，
并给 `updateTitle()` 加 `.catch(() => {})`。

### 7. 中文输入法（IME）守卫在组件级输入框**完全没有**
**位置**：全仓仅 2 处有 `isComposing` 守卫 —— `src/App.vue:1542`（全局快捷键）与
`src/components/ui/ContextMenu.vue:71`。

而 `src/App.vue` 有 **14 处**裸 `@keyup.enter` / `@keyup.esc`：
`2017`(新建分支)、`2070`/`2085`/`2086`(克隆)、`2126`/`2127`/`2133`(新建标签)、
`2496`/`2497`(分组)、`2566`/`2567`(重命名)、`2588`/`2589`(分支重命名)、`2663`(工作流)。

**为什么 `keyup` 是坑**：Chromium 中确认候选词的那次 `keyup` 里组合态**已经结束**
（`isComposing === false`），所以守卫必须落在事件处理里、且要以 `keydown` 为准。

**影响**（对一个中文 Git 客户端是高频伤害）：输入分支名 / 标签名时按 Enter 选词
→ **静默创建分支/标签**、误关填了一半的弹窗。

**最小修复**：统一改为 `@keydown.enter` + `if (e.isComposing) return`，
或抽一个 `useImeGuard()` 组合式函数。

### 8. 重命名文件在「暂存 / 取消暂存 / 丢弃」三处传了整串 `"old -> new"`
**位置**：`src/components/ChangesPanel.vue`
- 已正确拆分：`248`（commit pathspec）、`296`（看 diff）、`379-380`（文件历史）
- **未拆分**：`282`（批量取消暂存 `staged.map(f => f.path)`）、`312`（单文件取消暂存）、
  `330`（批量暂存）、`366`（单文件暂存）、`396`（丢弃 `path: fileCtx!.f.path`）

porcelain 对重命名给出的是 `"old -> new"` **整串**，
`renameParts()`（`ChangesPanel.vue:189-192`）就是为此写的 ——
**作者知道这个格式，却漏了三个操作入口**，是内部不一致的确证。

**影响**：重命名过的文件无法暂存 / 取消暂存 / 丢弃，报的是 git 的 pathspec 错误。

---

## 高危 · 功能「断头路」（R4 核心发现）

**做了一半的功能比没做更危险**，因为用户会自然而然地走进去然后受损：

| # | 断头路 | 现状 | 后果 |
|---|---|---|---|
| 1 | **amend 没有配套 force push** | amend / 撤销上次提交都实现了，但全产品**零 force push 能力**（`git.rs` 里除 `git_branch_delete` 的 `-D` 外无任何 `force`/`mirror`） | 改完历史必然被远程拒绝；而 `humanize()` 把 `non-fast-forward` 映射成「先 Pull 再 Push」，**诱导用户把远端旧提交合回来，造出多余的分叉 commit** |
| 2 | **冲突把用户踢出应用** | `src/App.vue:95` 只给「请在终端解决后再试」，连 `merge --abort` 都没有出口 | 用户卡死在冲突态。而 `isUnmerged` / combined diff / AI 解读这些**前置资产已齐备**，只差一个出口 |
| 3 | **打开仓库不校验目录** | `openRepo()` 直接 `addRepo` 落库 | 选错目录得到**永久坏选项卡**；同时完全没有 `git init`，新项目无路可走。拖拽入口有校验 —— **两条路径行为不一致** |
| 4 | **单文件暂存只能 hover** | 暂存/取消暂存/stash 是 `opacity-0` 的裸 `<svg>`，仅 hover 时出现 | 键盘与触屏用户**根本做不了单文件暂存** |

---

## 其余值得排期的问题（摘要）

**后端**
- **所有 git 子进程无超时**（`git.rs:22-24` 用 `cmd.output()`，`Cargo.toml` 无 `wait-timeout`）：
  `fetch/pull/clone` 网络挂起或凭据交互时**无限阻塞**，`spawn_blocking` 线程池被占满后整个后端退化。
- 路径类参数无校验，`..` 与绝对路径可越出仓库（读/写/删三处）。
- `git_ignore_add` 对非法 UTF-8 的 `.gitignore` 会**静默清空整个文件**。
- `git_config_user` 无 `--` 分隔，可把 `--global`/`--unset` 写成配置值。
- `git_status` 的 ahead/behind 有两套并存解析，第一套（`git.rs:77-90`）是**死逻辑**。
- 空仓库 / detached HEAD 时 `branch` 字段被污染成提示语句。

**前端**
- **无任何契约测试守护 `gitApi.ts` ↔ `git.rs` 的人工镜像** —— 当前一致，但机制脆弱。
- `App.vue` 应拆：**101 个顶层函数 / 1108 行函数体**挤在 1617 行 `<script setup>`；
  `closeTopOverlay()` 靠 18 行手写 if 链维护浮层优先级（新增弹窗就可能忘加一行）。
- localStorage 的 `JSON.parse` 无保护，坏数据直接**白屏**；全局无
  `app.config.errorHandler` / `unhandledrejection` 兜底。
- `ai.ts` **无取消机制**：关闭弹窗后请求继续跑满 30s，`TIMEOUT_MS` 只是标志位；
  `clipForAI()` 按 UTF-16 code unit 硬切 16KB，会**切在 hunk 中间**并可能劈开代理对。
- `Md.vue` 用 `v-html` 渲染 AI 输出，且应用**未设 CSP**。
- `remoteNodes()` 在模板里直接调用，每次重渲染全量重建分支树；
  `syncBar()` 每次深变做两次全量 `JSON.stringify`，叠加 3 个 deep watcher。
- `vite.config.js` 无 `build` 配置：**单 chunk 450 KB**、无 sourcemap、无 target。

**UI / 交互**
- **危险等级与防护强度是反着来的**：「关闭仓库选项卡 / 关闭其他」标了 `danger: true` 却**不弹确认**，
  而非破坏性的「合并分支」反而要确认框。
- 「恢复并删除 Stash（pop）」**无二次确认**（丢失 stash 记录）；「移除分组成员」无确认；「删除工作流」只有两段式按钮。
- **19 个弹层**没有 `role="dialog"` / `aria-modal` / focus trap / 关闭后焦点归位，
  Tab 会穿透到遮罩背后 —— 键盘用户在危险确认框里 Tab + 回车可能触发**背后**的元素。
- 文档承诺与实现不符：README 与设置里都写「**双击**分支切换」，代码是**单击**。
- 对比度：`catppuccin-latte` 有 **10 项**不达标；**所有主题的 Badge 半透明底全部不达标**。
- `HistoryGraph` 逐行使用 `ui/Tooltip`，违反项目自己在 AGENTS.md 里写下的性能约定。
- 响应式：最小窗口 860px 下左右侧栏已占 61%，拖宽上限不考虑窗口宽度。
- 中文标题配 `uppercase tracking-wider`（16 处做了无意义的事）；弹窗宽度 10 档、字号 8 档无统一尺度。

**文档纪律**
- README 对 **M9–M12 四个里程碑零提及**（`stash` / `工作流` / `克隆` / `tag` 全部 grep=0 命中）
  —— 用户对四个里程碑的工作**完全不可见**。
- `ANALYSIS.md` 记录的 3 个真 Bug 经今日复核**全部仍然存在**，却从未进入 `BUGS.md`
  —— `BUGS.md` 已失效为单一事实源。

---

## 建议的修复顺序

**第一批（半天，全是最小改动、收益最大）**
1. `refresh()` / `loadMorePage()` / `execStep()` 加仓库身份守卫（各 1-2 行）
2. `git.rs` 失败时回退 stdout（1 行）+ `--end-of-options` 隔离位置参数
3. `capabilities/default.json` 补 `core:window:allow-set-title`（1 行）
4. `ChangesPanel.vue` 五处 path 补 `.split(" -> ").pop()`
5. IME 守卫统一到 `@keydown` + `isComposing`

**第二批（1-2 天，把断头路接上）**
6. 补 `push --force-with-lease`（让 amend 闭环）
7. 补 `merge --abort` 出口 + 冲突态 UI
8. `openRepo()` 校验 `git rev-parse`，加 `git init` 入口
9. 单文件暂存改成常显按钮（不再 hover-only）

**第三批（结构性与打磨，需单独排期）**
10. 拆 `App.vue`（优先抽 4 个 composable）
11. git 调用加超时
12. 弹层补 dialog 语义 + focus trap
13. 更新 README / BUGS.md 的文档纪律

---

## Lead 独立核实清单

以下结论由 Lead **亲自复核代码或取证**，非仅采信子报告：

| 结论 | 核实方式 |
|---|---|
| `refresh()` 无仓库身份守卫 | 读 `src/App.vue:174-197`，确认赋值前无 `repo.value` 比对 |
| Ctrl+Tab / Ctrl+1..9 绕过 `busy` | 读 `src/App.vue:1551` 与 `src/App.vue:1556`，确认直接调 `activate()` |
| `run()` 丢弃 stdout | 读 `src-tauri/src/git.rs:22-29` |
| `git_checkout` / `git_push` 未隔离位置参数 | 读 `src-tauri/src/git.rs:533` 与 `src-tauri/src/git.rs:518` |
| `CREATE_NO_WINDOW` 已覆盖 | 读 `src-tauri/src/git.rs:15-20` |
| **窗口标题 ACL 未授权** | 从 `src-tauri/gen/schemas/desktop-schema.json` 取出 `core:window:default` 的展开清单，确认只有 `allow-title`（读）而无 `allow-set-title`（写）；并全仓 grep 确认 `capabilities/` 下零授权 |
| **IME 守卫覆盖不全** | grep `isComposing` 全仓仅 2 命中；grep `@key(up\|down)` 列出 14 处无守卫绑定 |
| **重命名 path 内部不一致** | grep `" -> "` 确认 `248`/`296`/`379-380` 已拆分，`282`/`312`/`330`/`366`/`396` 未拆分 |
| **全产品零 force push** | grep `src-tauri/src/git.rs` 的 `force\|--mirror`，仅命中 `git_branch_delete` 的 `-D` |

---

## 后续

本次审查**全程只读，未修改任何源码**（`git status` 仅新增 `docs/review/`）。
是否修复、修哪几条、按什么顺序 —— 等确认后再动。按 AGENTS.md 的约定，
任何修复都应回写 `docs/BUGS.md`（含根因），新决策进 `docs/NOTES.md`。
