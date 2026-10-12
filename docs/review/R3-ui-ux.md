# R3 · UI / 交互 / 可及性审查报告

> 审查对象：`src/App.vue`（template）、`src/components/*.vue`、`src/components/ui/*.vue`、`src/style.css`
> 方式：**纯静态代码审查**（读模板 / class / CSS token，未启动应用、未截图）
> 证据规则：每条结论均给出 `文件:行号`。行号以本次读取的文件总行数为准（App.vue 2798 / ChangesPanel.vue 583 / SettingsModal.vue 635 / DiffViewer.vue 354 / HistoryGraph.vue 224 / FileHistoryModal.vue 108 / style.css 230）。

---

## 总体结论

git-zen 的视觉底子明显在平均线以上：7 套主题全部 token 化（`src/style.css:5-160`）、零 Tailwind 具名色、全项目唯一的硬编码语义色只有 3 处，全局 `:focus-visible` 焦点环（`src/style.css:206-210`）和 `prefers-reduced-motion` 降级（`src/style.css:223-230`）都做了，危险操作的居中确认框还特意把初始焦点放在「取消」上（`src/App.vue:1392-1397`）——这些是有设计意识的表现。**最影响手感的三个问题是**：(1) 中文输入法在组件级输入框里完全没有守卫，`@keyup.enter` / `@keyup.esc` 会在 IME 选词或取消组合时误触发，可能静默创建分支/标签、误关填了一半的弹窗；(2) 暂存 / 取消暂存 / stash 三组核心操作是 `opacity-0` 且仅在 hover 时才出现的裸 `<svg>`，纯键盘和触屏用户**根本做不了单文件暂存**；(3) 19 个弹层全部没有 `role="dialog"` / `aria-modal` / focus trap / 关闭后焦点归位，Tab 会穿透到遮罩背后的界面，键盘用户在危险确认框里按 Tab + 回车可能触发背后元素。此外危险操作的确认覆盖存在明显断层：「关闭仓库选项卡 / 关闭其他」在菜单里标了 `danger: true` 却不弹确认，反而是非破坏性的「合并分支」要走确认框——**危险等级与防护强度是反着来的**。

---

## 一、四张必附表

### 表 1 · 危险操作确认覆盖表

| # | 操作 | 入口位置 | 是否有二次确认 | 是否说明后果 |
|---|---|---|---|---|
| 1 | 删除本地分支（`-d`） | 分支右键 → `src/App.vue:1053-1056` → `askDelete` `src/App.vue:1400-1418` | ✅ 居中确认框 | ✅「确认删除本地分支 X？」 |
| 2 | 强制删除本地分支（`-D`） | 同上的 checkbox → `src/App.vue:1414` | ✅ 同一确认框 | ✅「未合并的提交将丢失」 |
| 3 | 删除远程分支 | 分支右键 → `src/App.vue:1402-1408` | ✅ | ✅「该操作直接作用于远程仓库」 |
| 4 | 丢弃文件更改 | 文件右键 → `ChangesPanel.vue:391-400` → `src/App.vue:1990-1995` | ✅ | ✅「此操作不可恢复」 |
| 5 | 删除未跟踪文件 | 同上（`f.x === '?'`） | ✅ | ✅「此操作不可恢复」 |
| 6 | Revert 提交 | 历史行右键 → `src/App.vue:2171-2175` | ✅ | ✅「会生成一个反向提交」 |
| 7 | Checkout 到该提交（detached HEAD） | 历史行右键 → `src/App.vue:2162-2166` | ✅ | ✅「将进入 detached HEAD 状态」 |
| 8 | Cherry-pick | 历史行右键 → `src/App.vue:2180-2184` | ✅ | ✅ 说明空拣选/冲突会失败停留 |
| 9 | 放弃未推送提交（reset 回远程） | ↑N 徽标菜单 → `src/App.vue:2218-2224` → `askDiscardUnpushed` `src/App.vue:1437-1450` | ✅ | ✅✅ 最完整：列出提交数 + 脏工作区警告 + `git reflog` 找回提示 |
| 10 | amend 改写已推送历史 | 提交区按钮 `ChangesPanel.vue:457-468` → `askAmend` `src/App.vue:1471-1487` | ✅ | ✅「之后需在终端强制推送 `--force-with-lease`」 |
| 11 | 撤销上次提交 | 提交区按钮 `ChangesPanel.vue:469-480` → `askUndoCommit` `src/App.vue:1489-1499` | ✅ | ✅ 已推送时提示需 force push |
| 12 | 合并分支 | 分支右键 → `askMerge` `src/App.vue:1423-1426` | ✅（非破坏操作也确认） | ⚠️ 未提冲突后果 |
| 13 | 合并当前分支到目标分支 | 分支右键 → `src/App.vue:1455-1460` | ✅ | ✅「若冲突请在解决后重新提交」 |
| 14 | 删除 Stash 记录 | stash 菜单 Trash2 `ChangesPanel.vue:545-550` → `askStashDrop` `src/App.vue:1501-1507` | ✅ | ✅「这条记录收纳的改动将无法恢复」 |
| 15 | **恢复并删除 Stash（pop）** | stash 菜单 ArchiveRestore `ChangesPanel.vue:539-544` | ❌ **无** | ⚠️ 仅 title「恢复并删除记录（pop）」 |
| 16 | 删除标签 | 标签右键 → `askDeleteTag` `src/App.vue:1020-1026` | ✅ | ✅「远程上的同名标签不会被删除」 |
| 17 | 推送标签 | 标签右键 → `src/App.vue:1027-1030` | ❌ 无（非破坏，可接受） | — |
| 18 | 删除仓库分组 | 分组管理 `src/App.vue:2432` → `askDeleteGroup` `src/App.vue:565-571` | ✅ | ✅「不会关闭任何仓库」 |
| 19 | **移除分组成员** | 分组管理 `src/App.vue:2449-2455` | ❌ **无** | ⚠️ 仅 `title` |
| 20 | **关闭仓库选项卡** | 选项卡 X `src/App.vue:1760-1765`；右键「关闭」`src/App.vue:2353` | ❌ **无**（菜单却标了 `danger: true`） | ⚠️ 事后 toast「可用「打开」重新加入」 |
| 21 | **关闭其他选项卡** | 右键 → `src/App.vue:2354` → `closeOthers` `src/App.vue:760-766` | ❌ **无** | ❌ 无任何反馈 |
| 22 | 删除工作流 | 设置 → `SettingsModal.vue:460-468` + `deleteFlow` `SettingsModal.vue:109-120` | ⚠️ **两段式按钮**（非居中框，2.5s 自动复位） | ❌ 无 |
| 23 | **删除工作流步骤** | `SettingsModal.vue:536-544` | ❌ **无** | ❌ 无 |
| 24 | **删除分支前缀配置** | `SettingsModal.vue:394` | ❌ 无（低危，可重建） | ❌ 无 |
| 25 | 切换分支（脏工作区） | BranchTree 单击 `BranchTree.vue:58` → `src/App.vue:1363-1376` | ✅ 条件触发（仅 `dirty > 0`） | ✅「会把改动带过去 / 冲突时被 git 拒绝」 |
| 26 | 删除仓库（磁盘） | — **不存在此功能** | N/A | N/A |
| 27 | force push | — **GUI 不提供** | N/A | ✅ 提示到终端用 `--force-with-lease`（`src/App.vue:1481`） |
| 28 | 清空设置 / 恢复默认 | — **不存在此功能**（`settings.ts` 有 `DEFAULTS` 但无 UI 入口） | N/A | N/A |

**结论**：真正的数据破坏操作（1-14、16、18）**确认覆盖完整且后果说明到位**，这是加分项。缺口集中在「视图层级的移除」（15、19-21）和「配置层级的小删除」（23-24），以及一个交互模式不一致（22）。

---

### 表 2 · 快捷键总表与冲突

