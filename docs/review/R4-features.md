# R4 功能完整性与需求缺口审查

> 审查对象：git-zen v0.1.0（`E:\yoga app\ans\git-zen`）
> 方法：只读审查。后端以 `src-tauri/src/git.rs`（1051 行、45 个 `#[tauri::command]`，脚本核对 `lib.rs` 注册表 `missing_in_lib` 为空）为准；前端以 `src/App.vue`（2798 行）及各组件入口为准；文档以 README / TASKS / DESIGN / BUGS / ANALYSIS / BTW 为准。
> 竞品列基于各产品公开功能集的常识判断（版本/版本档位可能不同），**git-zen 列全部经源码核实**。

---

## 总体结论

功能完成度**远超其自称的「核心四件套」**：M1–M12 全部里程碑关闭，45 个后端命令、stash 暂存架、tag 管理、amend/撤销提交、cherry-pick、克隆、.gitignore 追加、逐行 blame、虚拟滚动、7 原语工作流引擎都已落地，工程实现质量在同规模个人项目里属上游（异步 offload、防别名劫持、porcelain 解析、纯函数自检三者齐备）。真正的问题不在「做得少」，而在**三条已经铺好路却没修完的断头路**：① `amend` / 「撤销上次提交」已实现，但整个产品**没有强制推送**，改完历史必然被远程拒绝，而错误提示「先 Pull 再 Push」还会把用户引向制造成叉的更坏方向；② `merge` / `rebase` 场景的**冲突解决只能把用户踢回终端**，这是唯一会让高频工作流中断出应用的场景；③ **没有 `git init`，且「打开仓库」这条入口不校验目录**，新项目起步无路可走，选错目录还会污染仓库选项卡列表。其次才是文档债：README 的功能章节停留在 M8 时代（stash / tag / amend / 克隆 / 工作流 / cherry-pick 全部零提及，快捷键表把「单击切换分支」写成「双击」），DESIGN 与 ANALYSIS 的命令数、行数、目录结构均已过期。最后，欠缺的通用能力集中在**批量操作（多选暂存）、远程管理（多 remote / remote 增删改）、安全网（reset 模式选择 / reflog）**三处。

**最该补的三个功能缺口（优先级从高到低）**

1. **强制推送 `--force-with-lease`**（工作量 S）—— 让 amend / 撤销提交这条已实现的功能链闭环，否则它是个陷阱而非功能。
2. **冲突解决最小闭环**（工作量 L）—— 冲突文件列表 + ours/theirs/标记已解决 + `--continue` / `--abort`，避免把用户踢出应用。
3. **仓库接入引导：`git init` + 打开入口的目录校验 + git 环境检测**（工作量 S）—— 首程与新项目起步的必经之路。

---

## 一、文档-代码一致性差异表

### A. README 声称「有」，代码实际「没有 / 不一样」（伤信任的一类）

| # | 文档位置 | 文档原文（摘要） | 代码实际 | 严重度 |
|---|---|---|---|---|
| A1 | README.md:103 | `src-tauri/src/git.rs # 全部后端逻辑：22 个命令，一个命令一次 git CLI` | **45 个** `#[tauri::command]`（脚本从 `git.rs` 提取函数名与 `lib.rs` 注册表逐一比对，无缺漏）；`docs/ANALYSIS.md` 里写的「26 个命令」同样过期 | 低（数字错，但暴露文档未随功能更新） |
| A2 | README.md 快捷键表 | 「双击分支 \| 切换 / 建立跟踪分支」 | **单击**切换。`BranchTree.vue:58` 叶子节点是 `@click="!n.branch!.current && emit('switch', n.branch!)"`，M11.0 起改为「左侧栏单击切换分支」（`docs/TASKS.md:258`）| 中——用户按文档双击会切换两次分支再切回来，表现为「点了没反应」 |
| A3 | README.md 快捷键表 | 「双击历史行 / 文件 \| 查看 commit diff / 文件变更历史」 | 历史行与文件行都是**单击选中、单击同一行才打开 diff**（`HistoryGraph.vue:47-50` 的 `onRowClick` 二次点击判定；`ChangesPanel.vue:135-138` 同款）；「文件变更历史」**不是双击**，而是右键菜单项（`ChangesPanel.vue:379`）| 中——入口描述错误，用户找不到文件历史 |
| A4 | README.md 快捷键表 | 只列 Ctrl+P / Ctrl+Tab / Ctrl+1..9 / F5 / Ctrl+Enter / 双击… / Esc | 代码另有 **Ctrl+B**（分支快速切换器，`App.vue:1561`）、**Ctrl+Shift+L / Ctrl+Shift+R**（折叠左右侧栏，`App.vue:1513`）。`SettingsModal.vue:183-192` 的快捷键页同样只列 8 条，缺这两组 | 中——功能存在但完全不可发现，等于没有 |
| A5 | README.md 功能章节 | 未提及 stash / tag / amend / 撤销提交 / cherry-pick / revert / 克隆 / 工作流 / 右键加入 .gitignore / AI Release Notes / AI 冲突解读 / 导出 .patch / 折行开关 / 历史按文件过滤 | 全部已实现（详见下方 B 表）。grep 证据：README 中 `stash`=0、`工作流`=0、`克隆`=0、`标签`=0、`amend`=0、`cherry`=0、`ignore`=0、`revert`=0、`Release Notes`=0 | **高**——README 是用户唯一的功能发现渠道，M9–M12 四个里程碑的工作对用户不可见 |
| A6 | README.md 快捷键表 | 「Ctrl+P 切换器（**模糊搜索** + 最近使用排序）」；分支树也写「模糊搜索」 | 都是**子串匹配**：`App.vue` 的 `matchBranches` 用 `b.name.toLowerCase().includes(q)`，切换器 `switcherResults` 用 `r.name/path.toLowerCase().includes(q)`（有前缀优先 + MRU 排序）。无模糊/拼写容错 | 低——措辞夸大 |
| A7 | README.md「已知限制」 | 「冲突解决引导至终端处理（GUI 冲突编辑不在路线图内）」 | **与代码一致**（`App.vue:95` humanize `/conflict/` → 「产生合并冲突，请在终端解决后再试」）✓。但 README 同时漏了这个能力：`isUnmerged()` 识别 UU/AA/DD/AU/UA/DU/UD（`ChangesPanel.vue:164-170`）+ combined diff 琥珀色高亮 + `AI_PROMPTS.conflictExplain` 只读解读 | 低——文档比代码保守，不算吹牛但低估了自己 |

### B. 代码已实现、文档完全没写（反向差异）