| 快捷键 | 实现位置 | 作用 | 是否写入文档 | 输入框内误触发 | 备注 |
|---|---|---|---|---|---|
| `Ctrl + P` | `src/App.vue:1557-1560` | 仓库快速切换器 | ✅ README:74·SettingsModal:184 | ⚠️ 会 | 无仓库时也 `preventDefault`，吞掉按键 |
| `Ctrl + B` | `src/App.vue:1561-1564` | 分支快速切换器 | ❌ **未记录** | ⚠️ 会 | README / 设置里的快捷键表都漏了 |
| `Ctrl + Tab` | `src/App.vue:1543-1551` | 下一个仓库选项卡 | ✅ README:75 | ⚠️ 会 | 与浏览器/编辑器切标签习惯同键 |
| `Ctrl + Shift + Tab` | `src/App.vue:1543-1551` | 上一个仓库选项卡 | ✅ README:75 | ⚠️ 会 | |
| `Ctrl + 1..9` | `src/App.vue:1552-1556` | 跳到第 N 个可见仓库 | ✅ README:76 | ⚠️ 会 | 多行输入框里 Ctrl+数字无标准含义，冲突低 |
| `Ctrl + Shift + L` | `src/App.vue:1565-1567` | 折叠左侧栏 | ❌ **未记录** | ⚠️ 会 | |
| `Ctrl + Shift + R` | `src/App.vue:1568-1570` | 折叠右侧栏 | ❌ **未记录** | ⚠️ 会 | **与浏览器硬刷新同键** |
| `F5` | `src/App.vue:1573-1576` | 刷新仓库状态 | ✅ README:77 | ⚠️ 会 | 已 `preventDefault` |
| `Esc` | `src/App.vue:1571-1572` → `closeTopOverlay` `src/App.vue:1514-1539` | 按层级关闭最上层浮层 | ✅ README:81 | ✅ **有 `isComposing` 守卫**（`src/App.vue:1542`） | 19 层硬编码优先级链 |
| `Ctrl + Enter` | `ChangesPanel.vue:414` | 提交 | ✅ README:78 | ⚠️ 组件级**无**守卫 | 仅提交框内生效 |
| `↑` `↓` `Enter` | `src/App.vue:614-634` / `src/App.vue:1140-1157` | 切换器内选择 | ❌ | ⚠️ **无 `isComposing` 守卫 → IME 选词会直接打开仓库 / 切分支** | 同一个 input 的 `@keydown` |
| `↑` `↓` `Enter` | `ui/ContextMenu.vue:70-87` | 右键菜单导航 | ❌ | ✅ 有守卫 | 唯一做对的键盘导航实现 |
| `Enter`（弹窗输入框） | `src/App.vue:2017 / 2085 / 2126 / 2496 / 2566 / 2588 / 2663` | 确认 | ❌ | ⚠️ **无守卫 → 中文选词即提交** | |
| `Esc`（弹窗输入框） | `src/App.vue:2070 / 2086 / 2127 / 2133 / 2497 / 2567 / 2589` | 关闭弹窗 | ❌ | ⚠️ 同上 | |

**冲突清单（实际可触发的）**：
1. `Ctrl + Shift + R` 与浏览器/Electron 惯用的硬刷新同键（Tauri 无刷新，但用户肌肉记忆会误按）。
2. `Ctrl + B` / `Ctrl + P` 在多数编辑器里是「侧栏」「打印」，与看图习惯冲突（无实际破坏，但会打断）。
3. **守卫不一致是最大问题**：全局 `keydown` 做了 `isComposing` 守卫（`src/App.vue:1542`），但组件级 `@keyup.enter` / `@keyup.esc` / `@keydown`（`src/App.vue:2017` 等 13 处、`ChangesPanel.vue:414`、`SettingsModal.vue:400`）全部没有——**IME 组合状态下 `keyup` 的 `isComposing` 通常已回到 `false`，守卫必须逐个加**。
4. 文档漏记 3 个快捷键（`Ctrl+B` / `Ctrl+Shift+L` / `Ctrl+Shift+R`）。

---

### 表 3 · 硬编码颜色清单

| 位置 | 值 | 用途 | 各主题下实测对比度（对 background / 对 card） |
|---|---|---|---|
| `HistoryGraph.vue:183` | `stroke="#3a4450"` | 泳道连线 | dark 1.92/1.80 · light **9.48/9.89** · mocha 1.66/1.77 · latte 8.75/8.13 · one-dark 1.41/1.56 · gh-dark 1.91/1.75 —— **深色主题下几乎看不见，浅色主题下又过黑抢眼**，一个值同时错两个方向 |
| `src/graph.ts:65-71` | `LANE_COLORS = ["#8b7ff5","#4a9ec2","#c2884a","#9d64b0","#c05a66","#8a9aa8","#c2b25e"]` | 泳道圆点 | light 下 `#8a9aa8` 2.77、`#c2b25e` 2.05、`#4a9ec2` 2.89、`#c2884a` 2.91；latte 下 `#c2b25e` 1.89、`#8a9aa8` 2.56 —— **4 个色在浅色主题下低于 3:1** |
| `ui/Switch.vue:31` | `bg-white` | 开关滑块 | light 1.04 / latte 1.13 / gh-light 1.04 对 card —— **浅色主题下关闭态的滑块几乎消失** |
| `bg-black/50` ×19 处：`App.vue:2003,2034,2117,2246,2275,2399,2487,2512,2558,2580,2604,2652,2692,2739,2758`；`ChangesPanel.vue:563`；`DiffViewer.vue:257`；`FileHistoryModal.vue:57`；`SettingsModal.vue:248` | `bg-black/50` | 弹层遮罩 | 不随主题变化；浅色主题下遮罩偏重（建议 token 化为 `bg-background/70` 或按主题给两档） |
| `ui/Input.vue:14` / `ui/Textarea.vue:14` / `ui/Select.vue:42` | `outline-none` | 企图关闭焦点环 | 被 `style.css:206-210` 的全局 `:focus-visible`（未分层，优先级高于 `@layer utilities`）覆盖，**实际无害但属死代码**，会让后续维护者误判焦点样式来源 |

**良好实践（应保持）**：`src/style.css:5-160` 中的所有 `#hex` 都是 token 定义本身；全项目 **0 处** Tailwind 具名色类（`text-red-500` / `bg-slate-800` 之类）；`Badge.vue:11-15` 的语义色全部走 `var(--c-*)`。

---

### 表 4 · 缺 `aria-*` / `role` 的交互元素清单

> 全项目统计：`role=` **仅 1 处**（`ui/Switch.vue:16` `role="switch"`）；`tabindex=` **0 处**；`aria-*` 共 20 处（`Switch.vue:17` + `ChangesPanel.vue:343,422,463,475` + `DiffViewer.vue:269,274,279,284` + `SettingsModal.vue:530,533,540` + `App.vue:1633,1644,1652,1676,1687,1694,1762,1870,1966`）。**`aria-modal` / `aria-expanded` / `aria-haspopup` / `aria-live` / `aria-describedby` / `aria-selected` 全项目 0 处。**

| 文件 | 元素 | 行号 | 缺失 | 键盘/读屏后果 |
|---|---|---|---|---|
| App.vue | 分组文件夹 `div` | 1718-1739 | `role`/`tabindex`/`@keydown`/`aria-expanded` | 键盘无法展开分组 |
| App.vue | 仓库选项卡 `div` | 1741-1766 | `role="tab"`/`tabindex`/`aria-selected`/`@keydown` | **键盘无法切换仓库** |
| App.vue | 关闭选项卡 X（裸 svg） | 1760-1765 | 非 `<button>`、不可聚焦（`aria-label` 有但键盘到不了） | 键盘无法关闭选项卡 |
| App.vue | 管理分组 `Button` | 1770 | `aria-label`（仅 Tooltip 承载） | 读屏只播「按钮」 |
| App.vue | 本地分支组头 `div` | 1794-1802 | `role`/`tabindex`/`aria-expanded` | 键盘无法折叠分组 |
| App.vue | 远程分组组头 `div` | 1813-1821 | 同上 | 同上 |
| App.vue | 标签组头 `div` | 1832-1842 | 同上；且**唯一入口是右键** | 键盘完全无法新建标签 / Release Notes |
| App.vue | 标签行 `li` | 1844-1852 | 无 `@click`/`tabindex`（只有 `@contextmenu`） | 键盘完全不可达 |
| App.vue | 折叠态 `ChevronRight`/`ChevronLeft` | 1867 / 1963 | 非 `<button>` | 键盘不可聚焦展开侧栏 |
| App.vue | 文件过滤 chip 的 X | 1895 | 非 `<button>`、无 `aria-label`、不可聚焦 | 键盘无法清除文件过滤 |
| App.vue | 分支搜索 `Input` | 1791 | `label`/`aria-label` | 读屏只知道「编辑框」 |
| App.vue | 历史搜索 `Input` | 1899 | 同上 | 同上 |
| App.vue | 快速切换器结果 `li` | 2529 | `role="option"`/`aria-selected`（`id` 已备好却未用 `aria-activedescendant`） | 读屏读不出候选列表 |
| App.vue | 分支切换器结果 `li` | 2621 | 同上 | 同上 |
| App.vue | 弹窗关闭 X（`Button` 内） | 2254 / 2284 / 2407 | `aria-label` | 读屏只播「按钮」 |
| App.vue | 移出分组成员 `button` | 2449-2455 | `aria-label`（仅 `title`） | 同上 |
| App.vue | 全部弹层容器（14 处） | 2003/2034/2117/2246/2275/2399/2487/2512/2558/2580/2604/2652/2692/2739 | `role="dialog"`/`aria-modal`/`aria-labelledby` | 读屏不播报弹窗出现，焦点不转移 |
| ChangesPanel.vue | 已暂存行 `li` | 291-298 | `role`/`tabindex`/`@keydown` | 键盘无法选中或打开 diff |
| ChangesPanel.vue | 取消暂存 `Undo2`（裸 svg） | 309-314 | 非 `<button>`、无 `aria-label`、`opacity-0` 仅 hover | **键盘无法取消暂存** |
| ChangesPanel.vue | 未暂存行 `li` | 351-358 | 同上 | 同上 |
| ChangesPanel.vue | 暂存 `Plus`（裸 svg） | 363-368 | 同上 | **键盘无法暂存单个文件** |
| ChangesPanel.vue | AI 生成提交信息 `Button` | 428-439 | `aria-label` | 读屏只播「按钮」 |
| ChangesPanel.vue | stash 三图标 RotateCcw / ArchiveRestore / Trash2 | 534 / 540 / 546 | 非 `<button>`、无 `aria-label`、`group-hover/st:flex` 才显示 | **键盘完全不可达** |
| ChangesPanel.vue | stash 下拉容器（手搓，未用 `ui/ContextMenu`） | 498-508 | 无边界收敛、无 Esc、无键盘导航 | 键盘无法操作 |
| ChangesPanel.vue | 提交信息 `Textarea` | 409-415 | `label`/`aria-label` | 读屏只知道「编辑框」 |
| DiffViewer.vue | 文件列表 `li` | 294-306 | `role`/`tabindex`/`@keydown` | 键盘无法切换查看的文件 |
| DiffViewer.vue | 拖宽把手 `div` | 310 | `role="separator"`/`tabindex`/`@keydown` | 键盘无法调节宽度 |
| HistoryGraph.vue | 提交行 `div` | 196-221 | `role`/`tabindex`/`@keydown`/`aria-selected` | **键盘完全不可达历史** |
| BranchTree.vue | 中间节点 `div` | 30-38 | `role`/`tabindex`/`aria-expanded` | 键盘无法折叠分支树 |
| BranchTree.vue | 叶子 `li` | 50-66 | `role`/`tabindex`/`@keydown` | **键盘无法切换分支** |
| FileHistoryModal.vue | 提交行 `li` | 75-84 | `role`/`tabindex`/`@keydown` | 键盘不可达 |
| FileHistoryModal.vue | 关闭 `Button` | 63 | `aria-label` | 读屏只播「按钮」 |
| SettingsModal.vue | 左侧导航 `button` | 253-264 | `role="tab"`/`aria-selected`/`role="tablist"` | 读屏读不出当前页签 |
| SettingsModal.vue | 关闭 `Button` | 272 | `aria-label` | 读屏只播「按钮」 |
| SettingsModal.vue | 分支前缀删除 X（裸 svg） | 394 | 非 `<button>`、无 `aria-label` | 键盘不可达 |
| SettingsModal.vue | 名字/邮箱/Key/URL/目录等 12 个输入框 | 283,287,313,317,321,490,508,517,561,570,577,597 | `label for` 或 `aria-label`（`label` 未关联 `id`） | 读屏读不出字段名 |
| SettingsModal.vue | 字号滑杆 `input[type=range]` | 375 | `aria-label`/`aria-valuetext` | 读屏只播「滑杆」 |
| ui/ContextMenu.vue | 菜单根 `div` / 菜单项 `button` | 92 / 100-112 | `role="menu"` / `role="menuitem"` | 读屏不播报菜单语义 |
| ui/Select.vue | 触发器 `button` / 下拉容器 / 选项 `button` | 37-52 / 53-55 / 57-68 | `aria-haspopup="listbox"`/`aria-expanded`/`role="listbox"`/`role="option"` | 键盘无法用 ↑↓ 选择，Esc 不关闭 |
| ui/CommitHeatmap.vue | 热力图格子 `div` | 154-159 | `role="img"`/`aria-label`（仅原生 `title`） | **对读屏完全不可读** |
| ui/Tooltip.vue | 气泡 | 51-71 | `role="tooltip"` + `aria-describedby` 关联；且**只监听 `mouseenter`/`mouseleave`，无 `focus`/`blur`** | 键盘用户永远看不到 Tooltip 内容（等于所有靠 Tooltip 承载语义的图标按钮对键盘用户是空的） |
| ui/Toast.vue | 容器 | 7 | `role="status"`/`aria-live="polite"` | 读屏不播报「已推送」「已暂存」 |
| ui/Spinner.vue | 容器 | 9-12 | `role="status"` | 读屏不播报加载状态 |

---

## 二、按优先级分组

### [P0] 中文输入法（IME）组合状态在组件级输入框完全没有守卫

**位置**：`src/App.vue:2017`、`src/App.vue:2085`、`src/App.vue:2126`、`src/App.vue:2496`、`src/App.vue:2566`、`src/App.vue:2588`、`src/App.vue:2663`（`@keyup.enter`）；`src/App.vue:2070,2086,2127,2133,2497,2567,2589`（`@keyup.esc`）；`src/App.vue:614-634` + `src/App.vue:1140-1157`（两个切换器的 `@keydown`）；`src/components/ChangesPanel.vue:414`（`@keydown.ctrl.enter`）；`src/components/SettingsModal.vue:400`（`@keydown.enter.prevent`）

**用户可感知的影响**：全局快捷键层做了守卫（`src/App.vue:1542` 的 `if (e.isComposing) return`，注释写得很清楚），但**组件级一个都没做**。中文输入法的组合过程中按 Enter 确认候选词、按 Esc 取消候选，`keyup` 触发时 `isComposing` 往往已经回到 `false`，于是：在「分组名」框里打「前端」选词 → 直接确认创建；在「分支名」框里打中文选词 → 直接建分支并自动切换；在「标签名」框里选词 → 直接创建标签；在仓库/分支切换器里打字选词 → 直接打开仓库 / 切换分支；在重命名框里打中文选词 → 直接改名。填了一半的弹窗按 Esc 取消组合 → 弹窗直接关掉，已填内容丢失。**这是本次审查中唯一会静默改变仓库状态的一类问题**，且中文用户命中率接近 100%。

**最小修复**：抽一个共用守卫，套到全部 20 处组件级键盘处理器上：
```ts
// src/lib/keys.ts
export function guarded<E extends KeyboardEvent>(fn: (e: E) => void) {
  return (e: E) => { if (e.isComposing || (e as any).keyCode === 229) return; fn(e); };
}
```
模板侧统一写成 `@keyup.enter="guarded(confirmCreateBranch)"`；或更省事的做法是在 `main.ts` 里给 `app.config.globalProperties` 挂一个 `v-enter` 指令，用 `addEventListener(..., { capture: true })` 统一拦截。**注意**：`@keyup.esc` 的 7 处与两个切换器的 `@keydown` 必须一起改，只改 `enter` 会留下「Esc 取消组合即关窗」的坑。

---

### [P0] 核心操作是 hover-only 的裸 `<svg>`，键盘与触屏完全不可达

**位置**：`src/components/ChangesPanel.vue:309-314`（取消暂存 `Undo2`）、`src/components/ChangesPanel.vue:363-368`（暂存 `Plus`）、`src/components/ChangesPanel.vue:534/540/546`（stash 恢复 / 恢复并删除 / 删除记录）

**用户可感知的影响**：三处的写法都是 `<Tooltip><Undo2 class="... opacity-0 ... group-hover/li:opacity-80" @click.stop="..." /></Tooltip>`——直接给 lucide 的 `<svg>` 挂 `@click`。后果是三重的：① `opacity-0` 意味着**只有鼠标悬停在该行**图标才显示，触屏和键盘用户看不到它存在；② `<svg>` 不可聚焦，`Tab` 永远到不了，**纯键盘用户做不了「暂存单个文件」「取消暂存单个文件」**，而这正是 git 客户端最高频的操作（只能退而用「全部暂存」）；③ 没有 `aria-label`，即便聚焦了读屏也只会念出一个空图形。stash 三图标更糟：`group-hover/st:flex` 让它连鼠标用户都要先悬停到记录行才出现，而这三个图标各自的后果差异极大（保留记录恢复 / pop / 永久删除）。

**最小修复**：把 5 处图标统一换成 `ui/Button`（`variant="ghost" size="icon"`），并做到「键盘可见」：
```html
<Button variant="ghost" size="icon" class="ml-auto size-6 shrink-0 opacity-0 group-hover/li:opacity-100 focus-visible:opacity-100"
        aria-label="暂存此文件" @click.stop="emit('action', () => api.stage(repo, [f.path]))">
  <Plus class="size-3.5" />
</Button>
```
关键改动是加 `focus-visible:opacity-100`（键盘 Tab 到时可见）和 `aria-label`。stash 的三个图标把 `group-hover/st:flex` 改成 `opacity-0 group-hover/st:opacity-100 focus-within:opacity-100`，且 Trash2 那个要接 `askStashDrop` 已有的确认框（见 P1）。