| # | 已实现能力 | 代码位置 | 应补文档 |
|---|---|---|---|
| B1 | **Stash 暂存架**（list/push 含 `-u`/apply/pop/drop） | `git.rs` 四个命令 + `ChangesPanel.vue:497-578`（Archive 下拉、备注、包含未跟踪勾选、三条记录操作） | README 功能章节 |
| B2 | **Tag 管理**（创建轻量/附注、删除、推单个、列表走 for-each-ref） | `git.rs` 四个命令 + `App.vue:1077-1084` 标签右键菜单 + 标签组头菜单 | README |
| B3 | **amend 追加到上次提交 / 撤销上次提交**（`reset --soft HEAD~1`，根提交禁用） | `git.rs` `git_amend` / `git_undo_commit` + `ChangesPanel.vue:457-476`（两个图标，`commitCount` 门槛） | README |
| B4 | **cherry-pick**（单提交，含「空拣选」humanize 文案） | `git.rs:963` + `App.vue:2149-2187` 历史行右键 | README |
| B5 | **revert 反向提交** | `git.rs:371` + 历史行右键 | README |
| B6 | **从远程克隆**（URL + 目录名从 URL 推断 + 选位置 + 进行中 Esc 保护） | `git.rs:917` + `App.vue` 打开弹窗第二 tab | README 快速开始 |
| B7 | **M12 工作流**（7 原语 + 设置页步骤卡管理 + 2 个种子模板 + 工具栏一键执行 + 进度弹窗） | `src/workflow.ts` / `workflowStore.ts` / `SettingsModal.vue` workflow 页 / `App.vue:1193-1323` | README（这是产品差异化最大的功能，却零提及） |
| B8 | **右键「加入 .gitignore」** | `git.rs:940` + `ChangesPanel.vue:384` | README |
| B9 | **AI Release Notes**（`git_commits_range` + `git_latest_tag` + `releaseNotes` 提示词，打开即自动生成、可存本地） | `App.vue:912` + 标签组头菜单 | README AI 章节 |
| B10 | **AI 冲突解读**（`conflictExplain`） | `DiffViewer.vue:101` | README AI 章节 |
| B11 | **diff 导出 .patch / 折行开关 / 行号栏 / 选中复制** | `DiffViewer.vue:268-284`（`gz.diffWrap`、导出按钮） | README 效率章节（README 只提了双栏与 blame） |
| B12 | **提交热力图** | 已在 README ✓ | —（此项文档已覆盖，列出以说明并非全漏） |

### C. 设计/分析文档过期（不影响用户，但误导后续开发者）

| # | 文档 | 过期内容 | 实际 |
|---|---|---|---|
| C1 | `DESIGN.md:100-107` §4.5 | 「rebase / cherry-pick 交互 UI → 终端更顺手」列为不做 | **cherry-pick 已在 M10.1 实现**（`git.rs:963`、历史行右键）。该条只剩 rebase 部分成立 |
| C2 | `DESIGN.md:32-62` §3 架构图 | 仍列 `ai_stream`（已在 M6.3 回退）、`ChangesPanel` 重复出现两次、缺 M9–M12 的全部命令 | 45 个命令，`ai_stream` 不存在（`BUGS.md:21` 记录了回退） |
| C3 | `DESIGN.md:109-129` §5 目录结构 | 只列到 `BranchTree.vue / SettingsModal.vue`；`ui/` 只列 Button/Badge/Input/Textarea/Tooltip/Spinner | 缺 `ai.ts`、`settings.ts`、`workflow.ts`、`workflowStore.ts`、`CommitHeatmap.vue`、`FileHistoryModal.vue`、`lib/patch.ts`、`ui/ContextMenu.vue`、`ui/Toast.vue`、`ui/Md.vue`、`ui/Select.vue`、`ui/Switch.vue` |
| C4 | `ANALYSIS.md`（2026-09-03） | 「M1–M7 全部完成」「约 4300 行」「git.rs 的 26 个命令」「App.vue 1162 行状态中枢」 | M1–**M12** 全部完成；`src/` 下 `.vue`+`.ts` 合计 **6179 行**；**45 个命令**；`App.vue` **2798 行** |
| C5 | `ANALYSIS.md`「缺少的功能」 | 列 Tag 无支持 / 无 Stash / 无 Amend / 无 cherry-pick / 无 .gitignore / 无多 remote | 前 5 项**均已实现**（M9/M10）；只剩「多 remote」成立 |
| C6 | `ANALYSIS.md` 记录的 3 个真 Bug | ① 切换分支乐观更新失败不回滚 ② 历史范围切换竞态 ③ `git_status` ahead 解析死代码 | **复核后三项全部仍然存在**：① `App.vue` `switchBranch` 的 `doSwitch` 先写 `status.branch` 与 `branchList.current`，再 `await run(doSwitch)`，而 `run()` 的 catch 只 `showError` 不回滚；② `App.vue:249-261` 的 `watch([historyMode, historyFilePath])` 确实无 seq token（`activate()` 有）；③ `git.rs:71-90` 的 ahead 解析循环被 `git.rs:91-98` 无条件覆盖 |
| C7 | `BUGS.md` 全表 | 153 行全部标记 `[x]` 已修复 | 但 C6 的三个真 Bug **未收录进 BUGS.md**，且 `HistoryGraph.vue:183` 的泳道连线 `stroke="#3a4450"` 硬编码（不吃主题 token）、detached HEAD 状态下 `status.branch` 显示 `HEAD (no branch)` 原始串，也都不在 BUGS.md 中。文档纪律要求「修完 bug 更新 BUGS.md」，当前存在**已知问题只活在 ANALYSIS.md 里**的断层 |

---

## 二、TASKS.md 需求池盘点

`docs/TASKS.md:383-417` 的需求池共 **11 条未做项**，另有 `:341-344` 的「观察后推迟」4 条。全文 `[ ]` 待做与 `[~]` 进行中计数为 **0**，所有里程碑已关闭。分类如下（价值 = 目标用户会主动去找的程度）：

| 需求池项 | 用户价值 | 成本 | 风险 | 备注 |
|---|---|---|---|---|
| 多 remote 支持（push/pull 可选 remote） | **高** | M | 中 | 现在 `git_push` 无上游时写死 `push -u origin`、`git_pull` 无参、`git_tag_push` 写死 origin。fork 协作（origin+upstream）完全没法用 |
| tag 补全（重命名 / `--tags` 全推 / 删远程同名标签） | 中 | S | 低 | 现有 4 个命令已覆盖 80%，补 3 个动作即可 |
| blame 独立视图 | 中 | M | 低 | `git_blame` 命令已存在且被 DiffViewer 使用；独立视图是纯前端工作 |
| worktree 支持（列出/切换工作树） | 低 | M | 中 | 与「单窗口 + 选项卡」定位有张力，会让仓库模型复杂化 |
| 文件列表目录树/平铺双视图 | 中 | M | 低 | 大仓库（改动 200+ 文件）才痛 |
| 拖拽文件到暂存区批量 stage | 中 | S | 低 | 与「多选暂存」是同一诉求的两种形态，建议一起做 |
| AI 从 CONTRIBUTING.md 学习提交规范 | 中 | S | 低 | 提示词工程 + 读一个文件，成本极低收益明确 |
| AI 总结单文件演进历史 | 中 | S | 低 | 复用 `FileHistoryModal` + 现有讲解提示词 |
| i18n 英文界面 | 中 | L | 中 | 全量中文文案搬迁，收益取决于是否出海 |
| 自定义主题色（目前固定紫罗兰） | 低 | S | 低 | 纯偏好 |
| GitHub/GitLab 集成（PR 列表、CI 徽标） | 中 | L | **高** | 需 token 管理 + 两家 API + 限流处理，与「轻」定位冲突最大 |
| ——观察后推迟—— | | | | |
| diff 语法高亮 | 中 | M | 中 | 大 diff 性能风险，需选型 |
| 图片 diff 预览 | 中 | M | 低 | 设计稿/图标仓库会用到 |
| 选项卡脏标记（需后台轮询全部仓库） | 低 | M | 中 | **与 DESIGN 4.5「不做自动轮询」直接矛盾**，先要决策定位 |
| UI 整体缩放 | 低 | S | 低 | WebView 已支持 Ctrl+滚轮缩放，边际收益低 |