---

### [P0] 19 个弹层没有 dialog 语义、没有 focus trap、关闭后焦点不归位

**位置**：`src/App.vue:2003,2034,2117,2246,2275,2399,2487,2512,2558,2580,2604,2652,2692,2739,2758`；`src/components/ChangesPanel.vue:563`；`src/components/DiffViewer.vue:257`；`src/components/FileHistoryModal.vue:57`；`src/components/SettingsModal.vue:248`；焦点指令 `src/App.vue:1602-1603`（`vFocus` 只有 `mounted`）

**用户可感知的影响**：每个弹层的结构都是 `fixed inset-0 ... bg-black/50` + 内容卡片，没有 `role="dialog"`、没有 `aria-modal="true"`、没有任何把 Tab 锁在卡片内的逻辑。实际后果：① 在有输入框的弹窗里（如打开仓库、新建标签）按 Tab 走到最后一个按钮后，焦点会**跑到遮罩背后的工具栏和仓库选项卡上**——那些元素视觉上被半透明遮罩压着，用户很难判断焦点在哪，此时按回车会触发背后的操作；② 在**危险操作确认框**（`src/App.vue:2756-2785`）里 Tab 一次就会离开「取消/确认」，Enter 可能落到背后元素上；③ `vFocus` 只有 `mounted`，关闭弹窗后焦点直接掉到 `<body>`，键盘用户丢失位置，要重新 Tab 一圈才能继续；④ 读屏用户完全感知不到弹窗出现（无 `aria-modal`、无焦点转移声明）。`ui/ContextMenu.vue` 是唯一做对了键盘导航的组件，说明能力是有的，只是没推广到弹层。

**最小修复**：抽一个 `src/components/ui/Modal.vue` 承载全部 19 个弹层，内部实现三件事：
```ts
// 1) 打开时把焦点移进卡片（优先 autoFocus 元素，否则卡片本身）
onMounted(() => { (cardEl.value?.querySelector<HTMLElement>("[autofocus],input,button") ?? cardEl.value)?.focus(); });
// 2) focus trap：卡片根加 tabindex="-1"，keydown 时按 Tab 在卡片内可聚焦元素间循环
function onTab(e: KeyboardEvent) { /* 取 cardEl 内 focusable 列表，首尾回环 */ }
// 3) 关闭后归位：记录 document.activeElement，unmount 时 restore
```
模板侧统一 `<div role="dialog" aria-modal="true" :aria-labelledby="titleId">`。这一步同时能顺手解决 P2 的「弹窗宽度 10 档不统一」。

---

### [P1] 「关闭仓库选项卡 / 关闭其他」标了 `danger: true` 却不弹确认，而非破坏性的「合并分支」反而要确认

**位置**：`src/App.vue:2353`（`{ label: "关闭", danger: true, fn: () => closeTab(tabCtx!.path) }`）、`src/App.vue:2354`（`{ label: "关闭其他", fn: () => closeOthers(tabCtx!.path) }`）、`src/App.vue:1760-1765`（选项卡 X 直接 `closeTab`）、`closeTab` `src/App.vue:706-738`、`closeOthers` `src/App.vue:760-766`；对照 `askMerge` `src/App.vue:1423-1426`

**用户可感知的影响**：菜单渲染逻辑是「`danger: true` → `text-destructive`」（`ui/ContextMenu.vue:105`），所以用户看到红色的「关闭」，心理预期是「会问一下」，结果点了就关。`closeTab` 会同时 `repoCache.delete(path)` 丢弃该仓库的 LRU 快照和 `mruPaths` 记录，**「关闭其他」更是一次移除屏幕上所有别的仓库且零反馈**——用户手滑一次，整个工作区标签就剩一个，只能靠「打开」一个个加回来。反过来，合并不丢数据却要走 420px 确认框，这会训练用户「确认框=啰嗦」的肌肉记忆，等真正危险的操作出现时反而被无脑回车掉——**确认框的稀缺性被稀释了**。

**最小修复**：两处都接已有的 `openConfirm`，并把「关闭」从 `danger` 降级为普通项（它不删磁盘数据）：
```ts
{ label: "关闭", fn: () => closeTab(tabCtx!.path) },
{ label: "关闭其他", fn: () => openConfirm({
    title: "关闭其他仓库选项卡",
    body: `将关闭除「${repoByPath.get(tabCtx!.path)?.name}」外的 ${repos.value.length - 1} 个选项卡（不会删除磁盘上的仓库，可用「打开」重新加入）。`,
    ok: () => closeOthers(tabCtx!.path),
  }) },
```
同时把「合并分支」的确认框去掉或改成一条可撤销的内联提示（`toast` + 「撤销合并」按钮更合适）。判定规则建议写进 AGENTS.md：**只有「可能丢弃工作区/历史改动」的操作才配居中确认框，视图层级的移除一律用「可撤销的轻确认」**。

---

### [P1] 「确认」一词在危险框与错误框里语义相反，「确定 / 确认 / 好的」三套并存

**位置**：危险操作确认框按钮 `src/App.vue:2781`（文案「确认」，`variant="destructive"`）；错误框按钮 `src/App.vue:2750`（文案也是「确认」，`variant="secondary"`）；重命名类弹窗按钮 `src/App.vue:2503`、`src/App.vue:2572`、`src/App.vue:2594`（文案「确定」）；克隆弹窗 `src/App.vue:2100-2108`（「取消 / 克隆并打开」）；工作流确认 `src/App.vue:2680-2686`（「取消 / 执行」）

**用户可感知的影响**：同一个词「确认」在并排两个弹窗里表达两种相反的动作——危险框里是「**执行这个不可逆操作**」，错误框里是「**我知道了，关闭**」。用户建立了「看到『确认』要小心」的直觉后，在错误框里会犹豫；反之习惯了「点『确认』就是关窗」之后，在危险框里可能形成误点惯性。另外「确定」和「确认」在中文里没有可感知的区分，三个弹窗用前者、两个弹窗用后者，纯属随机。

**最小修复**：按「动词开头 + 与标题呼应」统一：
- 危险确认框：按钮文案改成具体动词 —— `confirmState` 增加 `okText?: string` 字段，`askDelete` 传「删除分支」、`askDiscardUnpushed` 传「丢弃 N 个提交」、`askStashDrop` 传「删除记录」，默认回落到「确认执行」。这比任何警告文案都有效，因为它把后果写在了按钮上。
- 错误框：改成「知道了」或「关闭」。
- 重命名/新建类：全部统一成「保存」或各自的动词（「创建」「重命名」），去掉「确定」。

---

### [P1] 快捷守卫不一致 + 全局快捷键不区分焦点，输入框里也在抢键

**位置**：`src/App.vue:1541-1577`（`onGlobalKeydown` 只挡 `isComposing`，不判 `document.activeElement` 是否为输入框）；`src/App.vue:614-634` 与 `src/App.vue:1140-1157`（两个切换器的 `@keydown` 无守卫）；`src/App.vue:1557-1560`（无仓库时也 `preventDefault`）

**用户可感知的影响**：`Ctrl+Tab` / `Ctrl+1..9` / `Ctrl+P` / `Ctrl+B` / `Ctrl+Shift+L` / `Ctrl+Shift+R` / `F5` 在**任何**输入框里都生效。用户在提交信息框里想用 `Ctrl+1` 做别的（很多编辑器里是跳转书签），或者只是想用 `Ctrl+Shift+R`（某些输入法/编辑器的组合），窗口就切走了；在设置弹窗的输入框里按 `Ctrl+B`，分支切换器会盖在设置弹窗之上（`z-50` vs `z-30`，`src/App.vue:2510` vs `src/App.vue:248`），层级关系瞬间混乱。「无仓库时 `Ctrl+P` 也 `preventDefault`」则是纯粹的按键吞噬（用户按 Ctrl+P 期望打印/无响应，却什么提示都没有）。

**最小修复**：在 `onGlobalKeydown` 开头加焦点判断，并把「无仓库」的情况显式放过：
```ts
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  const el = document.activeElement as HTMLElement | null;
  const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  // 输入框内只放行「全局导航」类快捷键，其余交给输入框
  const allowInInput = e.ctrlKey && e.key === "Tab";
  if (typing && !allowInInput && e.key !== "Escape") return;   // Esc 仍要能关弹窗
  ...
  if (e.ctrlKey && (e.key === "p" || e.key === "P")) { if (!repo.value) return; ... }
}
```
两个切换器的 `@keydown` 用 P0 里那个 `guarded()` 包一层。同时把 `Ctrl+B` / `Ctrl+Shift+L` / `Ctrl+Shift+R` 补进 `SettingsModal.vue:183-192` 的 `SHORTCUTS` 表和 `README.md:74-81`。