**需求池之外、审查中新发现的缺口**（文档里根本没有，见第四节矩阵）：强制推送、冲突解决动作、`git init`、多选批量暂存、reset 模式三选一、reflog 查看、remote 增删改、.gitignore 编辑器、全文件 blame 独立入口、工作流导入导出。

---

## 三、Top 10 功能建议

| # | 功能 | 用户价值 | 工作量 | 理由（谁在什么场景用） | 优先级 |
|---|---|---|---|---|---|
| 1 | **强制推送 `--force-with-lease`**（amend / 撤销提交后的推送路径） | **高** | **S** | 「刚提交错了 → amend 改一下 → 推上去」是高频动作，产品已经把前两步做完了，第三步必然失败：远程拒绝 `non-fast-forward`，而 humanize 给出「远程有新提交，先 Pull 再 Push」——用户照做会把远端旧提交合回来，制造一个分叉 commit，问题从「改一条信息」升级成「收拾历史」。**这是已实现功能链的断头路，也是当前最可能造成真实数据混乱的缺陷**。改动 = `git_push` 加 `force: bool` 参数 + 上游确认框（默认 `--force-with-lease`，不提供裸 `--force`）| **P0** |
| 2 | **冲突解决最小闭环** | **高** | L | merge / pull / cherry-pick / 工作流遇到冲突时，用户被 `「请在终端解决后再试」` 直接踢出应用，且**解决完还得回来看状态**。最小闭环 = 冲突文件列表 + 「用我的 / 用他的 / 手工编辑」+ `git add` 标记已解决 + `merge --continue` / `--abort`。前置资产已齐：`isUnmerged()` 状态识别、combined diff 渲染、琥珀色冲突标记高亮、AI 冲突解读。做与不做，决定这个软件能否被称为「可日常使用的 Git 客户端」 | **P0** |
| 3 | **仓库接入引导：`git init` + 打开入口校验 + git 环境检测** | **高** | **S** | 三处首程硬摩擦（详见第八节）：① 用户选了一个本地目录（还不是仓库）只能看到报错，没有「在这里初始化仓库」的出路——而「新项目起步」是 Git 客户端最典型的首次使用场景；② `openRepo()`（`App.vue:311-315`）**不调 `checkRepo`** 就 `addRepo + switchRepo`，选错目录会得到一个持久化进 `gz.repos` 的坏选项卡，每次点击都弹「所选目录不是 Git 仓库」，只能手动关闭（拖拽入口 `openDropped` 反而有校验，两条路径行为不一致）；③ 全应用**无 git 可用性检测**，系统未装 git 时第一次操作才报 `无法启动 git: {os error}`，且无 humanize 规则，用户看到原始英文系统错误 | **P0** |
| 4 | **多选批量暂存 + 拖拽文件到暂存区** | **高** | M | `ChangesPanel.vue` 的文件行只有「单击选中（用于二次点击打开 diff）」语义，**没有任何 checkbox / Shift 范围选择 / `selectedPaths`**（grep 全组件只有 `pushAfterCommit` 与 `stashUntracked` 两个原生 checkbox）。改 10 个文件只提交其中 3 个，现在必须点 3 次单文件 hover 图标；改 50 个文件时「全部暂存」会连不该提交的一起带上。竞品在这一项上全部支持 | **P1** |
| 5 | **多 remote 支持 + remote 增删改** | 中 | M | 参与开源项目（`origin`=自己的 fork，`upstream`=主仓）是 Git 用户的主流场景之一，当前 `git_push` 无上游时写死 `push -u origin`、`git_pull` 无参、`git_tag_push` 写死 origin、`git_remote_url` 只读 `origin`；唯一接受 remote 参数的是 `git_push_delete`。设置页那个「远程」页签实际是**仓库网页链接**（`gz.remoteLinks`），不是 remote 管理，容易误解 | **P1** |
| 6 | **reset 模式选择（soft / mixed / hard）+ 目标提交** | 中 | **S** | 「刚才那次提交要拆开 / 提交信息写错了想重来」的通用出口。现在只有两个硬编码场景：`git_reset_unpushed`（`reset --hard @{upstream}`，放弃未推送提交）与 `git_undo_commit`（`reset --soft HEAD~1`，仅限最后一次）。想回退到「倒数第三次」完全无路。UI = 历史行右键「重置到此处」+ 三选一 + 危险确认，后端一个带 `mode` 参数的命令 | **P1** |
| 7 | **工作流增强：导入导出/分享 + commitPush 提交信息预览 + 单步跳过/重试** | 中 | S–M | 工作流是产品唯一的差异化功能，但：不能导出就无法沉淀为团队资产、换机即丢失（只存 `gz.workflows` localStorage）；`commitPush` 步骤是**全产品唯一「AI 生成后不经人工确认直接 commit + push」的路径**（`App.vue:1312` 附近），一旦生成错误信息就直接推到远程，而工作流确认框只展示人话步骤描述、不展示将生成的提交信息；出错即停后没有任何「跳过这一步继续 / 只重试这一步」的补救。三项都是小改动 | **P1** |
| 8 | **全文件 blame 独立视图** | 中 | M | 后端 `git_blame` 早已实现，DiffViewer 内的逐行归属只是 `title` tooltip（`tipFor()`），且只覆盖当前 diff 涉及的**变更行/上下文行**，看不到整个文件的作者分布。「这行是谁写的、什么时候改的、为什么」是代码考古的常规需求，且无需任何新 Rust 代码 | **P2** |
| 9 | **tag 补全 + tag 成为工作流原语** | 中 | **S** | 三个小动作（重命名、`push --tags`、`push origin :refs/tags/`）就能补齐 tag 管理。更重要的是：**「发布流程」的语义终点是打 tag + 推 tag**，工作流现在做得到「合并到 release/dev + 推送」，却打不了 tag，所以「发布」仍然必须去终端收尾 | **P2** |
| 10 | **.gitignore 编辑器** | 中 | S | 现在只有右键「加入 .gitignore」（`git_ignore_add` 追加一行，已存在则跳过）。但真实场景是：克隆来的项目要加 `node_modules/`、`dist/`、`.env`，或者写错了要删/改一条规则——都需要看到并编辑文件内容。可在设置或仓库菜单加一个极简文本编辑器（复用 `git_write_file` 和现成 Textarea） | **P2** |

> **不建议近期做**：LFS（低频且与「轻」冲突）、submodule（低频，UI 成本远高于收益）、bisect（低频，用 `git bisect` 终端更自然）、SSH key 管理（当前「复用系统 git 配置」正是卖点，做了反而制造两套凭据）、Git Flow（工作流引擎已能自定义近似）、多窗口（DESIGN 4.5 的理由成立，见第七节）。