---

### [P1] 文档承诺与实现不符：README 与设置里都写「双击分支」，代码是单击

**位置**：`README.md:79`（`| 双击分支 | 切换 / 建立跟踪分支 |`）、`src/components/SettingsModal.vue:189`（同样的表述）、实现 `src/components/BranchTree.vue:6`（注释「单击切换（对齐 VS Code / GitHub Desktop 惯例）」）与 `src/components/BranchTree.vue:58`（`@click="!n.branch!.current && emit('switch', n.branch!)"`）、`src/App.vue:1352-1353`（注释「单击触发（对齐主流客户端）」）

**用户可感知的影响**：文档说双击、实现是单击，方向是「实现更激进、文档更保守」。实际风险有两个：① 用户按文档双击，第一次单击就已经切分支了，第二次单击落在新渲染的列表上可能点到**另一行**——切换分支是带 `checkout` 的写操作（脏工作区还会弹确认框，`src/App.vue:1363-1376`），双击一次触发两次 checkout 是真实的误操作路径；② 同一份文档里「双击历史行 / 文件」（`README.md:80`）确实是两次单击模拟的（`HistoryGraph.vue:45-50`、`ChangesPanel.vue:133-138`），两套语义并存却没有一处说明，用户只能靠试。

**最小修复**：二选一，不要继续糊着走。
- 方案 A（推荐，改动最小）：把 `README.md:79` 与 `SettingsModal.vue:189` 改成「单击分支 → 切换（脏工作区会先确认）」，并在分支行 `title` 里补上（当前 `BranchTree.vue:57` 的 title 已经写了「（点击切换，右键更多操作）」，只是文档没跟上）。
- 方案 B：让分支切回双击，与历史行一致；但需要在 `BranchTree.vue` 里加 200ms 防抖，否则双击的第一下仍会触发。

无论选哪个，都建议在 `docs/NOTES.md` 里记一条「单击 = 切换/选中，双击 = 打开重内容（diff/历史）」的全局约定，并让 `ChangesPanel` 的行、`HistoryGraph` 的行、`DiffViewer` 的文件列表都遵守它——目前这三处已经一致（都是「两次单击」），只有文档是例外。

---

### [P1] 四套反馈机制无明确分工，同类操作各用一套

**位置**：居中确认框 `src/App.vue:2756-2785`；右键菜单 `ui/ContextMenu.vue`；toast `ui/toast.ts:13-21` + `ui/Toast.vue:7-16`（2.4s 自动消失，最多 4 条）；原生 `title` tooltip（`BranchTree.vue:36,57`、`CommitHeatmap.vue:158`、`DiffViewer.vue:301,331`、`ChangesPanel.vue:528`）；`ui/Tooltip.vue`（`App.vue` 等 28 处）；工作流删除的两段式按钮 `SettingsModal.vue:447-468` + `SettingsModal.vue:109-120`

**用户可感知的影响**：同为「删除」这个动作，用户在四个地方会遇到四种不同的防护：**删分支**弹 420px 红框（`src/App.vue:1400`）、**删标签**弹红框（`src/App.vue:1020`）、**删工作流**要连点两次同一个按钮且 2.5 秒后自动复位（`SettingsModal.vue:109-120`）、**删选项卡**什么都不问（`src/App.vue:2353`）。用户无法形成「删东西会发生什么」的稳定预期，每次都要重新试探。另外 `toast` 只承担成功反馈（`ui/toast.ts` 注释「只承载『成功反馈』」），但 `closeTab` 的「已关闭…」是**事后补偿**式的提示——它告诉用户「还能加回来」，却不给「撤销」按钮，用户要么立刻去点「打开」，要么就忘了。

**最小修复**：写一页 `docs/NOTES.md` 的「反馈机制分工」，然后按它收敛代码：
| 机制 | 适用场景 | 当前越界处 |
|---|---|---|
| 居中确认框 | 可能丢失工作区/历史改动的操作 | `askMerge`（非破坏，应改轻确认） |
| 轻确认（两段式按钮 / inline 二次点击） | 视图层级移除、可恢复配置 | 目前只有工作流删除在用；应推广到关闭选项卡、删除工作流步骤、删除分支前缀 |
| toast | 操作成功、可撤销提示 | `closeTab` 应加一个「撤销」按钮，4 秒内可回滚 |
| 原生 `title` | 逐行 / 大量元素（性能考虑） | ✅ 遵守了 AGENTS.md 约定，但 `HistoryGraph.vue:210` 违反（见 P2） |

同时把「删除工作流」的两段式加上明确的视觉反馈（当前只有文字从「删除」变「确认删除？」，`SettingsModal.vue:467`，且 2.5s 的 `setTimeout` 让用户永远不知道窗口还剩多久）——建议改成 5 秒并在按钮上叠一个进度条，或者干脆统一用轻确认。

---

### [P1] 对比度：catppuccin-latte 有 10 项不达标，所有主题的 Badge 半透明底全部不达标

**位置**：token 定义 `src/style.css:5-160`；Badge 半透明底 `ui/Badge.vue:11-15`；选中行 `ui/*` 与列表 `ChangesPanel.vue:295,355`、`HistoryGraph.vue:200`、`DiffViewer.vue:299`、`FileHistoryModal.vue:78`；热力图 `CommitHeatmap.vue:25`

**用户可感知的影响**：AA 要求非大号文本 ≥4.5:1，实测（WCAG 相对亮度公式，含半透明合成）：

| 组合 | dark | light | mocha | latte | one-dark | gh-dark |
|---|---|---|---|---|---|---|
| `muted-fg / muted`（次要文字在最深的 muted 卡片上） | 5.46 | **3.95** | **4.45** | **2.56** | **2.81** | 4.95 |
| `muted-fg / background` | 6.34 | **4.31** | 5.81 | **3.49** | **3.73** | 6.15 |
| `primary` 当文字色 `/ background` | 5.83 | **4.46** | 5.04 | **4.12** | **4.30** | 5.81 |
| `destructive / background` | 6.54 | **4.13** | 5.65 | **3.81** | 4.82 | 6.52 |
| `primary-foreground / primary`（实心主按钮） | 5.78 | **4.04** | 5.78 | 4.66 | 5.78 | 5.78 |
| `diff-add-text / diff-add-bg` | 6.66 | **4.44** | 6.66 | **4.44** | 6.66 | 6.66 |
| Badge default（`primary` on `primary/20`） | **4.11** | **3.59** | **4.01** | **3.02** | **3.53** | **3.98** |
| Badge danger（`destructive` on `destructive/15`） | 4.97 | **3.54** | 4.88 | **2.95** | **4.27** | 4.84 |
| 选中行（`primary` on `primary/10`） | 4.83 | **4.10** | 4.73 | **3.41** | **4.11** | 4.65 |
| 热力图 L1（`primary/25` vs card，非文本需 3.0） | **1.45** | **1.39** | **1.46** | **1.35** | **1.47** | **1.46** |
| 热力图 L2（`primary/45` vs card） | **2.10** | **1.86** | **2.10** | **1.75** | **2.04** | **2.09** |

（`*` 表格中加粗即不达标值）具体影响：**catppuccin-latte 是最差主题**——它是浅色主题却沿用了浅色组的状态色，`muted-foreground #7c7f93` 压在 `#ccd0da` 上只有 2.56:1，等于时间戳、作者名、次要说明这些 10.5-11px 的小字在浅紫底上几乎看不见；Badge danger 2.95:1 低于 3:1 的非文本底线，「未暂存」的红色计数几乎是糊的。**light / github-light 系**的 `muted-foreground`（4.31）和实心主按钮文字（4.04）也在临界值下方。**所有主题的 Badge default 变体都不达标**（最高 4.11），因为它用了 20% 半透明主色打底、再用主色写字，前景背景同色系天然压缩了对比度。热力图的问题是**相邻档位不可区分**：L1 与 L0 的亮度比只有 1.09-1.46，用户在浅色主题下分不出「1-2 次提交」和「无提交」。

**最小修复**（按性价比排序）：
1. 热力图档位换成**离散色阶**而不是透明度堆叠，写进 `style.css` 当 token：`--heat-0: var(--muted); --heat-1: #9be9a8; --heat-2: #40c463; --heat-3: #30a14e; --heat-4: #216e39;`（浅色，GitHub 同款）+ 深色主题一档覆盖。透明度方案在任何主题下都做不出「相邻可区分 + 单档 ≥3:1」。
2. `ui/Badge.vue:11-15` 的 default 变体把文字色从 `text-primary` 换成 `text-foreground`（对比度直接到 12+），或把底色提到 `bg-primary/30` 并把文字改成 `text-primary-foreground`——但后者在 latte 下仍只有 3.0 左右，所以推荐前者。danger / info / warning 统一把透明度从 `/15` 提到 `/20` 并让文字走 `-foreground` 系。
3. `style.css` 的 `[data-theme="catppuccin-latte"]` 块里把 `--muted-foreground` 从 `#7c7f93` 压深到 `#5c5f73`（对 `#ccd0da` 可到 4.6+），`--destructive` 压深到 `#b91c26`。
4. light / github-light 的 `--muted-foreground` 从 `#767680` 压到 `#6b6b75`（对 `#fafafa` 到 4.9），`diff-add-text` 从 `#1a7f37` 压到 `#146c2e`。
5. 选中行的 `bg-primary/10` 提到 `/15` 并保留 `text-foreground`（不要用 `text-primary` 当行文字色，`ChangesPanel.vue:295` 目前只有底色没有文字变色，这个是安全的）。

> 附：`border / card` 在全部主题下只有 1.26-1.92，低于 WCAG 1.4.11 的 3:1。但分隔线属于装饰性边框，且 shadcn 体系普遍如此，本次不作为缺陷列——如果要做，`--border` 需要在暗色主题提到 `#3a3a46` 以上。

---

### [P1] 加载 / 分页 / 错误态三处反馈缺失

**位置**：分页逻辑 `src/App.vue:206-221`（`canLoadMore` / `loadingMore` 标志位）；触发 `HistoryGraph.vue:28-31`（`if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) emit("loadMore")`）；错误框 `src/App.vue:2736-2753`；组件内联错误 `ChangesPanel.vue:441`（`aiErr`）、`ChangesPanel.vue:519`（`stashErr`）、`DiffViewer.vue:313`、`DiffViewer.vue:349`（`explainErr`）、`FileHistoryModal.vue:73`、`SettingsModal.vue:625`（`verifyErr`）

**用户可感知的影响**：① **分页没有可见指示**：`loadingMore` 这个 ref 在整个模板里没有任何渲染（grep `canLoadMore` 只有脚本里的 9 处赋值），用户滚到 300 条底部时页面静止，无法判断「到底了」还是「正在加载」还是「卡住了」——只能等。② **错误框没有重试按钮**：不管是网络问题导致 fetch 失败还是 git 命令返回非零，用户看到的都是 `w-460px` 的红框 + 「确认」一个按钮（`src/App.vue:2750`），想重试只能先关掉再手动找到原入口重来。③ **组件内联错误全部绕过 `humanize()`**：`src/App.vue:81-101` 的 14 条正则把 git stderr 翻译成人话，但只覆盖 `run()` / `showError()` 这条路径；AI 生成、diff 加载、文件历史、stash 列表这 6 处都是 `String(e).replace(/^Error: /, "")` 直出，用户会看到 `fatal: not a git repository` 这种英文原文。④ **全项目 0 个骨架屏**：仓库切换时是 `App.vue:1904-1911` 的整块 `bg-background/60` 遮罩 + Spinner，历史区尺寸不变但内容跳变，长列表刷新时视觉抖动明显。

**最小修复**：
- 分页指示：在 `HistoryGraph.vue:172` 的占位 `div` 末尾加一行固定高度的加载条，由 props 控制：
  ```html
  <div v-if="props.loadingMore" class="flex h-[26px] items-center justify-center gap-2 text-xs text-muted-foreground">
    <Spinner :size="12" />正在加载更多…
  </div>
  <div v-else-if="!props.canLoadMore" class="h-[26px] text-center text-[11px] text-muted-foreground">已到底部</div>
  ```
- 错误框重试：`ConfirmState` 加 `retry?: () => Promise<unknown>`，`run()` 的 catch 里存下当前 fn，错误框按钮区改成「取消 / 重试」。
- 内联错误统一走人话：把 `humanize` 从 `App.vue` 提到 `src/lib/errors.ts`，6 处组件内联错误改成 `humanize(e).msg`。
- 骨架屏：`HistoryGraph` 在 `historyLoading && !commits.length` 时渲染 8 行灰条（`h-[26px] animate-pulse rounded bg-muted`），比整屏 Spinner 稳定得多。

---

## 三、P2

### [P2] 超长内容截断覆盖不全，长作者名会撑破历史行
**位置**：`HistoryGraph.vue:220`（`<span class="shrink-0 text-[11.5px] text-muted-foreground">{{ c.author }} · {{ c.date }}</span>` 无 `truncate` / `max-w`）、`FileHistoryModal.vue:80`（`{{ c.hash.slice(0,8) }} · {{ c.author }} · {{ c.date }}` 无 `truncate`）、对照 `HistoryGraph.vue:211`（subject 有 `truncate`）、`App.vue:1758`（tab 名有 `max-w-[120px] truncate`）、`App.vue:1638`（仓库路径有 `max-w-[340px] truncate`）
**用户可感知的影响**：`HistoryGraph.vue:220` 是 `shrink-0`，作者名超长时会**优先挤掉左侧的 commit subject**（subject 是 `flex-1 truncate`，会被压到只剩几个字符），而 git 提交里的作者名完全可能是 `Zhang Wei (Contractor) <zw@vendor.example.com>` 这种长度。`FileHistoryModal.vue:80` 没有 `truncate` 也没有 `shrink-0`，长文本会换行，把固定 `ROW_H` 之外的列表行撑高（这个列表不是虚拟滚动，撑高只影响观感）。
**最小修复**：`HistoryGraph.vue:220` 改成 `<span class="max-w-[38%] shrink-0 truncate text-[11.5px] ...">` 并加 `:title="`${c.author} · ${c.date}`"`；`FileHistoryModal.vue:80` 加 `truncate` + `title`。

### [P2] `HistoryGraph` 逐行使用 `ui/Tooltip`，违反项目自己写下的性能约定
**位置**：`HistoryGraph.vue:210`（`<Tooltip :text="tip(c)">`）、约定出处 `AGENTS.md`「逐行/diff 场景用原生 title 做 tooltip（数百行包 Tooltip 组件实例会卡）；按钮类才用 ui/Tooltip」、同类正确做法 `DiffViewer.vue:322-331`（每行 `:title="tipFor(l)"`）、`CommitHeatmap.vue:158`（`:title`）
**用户可感知的影响**：`tip(c)` 只是拼一个四行字符串（`HistoryGraph.vue:34-43`），却为此给每个可见行实例化了一个 `Tooltip` 组件（内部会 `Teleport` 到 body 并注册 `scroll.capture` 监听）。虚拟滚动把实例数压在 ~60 个可视行，暂时不会卡，但**渲染行数一旦调整（BUFFER 从 30 调大、或未来取消虚拟滚动）就会立刻退化**，而且这属于「明知约定却主动违反」，会让后来者以为逐行 Tooltip 是可以接受的。
**最小修复**：`HistoryGraph.vue:210-218` 的 `<Tooltip :text="tip(c)">` 换成 `<span class="flex-1 truncate" :title="tip(c)">`，删掉 tooltip 的实例化。视觉上零差异（原生 title 有多行支持，`tip()` 已经在用 `\n` 连接）。

### [P2] 弹窗宽度 10 档、字号 8 档，无统一尺度
**位置**：弹窗宽度 `w-[360px]`（`App.vue:2490,2561,2583`）、`w-[380px]`（`App.vue:1925` 欢迎卡、`ChangesPanel.vue:566`）、`w-[400px]`（`App.vue:2006,2120`）、`w-[420px]`（`App.vue:2761`）、`w-[440px]`（`App.vue:2655,2695`）、`w-[460px]`（`App.vue:2742`）、`w-[480px]`（`App.vue:2037,2608`）、`w-[520px]`（`App.vue:2402,2515`）、`w-[640px]`（`App.vue:2249,2278`）、`w-[880px]`（`SettingsModal.vue:250`）；字号 `text-[9px]`(3) / `[10px]`(5) / `[10.5px]`(10) / `[11px]`(69) / `[11.5px]`(1) / `[12px]`(1) / `[12.5px]`(3) / `[13px]`(15)
**用户可感知的影响**：相邻宽度的弹窗（400 / 420 / 440 / 460 / 480）肉眼几乎分不出差异，用户感受不到「这个弹窗更小 = 这件事更轻」的信息层级。字号更明显：`text-[11px]` 用了 69 次是事实上的正文，但同时也存在 `text-[10.5px]`（Badge）、`text-[11.5px]`（历史行作者）、`text-[12.5px]`（列表项）、`text-[13px]`（输入框）四个近邻档——这些值在 12-13px 区间内密集堆叠，用户读到的「层级」是随机的而非设计的。
**最小修复**：在 `src/style.css` 的 `@theme inline` 块里定义语义化字号并全局替换：
```css
@theme inline {
  --text-micro: 10px;    /* 计数、图例 */
  --text-mini: 11px;     /* 次要说明、时间戳 */
  --text-body: 12.5px;   /* 正文、列表项 ← 把 69 处 text-[11px] 提到这里 */
  --text-input: 13px;    /* 输入框、标题 */
}
```
弹窗宽度收敛为 `sm 380 / md 480 / lg 640 / xl 880` 四档，写进统一的 `Modal.vue`（与 P0 的弹层重构合做）。