---

## 四、竞品功能对比矩阵

图例：✅ 完整支持 · 🟡 部分支持/有替代路径 · ❌ 无 · 频率为该功能在「日常使用 Git 的开发者」中的使用频度。

| # | 功能点 | 频率 | **git-zen**（源码核实） | SourceTree | Fork | GitKraken | GitHub Desktop | lazygit | Tower |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **stash 管理** | 日常高频 | 🟡 list/push(`-u`)/apply/pop/drop 齐备；**无 stash diff 预览、无重命名、无按文件部分恢复**（`git.rs` 4 命令；`ChangesPanel.vue:497-578`）| ✅ | ✅ | ✅ | 🟡（仅 stash/unstash 全部，无列表管理）| ✅ | ✅ |
| 2 | **rebase（普通）** | 日常高频 | ❌ 零支持（`git.rs` 无 rebase 命令；DESIGN 4.5 明确不做）| ✅ | ✅ | ✅ | ✅（限交互式）| ✅ | ✅ |
| 3 | **rebase（交互式 squash/reword/drop）** | 中频 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 4 | **cherry-pick** | 中频 | ✅ 单提交，历史行右键（`git.rs:963`，含「空拣选」humanize）| ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 5 | **tag 管理** | 中频 | 🟡 列表/创建(轻量+附注)/删除/推单个；**无重命名、无 `--tags` 全推、无删远程标签** | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ |
| 6 | **submodule** | 低频 | ❌ 零支持 | ✅ | ✅ | ✅ | 🟡（只提示不操作）| ✅ | ✅ |
| 7 | **worktree** | 低频 | ❌（需求池 `TASKS.md:405`）| 🟡 | ✅ | ✅ | ❌ | ✅ | 🟡 |
| 8 | **全文件 blame** | 中频 | 🟡 仅 diff 视图内逐行 `title` 归属（`DiffViewer.vue:209-227`），**无独立全文件视图、无按行跳转历史** | ✅ | ✅ | ✅ | 🟡（跳 GitHub 网页）| ✅ | ✅ |
| 9 | **多选批量暂存** | 日常高频 | ❌ 只有「单文件 hover 图标」与「全部暂存 / 全部取消暂存」（grep 无 checkbox/Shift 选择/`selectedPaths`）| ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 10 | **commit --amend** | 日常高频 | ✅（`git.rs:667`，`--no-edit` 与改信息两态，防别名劫持；`ChangesPanel.vue:457`）| ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 11 | **reset 模式选择（soft/mixed/hard）** | 中频 | ❌ 仅两个硬编码场景（`reset --hard @{upstream}` 放弃未推送、`reset --soft HEAD~1` 撤销上次提交），**无用户可选模式、无任意目标提交** | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ |
| 12 | **冲突解决 UI** | 日常高频 | ❌ 仅识别未合并状态 + 只读 combined diff + 琥珀高亮 + AI 解读；**无 ours/theirs、无标记已解决、无 `--continue`/`--abort`**，humanize 直接引导去终端（`App.vue:95`）| ✅ | ✅ | ✅ | 🟡（引导换编辑器/终端）| ✅ | ✅ |
| 13 | **.gitignore 编辑** | 中频 | 🟡 仅「加入 .gitignore」追加单行（`git.rs:940`，已存在则跳过）；**无查看/编辑/删除规则** | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ |
| 14 | **仓库初始化 / 克隆引导** | 日常高频（首程）| 🟡 **克隆 ✅**（URL + 目录名自动推断 + 选位置 + 进行中保护，`git.rs:917`）；**init ❌ 完全没有**，且「打开仓库」入口不校验目录（`App.vue:311-315`）| ✅ | ✅ | ✅ | ✅ | 🟡（CLI 风格）| ✅ |
| 15 | **远程管理（增删改 remote）** | 中频 | ❌ 只有 `remote get-url origin` 只读（`git.rs:459`）+ 设置页「远程」实为仓库网页链接（`gz.remoteLinks`）；`git_push_delete` 是唯一带 remote 参数的命令 | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ |
| 16 | **SSH key 管理** | 低频 | ❌ 有意不做：复用系统 git / credential helper / ssh-agent（README「为什么做这个」+ DESIGN 技术选型）。**这是定位选择而非缺口** | ✅ | ✅ | ✅ | 🟡 | ❌ | ✅ |
| 17 | **LFS** | 低频 | ❌ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ✅ |
| 18 | **Git Flow** | 低频 | ❌ 无内置 flow 命令；**但工作流引擎可自定义近似**（种子模板「发布到 dev」即 dev 流的一部分）| ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| 19 | **partial staging（按 hunk / 按行）** | 中频 | ❌ **已实现后按用户反馈移除**（M10.1：`git_apply_hunks`/`run_stdin` 与 DiffViewer hunk 按钮已回退，需求由终端 `git add -p` 承接）。这是**有意的产品取舍**，但对从竞品迁移来的用户是明确落差 | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ |
| 20 | **reflog 查看** | 低频 | ❌（无任何 reflog 命令；仅在注释中提到）| 🟡 | ✅ | ✅ | ❌ | ✅ | 🟡 |
| 21 | **bisect** | 低频 | ❌ | ✅ | 🟡 | ✅ | ❌ | ❌ | ✅ |
| 22 | **强制推送（`--force-with-lease`）** | 日常高频 | ❌ **完全无 force 能力**（`git_push` 只有 `push` 与 `push -u origin <branch>` 两条路径）；而 amend / 撤销提交已实现 → **功能链断头** | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ |
| 23 | **多 remote 支持** | 中频 | ❌ push/pull/tag push 写死 origin | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ |
| 24 | **多仓库选项卡 + 切换器** | 日常高频 | ✅ **强于多数竞品**：LRU 缓存容量可调（默认 5）、书签文件夹式选项卡分组、Ctrl+P 模糊切换器 + MRU 排序、Ctrl+1..9、Ctrl+Tab 循环 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ✅ |
| 25 | **多步流程一键执行（工作流）** | 中频 | ✅ **差异化能力**：7 原语、设置页步骤卡管理、种子模板、进度弹窗；但不可导入导出、无预览、无回滚 | ❌ | ❌ | 🟡 | ❌ | ❌ | 🟡 |
| 26 | **AI 集成（提交信息/讲解/Review/Release Notes）** | 中频 | ✅ **差异化能力**：5 组提示词、只读、可关闭、本地缓存 30 条、任意 OpenAI 兼容（含 Ollama）| ❌ | 🟡 | ✅ | ❌ | ❌ | 🟡 |
| 27 | **中文界面** | — | ✅ 原生中文（i18n 在需求池）| 🟡 | 🟡 | 🟡 | 🟡 | ✅ | 🟡 |
| 28 | **安装包体积 / 内存占用** | — | ✅ Tauri 2，release exe 约 9MB（`TASKS.md` M3），不内置 Chromium | ❌（Electron 系）| ✅（原生）| ❌（Electron）| ❌（Electron）| ✅ | ✅ |