### [P2] 中文标题配 `uppercase tracking-wider`，16 处做了无意义的事
**位置**：`App.vue:1783`（「分支」）、`App.vue:2365`（分组名）、`ChangesPanel.vue:272`（「已暂存」）、`ChangesPanel.vue:321`（「未暂存」）、`ChangesPanel.vue:508`（「Stash · 暂存架」）、`DiffViewer.vue:342`、`SettingsModal.vue:279,297,305,345,364,385,411,433,596,608`
**用户可感知的影响**：中文没有大小写，`uppercase` 是空操作；`tracking-wider`（+0.05em）会让汉字的字距变得松散，标题和正文之间的对比反而被削弱——视觉上像是「忘了改的英文样式」。`ChangesPanel.vue:508` 的「Stash · 暂存架」里 "Stash" 会被转成全大写 "STASH"，是全项目唯一能看到 `uppercase` 生效的地方，反而让中英混排更刺眼。
**最小修复**：16 处统一删掉 `uppercase tracking-wider`，改成 `text-[11px] font-medium text-muted-foreground`。

### [P2] 空态文案颗粒度不一，最简陋的只有一个「无」字
**位置**：`ChangesPanel.vue:316` 与 `ChangesPanel.vue:370`（都是 `<li>无</li>`）、`App.vue:1920-1922`（「暂无提交」）、`App.vue:1853-1855`（「无匹配标签」/「暂无标签 · 右键组头新建」）、`HistoryGraph.vue:169-171`（「无匹配提交」）、`ChangesPanel.vue:553-555`（「暂无 stash 记录」）、`App.vue:2548`（「没有匹配的仓库」）、`App.vue:2642`（「没有匹配的分支」）、`FileHistoryModal.vue:73`（「该文件没有提交历史（可能是新文件）。」）、`App.vue:2383`（「空分组 · 点右下角「管理分组」添加仓库」）
**用户可感知的影响**：写得最好的是 `App.vue:1924-1951` 的整页欢迎卡（图标 + 两行引导 + 最近仓库列表）和 `App.vue:1218` 附近的空分组。最差的是变更面板的两个「无」——用户看到「已暂存 / 未暂存」两个区各一个「无」，无法确认是「真的干净」还是「状态还没加载出来」。另外 `App.vue:2383` 的「点**右下角**『管理分组』添加仓库」**位置描述是错的**：`管理分组` 按钮实际在标签栏右侧（`App.vue:1769-1773`，`class="mr-1 mb-0.5"` 在标签栏流内），不在「右下角」；真正的右下角是变更面板。这条文案会直接把用户引向错误的屏幕区域。
**最小修复**：① `ChangesPanel.vue:316` / `370` 分别改成「工作区没有暂存内容」、「没有未暂存的改动」，并配 `size-4` 的灰色图标；② `App.vue:2383` 改成「空分组 · 点标签栏右侧的「管理分组」添加仓库」；③ 统一空态模板：图标 + 一句状态说明 + （可选）一个行动按钮，抽成 `ui/EmptyState.vue`。

### [P2] 响应式：最小窗口 860px 下左右侧栏已占 61%，拖宽上限不考虑窗口宽度
**位置**：`src-tauri/tauri.conf.json`（`minWidth: 860`、`minHeight: 520`）、默认宽度 `src/App.vue:1580-1581`（`leftW` 208 / `rightW` 320）、clamp `src/App.vue:1591-1592`（左 `Math.min(420, Math.max(140, e.clientX))` / 右 `Math.min(520, Math.max(240, window.innerWidth - e.clientX))`）、固定宽 `DiffViewer.vue:258`（`w-[80vw]`）、`FileHistoryModal.vue:58`（`w-[85vw]` + 左栏 `FileHistoryModal.vue:68` 固定 `w-64`）、`SettingsModal.vue:250`（`w-[880px] max-w-[95vw]` + 左导航 `SettingsModal.vue:252` 固定 `w-36`）
**用户可感知的影响**：任务书要求的 800px / 600px 在真实窗口下不可达（`minWidth: 860`），但 860px 下左右侧栏合计 208 + 320 = 528px 已经吃掉 61%，历史区只剩 ~330px。此时 `App.vue:1880-1901` 的工具条里 `Select` 固定 `w-24`（96px）+ 文件过滤 chip + 搜索框挤在一行，搜索框会被压到几十像素宽。更糟的是**两个 clamp 是独立的**：用户可以先把左栏拖到 420、再把右栏拖到 520，合计 940px > 860px，**历史区被压成 0 甚至溢出到窗口外**——clamp 里没有「为对方留出最小宽度」的约束。`DiffViewer` 的 `w-[80vw]` 在 860px 下是 688px、`FileHistoryModal` 的 `w-[85vw]` 是 731px，减去固定 256px 左栏后右栏还有 475px，这两个是安全的。
**最小修复**：把两个 clamp 改成互相约束，并给历史区加最小宽度保护：
```ts
const MIN_HISTORY = 320;
function onResizeMove(e: MouseEvent) {
  if (resizing === "l") leftW.value = Math.min(420, Math.max(140, e.clientX));
  if (resizing === "r") {
    const maxRight = Math.min(520, window.innerWidth - leftW.value - MIN_HISTORY);
    rightW.value = Math.max(240, maxRight);
  }
}
```
同时在 `App.vue:1776` 的主容器上加 `min-w-0`（`flex` 子项默认 `min-width: auto`，`section` 已经有 `min-w-0`，但侧栏拖宽会把整个 flex 行推出去）。另外给窗口 resize 加一个监听，在 `innerWidth` 变小时按比例收缩两侧（当前 localStorage 里的固定 px 值不会随窗口自适应）。

### [P2] 迁移到「人类可读错误」的只有主路径，6 处组件内联错误直出英文 stderr
**位置**：`src/App.vue:81-101`（`humanize()` 的 14 条规则，覆盖 `/rejected.*fetch first/` `→` 「远程有新提交，先 Pull 再 Push」、`/conflict/i` `→` 「产生合并冲突，请在终端解决后再试」等）；未覆盖处 `src/App.vue:839`（`reviewErr`）、`src/App.vue:914`（`notesErr`）、`ChangesPanel.vue:261`（`aiErr`）、`ChangesPanel.vue:101`（`stashErr`）、`DiffViewer.vue:109`（`explainErr`）、`FileHistoryModal.vue` 的 `err`/`diffErr`
**用户可感知的影响**：同样是「AI 调用失败」，走 `run()` 的路径会看到中文人话，走内联错误的就是 `Error: 401 Unauthorized` 或 `TypeError: Failed to fetch`——用户不知道是 Key 配错了、额度用完了还是网络断了，因为原文里没有这些信息。`DiffViewer.vue:313` 的 diff 加载失败更是只显示一行红字，连「原始 stderr」都没地方展开（只有 `App.vue:2745-2748` 的错误框有 `<details>`）。
**最小修复**：`humanize()` 提到 `src/lib/errors.ts` 变成纯函数（它现在依赖 `App.vue` 里的 ref，需要一起拆），6 处改成 `humanize(String(e)).msg`。AI 相关的再加 3 条规则（`401/403 → 「API Key 无效或权限不足，请到设置里检查」`、`429 → 「请求过于频繁，稍后再试」`、`fetch|NetworkError → 「无法连接 AI 服务，检查 Base URL 和网络」`）。

### [P2] 标签行的 `cursor-pointer` 是骗人的，单击没有任何反馈
**位置**：`App.vue:1844-1852`（`<li class="flex cursor-pointer items-center gap-1 py-1.5 pr-3 pl-6 hover:bg-muted" ... @contextmenu.prevent="tagMenu = ...">`，只有 `@contextmenu` 没有 `@click`）、对照分支行 `BranchTree.vue:50-59`（有 `@click`）
**用户可感知的影响**：鼠标移上去变手型、行有 hover 高亮，用户点一下——什么都没发生。这是最容易被判定为「应用卡了」的交互模式。加上「标签」的所有操作（新建、推送、删除）**只能通过右键触发**（组头 `App.vue:1832-1842` 的 `@contextmenu.prevent`，行 `App.vue:1849`），键盘用户更是完全无法触达（已在表 4 记录）。
**最小修复**：要么给 `@click` 一个明确语义（推荐：单击选中 + 在底部状态栏显示标签指向的 commit，双击跳转到该 commit），要么去掉 `cursor-pointer` 与 `hover:bg-muted`，让它看起来就是只读信息。同时给标签组头补一个可见的「+」按钮（`App.vue:1832-1842` 的组头右侧已经有计数 `ml-auto` 的位置，可以再放一个 `size-3` 的加号），把右键入口变成第二入口而不是唯一入口。