**矩阵小结**：git-zen 在 28 项里 ✅ 完整支持 7 项（cherry-pick、amend、多仓库选项卡、工作流、AI、中文界面、体积）、🟡 部分支持 5 项（stash、tag、全文件 blame、.gitignore、初始化/克隆引导）、❌ 缺失 16 项。缺口集中在**「改变历史的操作」（rebase / reset 模式 / force push）、「批量与远程管理」（多选暂存 / 多 remote / remote 增删改）、「安全网」（reflog / 冲突解决）**三大簇——而这三簇恰好都不需要推翻架构，是纯粹的「还没做」。最能体现差异化的是第 24–26 行（多仓库效率、工作流、AI），它们不是竞品的短板补丁，而是独立卖点。

---

## 五、工作流（M12）评估与改进建议

### 现状核实

**7 种步骤原语**（`src/workflow.ts:13-22`）：

```ts
export type WorkflowStep =
  | { kind: "checkout"; ref: BranchRef }                              // 切分支
  | { kind: "pull" }                                                   // 拉取
  | { kind: "commitPush"; msgSource: "ai" | "fixed"; message?: string } // 提交并推送
  | { kind: "push" }                                                   // 推送
  | { kind: "merge"; ref: BranchRef }                                  // 合并
  | { kind: "createBranch"; prefix?: string }                          // 新建分支
  | { kind: "switchBack" };                                            // 切回起始分支
```

`BranchRef = { mode: "fixed" | "start" | "ask"; name?: string }`（固定名 / `$起始分支` / 运行时输入）。两个种子模板（`workflow.ts:72-93`）：「起新分支」= checkout(master) → pull → createBranch；「发布到 dev」= commitPush(ai) → checkout(release/dev) → merge($起始分支) → push → switchBack。存储 `gz.workflows`（`workflowStore.ts`，reactive + deep watch 持久化，全局共享，非按仓库）。

### 评估

**① 原语够不够用？——覆盖了两个模板类，但缺三类关键原语**

| 缺口原语 | 为什么需要 | 成本 |
|---|---|---|
| **tag 打标签 + 推 tag** | 「发布流程」的语义终点就是打 tag。现在的「发布到 dev」模板做完 merge+push 就结束了，用户还得去终端 `git tag && git push --tags` 收尾——**流程在最需要一键化的最后一步断掉** | S（复用现有 2 个命令） |
| **stash / 干净检查** | `pull` / `merge` 在工作区脏时会失败或被带入提交（确认框只是**文字提醒**，不是拦截）。有 stash 原语才能写「先收起来 → 拉取 → 再放回」这种安全流程 | S（复用已有 4 个 stash 命令） |
| **删除分支** | 发布完成后清理 `feature/xxx` 是固定收尾动作 | S |
| （可选）fetch --prune | 长期维护的自动化流程需要 | S |

条件分支 / 循环 / 变量赋值**不做是对的**（`TASKS.md:378-381`）——那确实是「一键流」与「自动化平台」的分界线，做了会同时毁掉轻定位和可测性。

**② 「出错即停」是否合理？——设计方向合理，但缺三样配套，导致失败后用户是「半途卡住」而非「安全退出」**

- ✅ **合理之处**：语义清晰、可预测、无需事务引擎；「merge 冲突即停，正好停在目标分支待处理」是巧妙的自然实现（`TASKS.md:359-361`）。
- ❌ **无回滚/无恢复**：失败时**已完成的步骤全部保留**——可能人已经在 `release/dev` 上、已经 merge 了、只是 push 失败。此时用户面对的是「一个被打乱的工作区 + 一个说不清进行到哪的弹窗」，缺一个「回到起始分支」的收尾按钮（`switchBack` 原语已经存在，只是失败路径没调用）。
- ❌ **无预览/无真实命令**：确认框只展示 `describeStep()` 的人话描述（如「合并 起始分支（main）到当前分支」），不展示将执行的实际 git 命令，也不展示 `commitPush` 会暂存哪些文件。而 `commitPush` 内部是 `git add .` **全量暂存**（`App.vue` `execStep`），意味着 `.env`、临时文件、调试代码会被一起提交并推送——**这是一次不可逆的远程副作用，却在确认框里只有一句「有改动时自动全部暂存」**。
- ❌ **无 dry-run、无单步跳过/重试、无取消**：执行期间 `busy` 锁定其它操作，弹窗只能「关闭」（关掉后操作其实仍在后台跑），没有办法中止。

**③ 导入导出/分享/模板？——全部没有**

`workflowStore.ts` 只做 `localStorage` 读写；全局 grep「导入 / 导出 / 分享 / 模板」在 `src` 下无任何工作流相关命中。种子模板是硬编码的 `SEEDS`。后果：用户精心配好的「发布流程」**无法备份、换机即失、无法给同事**。这是工作流从「个人玩具」升级为「团队资产」的必经一步。

**④ 两个被忽略的实现细节**

- **多个 `ask` 步骤共用一个输入值**：`wfInput` 是单个 `ref("")`，`confirmFlow()` 把它当作所有运行时输入的统一值。若工作流里既有「新建分支（运行时输入）」又有「切换到运行时输入的分支」，两处会拿到**同一个分支名**，后者必然找不到目标而中止。应在确认框里按步骤索引分别收集输入。
- **工作流是全局的、不绑定仓库**：`workflowStore` 与具体仓库无关，一个「发布到 dev」工作流会出现在所有仓库的工具栏下拉里。对多仓库用户（本产品的强项场景）而言，点错工作流会在错误的仓库执行 checkout/merge——**建议给工作流加可选的「适用仓库」过滤，或至少在选择时二次确认仓库名**。

### 改进建议（按性价比排序）

1. **【P0，S】确认框展示真实命令 + `commitPush` 展示待暂存文件清单**：把 `describeStep` 升级为「人话 + `$ git ...`」双行；`commitPush` 前先 `git_status`，把将要暂存的文件数/前若干条列出来。这是防「不可逆远程副作用」的最低成本手段。
2. **【P0，S-M】失败路径的收尾按钮**：失败时除「关闭」外增加「切回起始分支」（调 `switchBack` 逻辑）与「重试本步」，并把失败步骤的原始 stderr 保留在弹窗里（现在已有 `wfRun.error`，但 `@click.self="wfRun = null"` 会连同进度一起关掉，建议失败态禁止点遮罩关闭）。
3. **【P1，S】导入导出 JSON**：设置页工作流页加「导出全部 / 导入」两个按钮，导出格式 `{ version, workflows: [...] }`，导入时做 id 去重与步骤类型白名单校验（拒绝未知 `kind`，防止旧版本导入新原语导致执行器静默跳过）。顺带解决「换机迁移」与「团队分享」。
4. **【P1，S】补 `tag` 与 `stash` 原语**：让「发布到 dev」模板能一路做到打 tag 推 tag；让「拉取前先收纳」成为可配置的安全步骤。
5. **【P2，S】按步骤收集 `ask` 输入**，修掉多个运行时输入相互覆盖的问题。
6. **【P2，S】工作流绑定仓库（可选字段 `repoPath?: string`）**，为空时视为通用；工具栏下拉里把不适用的工作流置灰。

---

## 六、AI 功能评估与改进建议

### ① 提示词质量 —— 中上，承诺基本兑现

`AI_PROMPTS`（`src/ai.ts`）共 5 组，全部只读：

- **`commitMessage.system(lang)`**：6 条规则——优先跟随仓库近期提交风格、不明显时用 Conventional Commits、type 反映意图且不硬凑 scope、主题祈使语气无句号、多部分变更空行后附 1–3 条要点、跟随仓库主导语言、**只基于 diff 不臆造**，末尾注入输出语言约束。README 声称的「遵循 Conventional Commits / 自动学习仓库提交风格 / 可配中英文」**逐条落实** ✓。
- **`explainDiff.system`**：讲解变更，只读。
- **`reviewUnpushed.system`**：按【问题】【风险】【建议】三节输出，每节无内容写「无明显问题」（防止为凑字数编造问题）✓ 这是很好的抗幻觉设计。
- **`conflictExplain.system`**：解读 combined diff 的双状态列，明确「只做只读解读、不输出补丁」✓——避免了「AI 直接吐一段自己编的解决后代码」这种最危险的行为。
- **`releaseNotes.system`**：按新功能/问题修复/优化重构/其他分组，每条一行 `- 描述 (hash)`，只基于清单归纳 ✓。

**可改进点**：`commitMessage` 的语言约束是「跟随仓库主导语言」+ 显式 `lang`，两者可能冲突（仓库全是英文提交、用户选了中文）。建议改为「显式设置优先，若与仓库风格冲突，在输出中仍以显式设置为准」并在设置里注明。

### ② 上下文给得够不够 —— **不够，两处明显偏瘦**

| 调用点 | 实际给 AI 的上下文 | 缺什么 |
|---|---|---|
| **AI 生成提交信息**（`ChangesPanel.vue:246-258`）| `【仓库近期提交风格】\n<最近 10 条 subject>\n\n【暂存区 diff】\n<clipForAI(diff)>` | 缺**文件状态清单**（`--name-status`：哪些新增/删除/重命名）、当前分支名、仓库约定文件（`CONTRIBUTING.md` / 提交模板）。只有 diff 时，AI 对「新增了一个文件」和「改了一个文件」的区分要靠读 diff 头部，容易漏掉纯重命名/纯删除的场景 |
| **AI Review 未推送提交**（`App.vue:834-838`）| **只有** `git diff @{upstream}..HEAD` 的文本，经 `clipForAI` | **缺提交清单**（hash / subject / author / 各自的文件列表）。Review 的对象明明是「N 个未推送的提交」，AI 却只看到合并后的 diff，无法区分「3 个提交分别做了什么」、无法指出「提交 2 的 message 与内容不符」——而这恰恰是 Review 最有价值的部分。对照：`releaseNotes` 调用点是给了 `hash date author subject` 清单的，说明这不是能力问题而是遗漏 |
| AI 解释变更（`DiffViewer.vue`）| 当前文件/提交的 diff 文本 | 可接受（场景本就是局部） |

**建议**：`reviewUnpushed` 的 user 消息改为「提交清单（`git log --oneline @{upstream}..HEAD` + 每提交 name-status）+ 完整 diff」；`commitMessage` 增加 `--name-status` 清单与「仓库是否有 CONTRIBUTING.md」的探测（后者已在需求池）。

### ③ 幻觉风险 —— 人工确认路径做得对，工作流路径是漏洞

- ✅ **正确**：`ChangesPanel` 的 AI 提交信息只 `applyGenerated()` 写入输入框，需人工点提交；且有 `pendingMsg` 机制——草稿非空时不静默覆盖，而是挂起待用户选「覆盖 / 保留」（`ChangesPanel.vue:219-228`，对应 M11.5 的「不静默覆盖草稿」修复）。AI 解释 / Review / Release Notes 全部只写入弹窗或本地文件。
- ❌ **漏洞**：**工作流的 `commitPush` 步骤是全产品唯一「AI 生成后直接提交并推送、无人确认」的路径**。`App.vue` 的 `execStep` 中，`msgSource === "ai"` 时生成完立即 `api.commit` + `api.push`；AI 生成失败则步骤中止（不用固定文本兜底，这点是对的），但**生成成功但内容错误**时没有任何拦截。而工作流确认框只展示人话步骤描述，用户在执行前看不到那条将要产生的提交信息。
- ⚠️ **次要**：`temperature: 0.7` 对「提交信息生成」偏高（这是确定性任务，0.2–0.3 更合适），会放大同一 diff 生成结果的不稳定性。

### ④ 成本控制 —— 最薄弱的一环

- **截断**：`clipForAI(text, maxChars = 16_000)` 按**字符**（非 token）截断，超出则保留前 16000 字符并在**给模型的文本里**追加 `\n…（diff 过长已截断，原文共 N 字符）`。16000 字符 ≈ 4k–6k token，对主流模型是安全的；但**用户界面上没有任何「本次内容被截断」的提示**——用户以为 AI 看了整个 diff，实际后半段被静默丢弃。对于大重构（几百个文件的 diff），AI 的结论可能只基于前几个文件。
- **无 token 计数 / 无预估 / 无超限提示 / 无费用显示**：全产品零成本可见性。用户在点「AI Review」前不知道会发多少内容、大概花多少钱。
- **无请求取消**：`TIMEOUT_MS = 30_000` 的实现是 `setTimeout(() => (timedOut = true), 30000)` 与 fetch 竞态——**只置标志、不 abort 请求**，超时后请求仍在后台跑到结束（继续计费）。应改用 `AbortController`。
- ✅ **做得好**：本地缓存 `gz.ai.<bucket>`，FIFO 上限 30（`AI_CACHE_LIMIT`），按仓库/分支/文件分桶；推送成功后清理该分支的 Review 缓存（`App.vue` `run()` 中 `name === "push"` 时 `aiCacheDelete(REVIEW_BUCKET, reviewKey())`）——避免推完还看到过期的 Review。

### ⑤ 只读原则 —— ✅ 完全遵守

5 个调用点（`App.vue` Review / Release Notes / 工作流提交信息、`DiffViewer.vue` 解释与冲突解读、`ChangesPanel.vue` 提交信息）**全部只消费 diff/log 文本**，无任何写工作区、写暂存区、写仓库的调用。唯一的落盘是用户主动点「保存到本地」时的 `saveDialog` + `git_write_file`（用户选路径、用户触发，不是 AI 自动写）。符合 `AGENTS.md` 硬规则 5「AI 功能全部只读」✓。

### 改进建议（按性价比排序）

1. **【P0，S】工作流 `commitPush` 增加提交信息预览/确认**：AI 生成后先展示给用户，允许「确认 / 编辑后再提交 / 跳过本步」。这是当前唯一的高风险幻觉直达路径，且与「工作流确认框应展示真实副作用」是同一个修复。
2. **【P1，S】`reviewUnpushed` 补提交清单**：把 `git log` 的 hash/subject/author 与各提交的 name-status 一并给 AI。改动极小，Review 质量提升最大。
3. **【P1，S】截断可见化 + 成本可见化**：`clipForAI` 返回时带上 `{ text, truncated: boolean, originalChars }`，UI 在结果旁显示「输入已截断（16000 / 128000 字符）」；AI 按钮的 tooltip 显示「将发送约 N 字符」。不要引入 token 库，用字符数近似并说明即可。
4. **【P1，S】`AbortController` 替换伪超时** + 界面上给「取消」按钮（AI 请求通常 5–30s，用户现在只能干等）。
5. **【P2，S】`commitMessage` 的 `temperature` 降到 0.2**（可在设置里作为隐藏项），并补 `--name-status` 上下文。
6. **【P2，S】清理注释里的死路径**：`ai.ts` 注释引用的 `src/ai/skills/git-commit-message/SKILL.md` 不存在（`ANALYSIS.md` 已记录，至今未清理）。