---

## 四、P3

- **`onMounted` 注册的全局监听没有 `onUnmounted` 清理**：`src/App.vue:1605-1616` 注册了 `window.addEventListener("focus", ...)` 和 `"keydown"`，但整个 `App.vue` 没有 `onUnmounted`。单实例根组件下影响为零，但会导致 HMR 期间监听器叠加（开发时表现为「按一次 F5 刷新两次」）。**修复**：补 `onUnmounted` 清理，或把 `onGlobalKeydown` 挂到 `<div @keydown>` 上改为模板绑定。
- **复制失败也弹整块「操作失败」红框**：`src/App.vue:780`（`copyText` 的 `.catch(() => showError("复制失败"))`）。复制剪贴板失败是个轻量失败，弹 460px 红框 + 需要点「确认」才能继续，反馈过重。**修复**：改成 `toast("复制失败（剪贴板不可用）")`，或者干脆给 `navigator.clipboard` 加一个 `document.execCommand('copy')` 的降级路径。
- **`DiffViewer` 行号用 `opacity-45` 而不是 token 色**：`DiffViewer.vue:331`（`<span class="w-10 shrink-0 select-none pr-1.5 text-right opacity-45">`）。在 dark 主题下行号是 `#e8e8ee` 打 45% 叠在 `#223326`/`#3a2226` 的 diff 行背景上，实际对比度只有 ~2.5:1，长 diff 里对行号几乎不可读。**修复**：改用 `text-muted-foreground`，并按新增/删除行给 `--diff-add-text` / `--diff-del-text` 的 60% 版本（新增 token）。
- **`SettingsModal` AI 关闭时用 `pointer-events-none opacity-40`**：`SettingsModal.vue:310`。这个组合只挡鼠标，**内部的输入框仍然可以 Tab 聚焦并输入**——用户在 AI 关闭状态下把 API Key 打进去，以为配置生效了，实际 `aiConfigured()`（`src/App.vue:800` 附近）会因为 `settings.aiEnabled !== "on"` 直接返回 false。**修复**：改成 `:disabled="!aiOn"` 透传到每个子输入框，或用 `<fieldset :disabled="!aiOn">` 包住（原生 fieldset 会真正禁用内部全部表单控件）。
- **裸 `<input>` 不跟随主题的焦点样式**：`SettingsModal.vue:396-403`（分支前缀输入框 `class="min-w-[140px] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"`）直接写了 `outline-none` 且没有 `focus-visible:` 补偿，加上它 `bg-transparent` 没有边框，**键盘 Tab 到这个框时完全看不出焦点在哪**。**修复**：删掉 `outline-none`（全局 `:focus-visible` 会接管），或补 `focus-visible:outline-2 focus-visible:outline-primary/60`。
- **`Viewer` 关闭态文件名仍用 Tooltip 组件包长文本**：`App.vue:1757-1759` 给每个仓库选项卡的截断名包了一层 `ui/Tooltip`。仓库数量少（LRU 默认 5），开销可以接受，但与 `App.vue:1638` 用 `Tooltip` 显示仓库路径一样，属于「长文本提示用组件实例」——如果未来支持同时打开几十个仓库，应该切回原生 `title`。**修复**：留作观察项，写进 `docs/NOTES.md` 的「Tooltip 使用边界」即可。

---

## 五、视觉细节打磨建议

按「改一行就能看到效果」排序，全部具体到 class：

1. **`ChangesPanel.vue:311` / `365`：`opacity-0` → `opacity-0 ... focus-visible:opacity-100`**。同时把 hover 触发的不透明度从 `group-hover/li:opacity-80` 提到 `:opacity-100`——现在悬停时图标只有 80% 不透明度，在 `bg-muted` 的 hover 行底色上显得脏。
2. **`HistoryGraph.vue:199`：`hover:bg-muted/60` → `hover:bg-muted`**。历史行、变更行、分支行现在有三种 hover 力度（`hover:bg-muted` / `hover:bg-muted/60` / `hover:bg-muted/40`），统一成 `hover:bg-muted` 能让「行可交互」的暗示一致。
3. **`ui/Badge.vue:7`：加 `gap-1`**。当前 `inline-flex items-center rounded-full px-2 py-0 text-[10.5px]` 没有 `gap`，如果 Badge 内容是「图标 + 数字」（如 `App.vue:1640` 的 `↓{{ status.behind }}` 将来加图标）会贴在一起。
4. **`App.vue:1783` 等 16 处：`text-[11px] uppercase tracking-wider` → `text-[11px] font-medium`**（同 P2 的 16 处，此处只做删除，不引入新尺寸）。
5. **`ChangesPanel.vue:272` / `321`：区头加 `sticky top-0 z-10 bg-card/95 backdrop-blur-sm`**。两个列表各自的滚动容器是 `max-h-[34%]` 和 `min-h-[80px] flex-1`，长列表滚动时「已暂存」这个标题会滚出视野，用户滑到一半分不清自己在看哪个区。
6. **`ui/Button.vue:7`：`active:scale-[.98]` → `active:scale-[.97]`**，并给 `transition-[color,background-color,border-color,transform]` 补上 `will-change-transform`。98% 缩放在 28-32px 高的按钮上只有 0.3-0.6px 的位移，肉眼几乎察觉不到；97% 配合已有的 `duration-150` 才有「按下去」的实感。
7. **`App.vue:1789`：`left-4.5` 与输入框的 `pl-7` 配对过于隐式**，建议在 `ui/` 下加一个 `<SearchInput>` 组件（内部固定 `relative` 容器 + 图标 `left-3` + `Input class="pl-8"`）。现在项目里有 3 处搜索框（`App.vue:1787-1792` 分支、`App.vue:1898-1901` 历史、`App.vue:2520-2526` 切换器），图标位置分别是 `left-4.5` / 未标 / `pl-8`，三处不一致。
8. **`App.vue:2017`：新建分支弹窗的输入框缺 `v-focus`**。同批的克隆（`App.vue:2068`）、标签（`App.vue:2124`）、分组名（`App.vue:2494`）、重命名（`App.vue:2565` / `2587`）、切换器（`App.vue:2522` / `2612`）都有，只有这一个没有——打开弹窗后光标不在输入框里，用户要先点一下才能打字。
9. **`CommitHeatmap.vue:157`：空格子（`level 0`）加 `border border-border/60`**。当前 L0 是 `bg-muted`，对 `card` 底色的对比度只有 1.0-1.46，在浅色主题下整片热力图看起来像没渲染；给每个格子加一圈极淡的边框，网格结构立刻出来（这个改动同时缓解 P1 里的对比度问题，但真正的修复仍是换成离散色阶）。
10. **`App.vue:2709` 工作流失败图标 `X class="size-3.5 text-destructive"` 与成功图标 `App.vue:2705` 的 `Check class="size-3.5 text-[var(--c-add)]"` 尺寸一致，但 `pending` 状态用的是 `size-2 rounded-full border border-border`**（`App.vue:2712`）。三个状态的图标「重量」不一致（3.5px 描边 vs 2px 实心圆），导致完成态的行看起来比待执行态更「重」。建议 pending 也改成 `size-3.5` 的空心圆（`border-[1.5px]`）。

---

## 六、审查范围与未覆盖项

- **已覆盖**：`src/App.vue` template 全文（1619-2787）、`src/components/` 下 7 个业务组件、`src/components/ui/` 全部 12 个文件、`src/style.css` 全文；对比度为**手工实算**（WCAG 2.1 相对亮度公式，含半透明前景与背景的合成），覆盖 dark / light / github-light / catppuccin-mocha / catppuccin-latte / one-dark / github-dark 七套。
- **未覆盖**：`src-tauri/` 后端返回的错误文案（只审查了前端 `humanize()` 的映射表）、真实渲染效果（本次为静态审查，未启动应用）、WebView2 的原生控件行为（滚动条、右键菜单抑制）、拖拽交互的运行时表现（`VueDraggable` 的 `force-fallback` 路径）。
- **本次审查为只读**：未修改任何源码，未执行 `git add` / `git commit`，未运行开发服务器。