---

## 七、DESIGN 4.5「明确不做」的复议

原文（`DESIGN.md:100-107`）四条，逐条判断：

| 原决定 | 复议结论 | 具体理由与痛点场景 |
|---|---|---|
| **rebase / cherry-pick 交互 UI** → 终端更顺手 | **部分推翻**：cherry-pick 部分已被推翻（已实现且好用）；**rebase 普通形式建议做，交互式仍可不做** | cherry-pick 的实现已经证明「终端更顺手」这个判断在本产品用户群里不成立。rebase 的痛点场景很具体：**团队约定「合并前先 rebase 到最新 main」时，用户在 git-zen 里没有任何 rebase 入口**，只能切终端；而如果他用 GUI 里唯一的替代动作（merge main into feature）来同步，就会在 PR 里留下一个多余的 merge commit，被 reviewer 要求「清理历史」——**这正是用户被迫开终端的起点**。建议：先做「把当前分支 rebase 到目标分支」（非交互，冲突即停并引导），交互式 rebase（squash/reword/drop）可以继续留在终端。注意：**没有冲突解决 UI 之前不要做 rebase**，否则 rebase 冲突会制造比 merge 冲突更糟的体验（解法见下一行）|
| **冲突解决 UI** → 只做报错引导 | **建议推翻（优先级最高的定位修正）** | 这是四条里唯一**会让用户彻底离开应用**的决定，且触发频率是「日常高频」。痛点场景：① 拉取远程更新时同一文件被双方修改 → 弹「产生合并冲突，请在终端解决后再试」→ 用户开终端解决 → **回到 GUI 还得手动点刷新才能确认状态**；② 工作流的「发布到 dev」在 merge 步骤失败即停，用户面对一个停在 release/dev 上的工作区，既不知道有几个冲突文件（GUI 只报一句错），也没有任何「放弃这次合并（`merge --abort`）」的出口——**中止能力其实是安全底线，不是高级功能**。「只做报错引导」隐含假设是「用户会开终端」，但这与 README 开篇「直接调用系统 git CLI，认证/SSH 复用本机配置」想争取的**非重度命令行用户**是矛盾的 |
| **自动轮询刷新** → fetch-once + 窗口聚焦刷新已够 | **维持，但需修一个不一致** | 维持的理由成立：轮询在多仓库场景会把网络和 git 进程打满，且 `window.addEventListener("focus", () => refresh())`（`App.vue:1606`）+ fetch-once 已覆盖「切回来看一眼」的主场景。**但要注意**：`refresh()` 默认**不 fetch**，只有 F5 / 刷新按钮走 `refresh({fetch:true})`（`BUGS.md` 记录过「刷新不 fetch 导致 ↓N 不出现」的修复），所以「窗口聚焦刷新」实际上不会带来新的远程提交——**这符合设计意图（避免隐式网络请求），但应让状态栏的 ↓N 有明确的「需要手动刷新才更新」的暗示**，否则用户会以为「没有新提交」。另外这个决定与需求池里的「选项卡脏标记（需后台轮询全部仓库）」直接冲突，二者只能取其一 |
| **多窗口展示** → 不做 | **维持** | 理由（状态全是模块级单例 `repoCache`/`activateSeq`/`settings` watcher，第二窗口 = 第二份 JS 上下文，需先 store 重构）是**技术事实而非托辞**，且与「轻」定位一致。真正的多仓库跳转已被 Ctrl+P 切换器 + Ctrl+B 分支切换器 + 选项卡分组三条路径覆盖。痛点场景（想并排看两个仓库的 diff）确实存在，但收益远不及重构成本与风险 |

**额外一条建议新增的「明确不做」**：submodule / LFS / bisect。当前这三项既没实现也没写进 DESIGN 4.5（只在竞品对比里显得缺失），建议显式记录为不做并写明理由，避免每轮审查都被重新提起。

---

## 八、首程体验摩擦点清单

按「第一次打开这个软件的人」的主流程逐环节：

### 环节 1：打开软件（空态）

| 摩擦点 | 证据 | 建议 |
|---|---|---|
| 无引导页、无示例仓库，空态只有图标 + 一句话 + 最近列表 | `App.vue:1923-1951`：GitBranch 图标 +「打开一个 Git 仓库开始」+「把仓库文件夹拖进窗口，或从下面选择最近打开的」+「打开仓库…」按钮 + 最近 8 个仓库 | 文案本身合格（有下一步动作），但**没有提示「从远程克隆」这条路径**——克隆入口藏在「打开」弹窗的第二个 tab 里（`openModal = 'choose' \| 'remote'`）。首次用户如果本机没有仓库，第一屏看不出「我可以从 GitHub 克隆一个」。建议空态并列两个按钮：「打开本地仓库 / 从远程克隆」 |
| **无 git 环境检测** | 全产品 grep `--version` 无命中；`git.rs:24` 只在调用失败时返回 `无法启动 git: {e}`，且 humanize 规则表（`App.vue:83-98`）**没有这条** → 用户看到原始英文 OS 错误 | 启动时后台跑一次 `git --version`，失败则在空态显示「未检测到 Git：请先安装 Git 并确保它在 PATH 中」+ 下载链接；同时禁用打开仓库按钮并给出 tooltip |

### 环节 2：加入仓库

| 摩擦点 | 证据 | 建议 |
|---|---|---|
| **「打开仓库」入口不校验目录** | `App.vue:311-315` `openRepo()`：`addRepo(dir); switchRepo(dir)`，**没有 `checkRepo`**。而拖拽入口 `openDropped`（`:1163-1174`）有校验。选中非 Git 目录 → 该目录**被持久化进 `gz.repos`**（`watch(repos, …)` 写 localStorage），activate 阶段才报「所选目录不是 Git 仓库」→ 标签栏多出一个**点一次弹一次错误的坏选项卡**，用户得自己找到关闭按钮 | `openRepo` 与 `openDropped` 统一走 `checkRepo`；校验失败时不落库，并直接在弹窗/空态里给两条出路：「选择其他目录」与「**在这里初始化仓库（`git init`）**」 |
| **无 `git init`** | 全 src 无 init 相关命令与 UI（grep `初始化\|git init` 只命中 humanize 文案） | 与上一条合并：打开一个「还不是 Git 仓库」的目录，是最典型的「我有个新项目想开始用版本控制」场景，现在只能去终端 `git init` |
| 克隆表单体验尚可 | URL + 「选择位置…」+ 目录名从 URL 末段自动推断（含 `git@host:path` scp 风格）、目录名含分隔符报错、克隆中 Esc 不关表单（`:336`）| 不必改；建议克隆完成后 toast 里附一句「已加入选项卡，可用 Ctrl+P 快速切换」（该快捷键当前不可发现） |

### 环节 3：看变更

| 摩擦点 | 证据 | 建议 |
|---|---|---|
| 空仓库（有 `.git` 无提交）没有「创建第一个提交」的引导 | humanize 有「空仓库：还没有任何提交」（`:94`），历史区显示「暂无提交」（`:1921`），但**变更面板没有任何空态 CTA** | 历史区空态补一句「这个仓库还没有提交——在右侧暂存文件后提交第一条吧」，与 `M11.4` 定的「空态必须给下一步动作」规范一致 |
| detached HEAD 显示原始串 | `git_status` 解析 `## ` 后取 `...` 前的片段，detached 时 porcelain 输出 `## HEAD (no branch)` → 状态栏显示 `HEAD (no branch)`（`ANALYSIS.md` 已记录，仍在）| 映射为「游离 HEAD（不在任何分支上）」+ 一句「双击一个分支即可切回」 |
| 单击选中 / 再点打开 的双击语义需要学习 | `ChangesPanel.vue:135-138`、`HistoryGraph.vue:47-50` | 逻辑本身合理（防误触），但**首次使用无提示**。行 tooltip 里已有「单击选中 · 双击查看变更」文案（`ChangesPanel.vue` 行 Tooltip、`HistoryGraph` 行 title），实际是「点两下」——文案与实现不符（**其实是单击两次，不是双击**），建议改为「再点一次查看变更」 |

### 环节 4：暂存

| 摩擦点 | 证据 | 建议 |
|---|---|---|
| **无法多选** | 无 checkbox / Shift 选择 / `selectedPaths` | 见 Top10 #4 |
| 单文件操作只有 hover 图标，无文字说明 | `ChangesPanel.vue` 未暂存行 hover 出 `Plus`、已暂存行 hover 出 `Undo2`，靠 `Tooltip` 解释 | 可接受；建议初次使用时给一次「悬停文件可暂存/取消暂存」的提示 |
| 「全部暂存」无范围提示 | 「全部暂存」按钮直接 `git add .` 语义 | 大改动时用户不知道会带上多少文件（尤其未跟踪的构建产物）。建议按钮上显示数量，如「全部暂存 (37)」 |

### 环节 5：提交

| 摩擦点 | 证据 | 建议 |
|---|---|---|
| **主按钮变灰但不给原因** | `canCommit = !props.busy && staged.length > 0 && message.value.trim().length > 0`（`ChangesPanel.vue:194-196`）。三种失败原因（忙 / 无暂存 / 无信息）共用「灰按钮」一种表现，**没有 tooltip、没有行内提示** | 按钮 disabled 时挂 tooltip 说明缺什么：「先暂存文件」/「填写提交信息」/「正在执行其他操作」 |
| 提交草稿是按仓库隔离的，切换选项卡不串（好） | `drafts = reactive(new Map<string, string>())`（`ChangesPanel.vue:141` 附近）| 无需改 |
| amend / 撤销提交无解释 | 两个图标与提交勾选框同行，只有 `Tooltip`「追加到上次提交（amend）」/ 撤销 | 撤销提交（`reset --soft HEAD~1`）是**改写本地历史**的动作，虽然有确认框，但建议 tooltip 里补「不会丢失改动（保留在暂存区）」以降低心理门槛 |

### 环节 6：推送

| 摩擦点 | 证据 | 建议 |
|---|---|---|
| 无上游自动 `push -u origin`（好） | `git.rs:514-519`；状态栏另有常驻「当前分支尚未推送到远程」徽标（`BUGS.md` 记录的修复）| 无需改 |
| **认证失败不可行动** | humanize：`authentication\|permission denied\|could not read Username\|403` →「认证失败：请检查系统 git 凭据（credential helper / ssh key）」（`:91`）。用户不知道该敲什么命令、该改哪个配置，而产品本身不管理 SSH key | 文案补可执行动作：给出「在终端执行 `git config --global credential.helper manager`（Windows）/ `ssh -T git@github.com`（SSH）」这类**复制即用**的片段，并加「复制」按钮 |
| **推送被拒后引导方向错误（最严重）** | `rejected.*fetch first\|non-fast-forward` →「远程有新提交，先 Pull 再 Push」（`:85`）。在**用户自己刚刚 amend / 撤销提交**的场景下，远程并没有新提交，是本地历史被改写了；用户照做 Pull 会把远端旧提交合回来，产生一个多余的分叉 merge commit，历史从此混乱。**正确动作是 `push --force-with-lease`** | 见 Top10 #1。短期最低成本：让 `git_push` 在 err 里区分「本地已 amend（可用 reflog 判断）」并输出不同文案；中期直接提供 `--force-with-lease` 按钮 + 确认框（说明「会用本地历史覆盖远程，且仅在远程没有他人新提交时成功」）|
| 冲突：直接踢去终端 | `:95`「产生合并冲突，请在终端解决后再试」 | 见 Top10 #2 / 第七节 |

### 环节 7（横切）：可发现性

- **快捷键表不完整且不符**（README 与设置页同样问题）：缺 Ctrl+B、Ctrl+Shift+L/R；「双击分支」「双击历史行」的描述与实现不符（A2/A3/A4）。用户不可能发现「分支快速切换器 Ctrl+B」这种效率功能——而它恰恰是这个软件相对竞品的强项之一。
- **工作流零文档**：种子模板第一次启动就存在，工具栏也有按钮，但 README 完全没有提及，用户只能靠「点一下试试」理解「$起始分支」「运行时输入」这些概念。建议 README 补一节「工作流」+ 设置页空态文案（已有，`SettingsModal.vue:431-445`）里加一条图文说明。
- **AI 功能默认开启**（`aiEnabled: "on"`，`settings.ts:41`）：AI 是可选功能，默认开会让未配置 Key 的用户在点 Sparkles 时直接撞上「未配置 AI Base URL」（`ai.ts:37`）。建议首次点击时若未配置，弹一个「去设置」的引导弹窗，而不是纯报错。

---

## 附：本次审查的三条元结论

1. **文档滞后于代码，而非代码落后于文档**——唯一的两种情况都发生在 README（快捷键行为描述错误）与 ANALYSIS（缺口清单已过期）。这比「吹牛」好得多，但代价是 **M9–M12 四个里程碑的工作对用户完全不可见**，等于白做了一半。
2. **已实现功能之间的断头路比缺失功能更危险**：amend 无 force push、工作流 commitPush 无确认、`git add .` 全量暂存——三者都是「前半段做好了、后半段没接上」，用户会自然地走进去然后受损。建议做一次「每条功能链是否闭环」的专项走查。
3. **`BUGS.md` 已失效为单一事实源**：`ANALYSIS.md` 记录的三个真 Bug 从未进入 `BUGS.md`，而复核显示它们**全部仍然存在**（切换分支不回滚、历史范围切换竞态、`git_status` 死代码）。建议要么把 ANALYSIS 的发现迁移进 BUGS.md，要么在 BUGS.md 顶部注明「本文档只记录已修复项，未修项见 ANALYSIS.md」。
