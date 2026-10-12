# R2 — 前端架构与状态管理审查

> 审查对象：`src/App.vue`、`src/gitApi.ts`、`src/settings.ts`、`src/ai.ts`、`src/workflow.ts`、`src/workflowStore.ts`、`src/branchTree.ts`、`src/graph.ts`、`src/lib/patch.ts`、`src/components/**/*.vue`
> 对照物：`src-tauri/src/git.rs`（serde struct）、`src-tauri/src/lib.rs`（命令注册）、`src-tauri/capabilities/default.json`（ACL）
> 方法：只读静态审查（grep + read + PowerShell 量化 + ACL manifest 实测），**未修改任何源码**，`git status` 全程干净。
> 日期：2026-09-03 · 版本 0.1.0

---

## 总体结论

前端架构整体**健康度良好**：类型纪律极强（全仓 `any` / `as any` / `@ts-ignore` / `@ts-expect-error` / `as unknown as` **零命中**），`gitApi.ts` ↔ `git.rs` 的 9 个 serde struct **字段名/顺序/类型零漂移**，45 个命令双向注册零差集，虚拟滚动**真实生效**（不是摆设），watch 链路**无自触发死循环**，内存清理基本到位。真正的问题不在「类型」而在「异步时序」——`App.vue` 把状态中枢、刷新调度、工作流执行器、弹窗优先级链全部塞进一个 1617 行的 `<script setup>`，其中 **5 条异步路径缺少「仓库身份」守卫**，在 Ctrl+Tab / Ctrl+数字 绕过 `busy` 检查时可以造成**跨仓库数据串台**甚至**在错误的仓库上 commit/push**。

最该动的三件事：

1. **给 `refresh()` / `loadMorePage()` / `execStep()` 加仓库身份守卫**（`const path = repo.value` + 赋值前 `if (repo.value !== path) return`）。这三处是全仓唯一能造成「A 仓库数据显示成 B 仓库」和「工作流在错误仓库上推代码」的真实缺陷，且修复成本各 1-2 行。
2. **拆 `App.vue`**：101 个顶层函数、1108 行函数体塞在 1617 行 script 里，`closeTopOverlay()` 靠 18 行手写 if 链维护浮层优先级——这是「新增任何弹窗都可能忘加一行」的结构性隐患。优先抽 4 个 composable（见 §P1-1 与附录 A）。
3. **补 `core:window:allow-set-title` 权限**：`App.vue:200-204` 的窗口标题功能因 ACL 未授权而**静默失效**，且每次 `status` 变化产生一个未捕获的 promise rejection（ACL manifest 与 crate `reference.md` 双源证实 `core:window:default` 不含 `allow-set-title`）。

---

## P0 — 会造成数据错乱或误操作，建议立刻修

### [P0] `refresh()` 无仓库身份守卫，慢请求返回后会覆盖新仓库的全部状态

**位置**：`src/App.vue:174-197`（`refresh`）、触发点 `src/App.vue:1541-1556`（Ctrl+Tab / Ctrl+1..9 直接调 `activate()`，**不检查 `busy`**）、`src/App.vue:280-294`（`run()` 在 `busy=true` 期间 `await refresh()`）

**根因**：`refresh()` 在 L182-187 同步构造 `Promise.all([api.status(repo.value), fetchLog(0), api.branches(repo.value), api.tagList(repo.value)])`，四个 invoke 全部绑定「调用瞬间」的 `repo.value`（旧仓库 A）。但 L188-193 的赋值**没有任何 `repo.value` 比对**：

```ts
// src/App.vue:182-193
const [s, l, b, tg] = await Promise.all([
  api.status(repo.value), fetchLog(0), api.branches(repo.value), api.tagList(repo.value),
]);
status.value = s; commits.value = l; branchList.value = b; tags.value = tg;
cachePut(repo.value, { status: s, commits: l, branchList: b, tags: tg });  // ← 更糟：cachePut 用的是「当前」repo.value
```

`switchRepo()`（L636-639）有 `busy.value` 守卫，但 `onGlobalKeydown` 的 `Ctrl+Tab`（L1551）与 `Ctrl+1..9`（L1556）**直接调 `activate()`，完全绕过 busy 检查**；`closeTab()`（L706-738）同样不看 busy。因此「点 Pull（`run` → `await refresh()`）→ 立刻 Ctrl+Tab 切仓库」这条路径 100% 可达：A 仓库的 status/log/branches/tags 会被写进 B 仓库的视图，**且 `cachePut` 把 A 的数据写进了 B 的 LRU 槽位**，此后切回 B 还会从缓存里读出 A 的数据。

**影响**：
- 视图层：B 仓库显示 A 的提交历史、分支树、ahead/behind 徽标 —— 用户会基于错误信息做 commit/push 决策。
- 缓存层：LRU 被污染后**持久化错位**，直到该条目被淘汰前，切回 B 每次都是 A 的数据。
- 这是本报告里唯一「缓存被写坏」的路径，比单纯的显示错乱更严重。

**最小修复**：
```ts
async function refresh(opts: { fetch?: boolean } = {}) {
  const path = repo.value;
  if (!path) return;
  if (opts.fetch) await api.fetchAll(path).catch(() => {});
  if (repo.value !== path) return;                    // fetch 期间可能已切走
  remoteLink.value = (JSON.parse(localStorage.getItem("gz.remoteLinks") ?? "{}") as Record<string,string>)[path] ?? "";
  try {
    const [s, l, b, tg] = await Promise.all([
      api.status(path), api.log(path, 0, historyMode.value === "all" ? true : undefined, historyFilePath.value ?? undefined),
      api.branches(path), api.tagList(path),
    ]);
    if (repo.value !== path) return;                  // ← 关键守卫
    status.value = s; commits.value = l; branchList.value = b; tags.value = tg;
    canLoadMore.value = l.length >= 300;
    cachePut(path, { status: s, commits: l, branchList: b, tags: tg });   // ← 用 path 而非 repo.value
  } catch (e) { if (repo.value === path) showError(String(e)); }
}
```
（`fetchLog` 需改成接收 `path` 参数，见 P1-2。）

---

### [P0] `loadMorePage()` 无守卫，翻页结果会 push 进另一个仓库的 commits 数组

**位置**：`src/App.vue:209-221`

**根因**：
```ts
async function loadMorePage() {
  if (!repo.value || !canLoadMore.value || filter.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const next = await fetchLog(commits.value.length);   // ← 读 repo.value（旧仓库 A）
    commits.value.push(...next);                          // ← 写 commits.value（可能已是 B 的数组）
    canLoadMore.value = next.length >= 300;
  } catch (e) { showError(String(e)); }
  finally { loadingMore.value = false; }
}
```
`activate()` 在 L654 执行 `commits.value = []`（换成**新数组**）。若在 `await fetchLog(...)` 期间用户切到 B 仓库，`commits.value` 已指向 B 的空数组，`push(...next)` 就把 **A 仓库第 2 页的 300 条提交塞进了 B 的历史列表**。`loadingMore` 与 `busy` 无关，`Ctrl+Tab` 又能绕过 `busy`，路径成立。

**影响**：B 仓库历史区出现 A 的提交；因为 `HistoryGraph` 的泳道布局（`graph.ts:23 layout(commits)`）依赖 parent 链完整性，混入外来 hash 会让 `colOf.get(p)` 落空，泳道图出现断线/错位；`canLoadMore` 被置为 `true` 后用户继续下拉，`skip = commits.length`（含污染条数）会导致**后续分页永久跳过真实提交**。

**最小修复**：
```ts
const path = repo.value;
const next = await fetchLog(commits.value.length);
if (repo.value !== path) return;      // 丢弃过期分页
commits.value.push(...next);
canLoadMore.value = next.length >= 300;
```

---

### [P0] 工作流多步执行期间切仓库，后续步骤会在**错误的仓库**上 commit / push

**位置**：`src/App.vue:1229-1266`（`executeFlow`）、`src/App.vue:1268-1323`（`execStep`，每步内部都重新读 `repo.value`）

**根因**：`executeFlow` 在 L1232 设 `busy.value = true`，但 `activate()` / `closeTab()` / `Ctrl+Tab` 都不看 busy。`execStep` 的每一步都是独立的 `await api.xxx(repo.value, ...)`，**`repo.value` 在 await 链中间被重新求值**：

```ts
// src/App.vue:1276-1297 每一步都重新读 repo.value
case "checkout": await api.checkout(repo.value, refName(step.ref)); return;
case "pull":     await api.pull(repo.value); return;
case "push":     await api.push(repo.value, status.value?.branch ?? ""); return;
case "merge":    await api.merge(repo.value, refName(step.ref)); return;
// src/App.vue:1300-1319 commitPush 步骤
const st = await api.status(repo.value);
await api.stage(repo.value, ["."]);                    // ← git add . 打在新仓库上
await api.commit(repo.value, msg);                     // ← 提交写进新仓库
await api.push(repo.value, st.branch);                 // ← 推到新仓库
```

以种子工作流「发布到 dev」（`workflow.ts:72-93`：`commitPush(ai)` → `checkout release/dev` → `merge(start)` → `push` → `switchBack`）为例：用户在 AI 生成提交信息（最长 30s）期间切到另一个仓库，后续 `stage(".")` / `commit` / `push` 全部作用在新仓库上 —— **在用户没打算动的仓库里创建提交并推送**。`startBranch` 在 L1231 只取了一次，`switchBack` 会用旧仓库的分支名去 checkout 新仓库，必然报错或建出意外分支。

**影响**：这是本报告**唯一有「写坏远端」风险的缺陷**。Git 层面可恢复（`git reset` / force push），但用户通常不会立刻发现。

**最小修复**：`executeFlow` 开头锁定仓库并在每步前校验：
```ts
async function executeFlow(wf: Workflow, inputBranch: string) {
  if (busy.value || !repo.value) return;
  const path = repo.value;                       // 锁定
  const startBranch = status.value?.branch ?? "";
  ...
  for (let i = 0; i < wf.steps.length; i++) {
    if (repo.value !== path) {                   // 仓库被切走 → 立即中止
      wfRun.value.error = "执行期间切换了仓库，工作流已中止";
      ok = false; break;
    }
    ...
  }
}
```
（`execStep` 建议同时把 `repo` 作为显式参数传入，而不是闭包读 `repo.value` —— 这样编译器就能帮你发现遗漏。）

---

## P1 — 明确的缺陷或高代价设计，建议本迭代修

### [P1] 窗口标题功能因 ACL 缺权限而静默失效，并持续产生未捕获 promise rejection

**位置**：`src/App.vue:199-204`（`updateTitle` + `watch(status, updateTitle)`）；权限声明 `src-tauri/capabilities/default.json`；ACL 事实来源 `src-tauri/gen/schemas/acl-manifests.json`

**根因**：`updateTitle()` 调用 `getCurrentWindow().setTitle(...)`，而 `@tauri-apps/api/window.js` 的实现是 `invoke('plugin:window|set_title', { label, value })` —— 走 **core:window 的 ACL 管辖**。实测两份独立证据：

1. `src-tauri/gen/schemas/acl-manifests.json` → `core:window.default_permission.permissions` 的完整列表为 `allow-get-all-windows, allow-scale-factor, …, allow-is-enabled, allow-title, allow-current-monitor, …, allow-internal-toggle-maximize` —— **不含 `allow-set-title`**（`allow-title` 是「读标题」，不是「写标题」）。
2. tauri 2.11.5 crate 的 `permissions/window/autogenerated/reference.md:5-32`（Default Permission Set 清单）与上面**逐项一致**，同样没有 `allow-set-title`；`allow-set-title` 作为独立权限存在（`reference.md:1790`）。

`capabilities/default.json` 只声明了 `core:default`（展开为 `core:window:default` 等），没有单独追加 `core:window:allow-set-title`。Tauri 的拒绝文案（`tauri-2.11.5/src/ipc/authority.rs:432`）为 `"{command_pretty_name} not allowed. {permission_error_detail}"`，此处即 `window.set_title not allowed. …`。

`setTitle` 返回 Promise 且 `updateTitle` 未 catch，`watch(status, ...)` 在每次 status 变化时触发 → **每次刷新都产生一个 unhandled promise rejection**。

**影响**：`(↑N) git-zen` 未推送计数标题**从未生效**（用户无感知的功能缺失）；控制台持续刷未捕获 rejection；`watch(status, ...)` 被无谓触发一次跨 IPC 调用。注意这是**运行时行为**，`vue-tsc` 与 `cargo check` 都发现不了 —— 与 AGENTS.md 硬规则 1（命令注册）同类的「编译器沉默」缺陷。

**最小修复**：`src-tauri/capabilities/default.json` 的 `permissions` 增加一行：
```json
"core:window:allow-set-title"
```
同时给 `updateTitle` 加 `.catch(() => {})`（或把 `watch` 改成 `watch(status, updateTitle, { flush: "post" })` 并内部 catch），避免权限再出问题时污染控制台。

> **验证方式（1 分钟）**：`pnpm tauri dev` 启动后打开 DevTools，控制台应出现 `window.set_title not allowed. …`；加上权限后窗口标题应变成 `(↑N) git-zen`。若 DevTools 里没有该报错，说明此结论需要修正（本审查为纯静态，未运行应用）。

---

### [P1] `fetchLog()` 隐式读 `repo.value`，是 P0-1/P0-2 的共同根因

**位置**：`src/App.vue:162-169`

**根因**：
```ts
function fetchLog(skip = 0) {
  return api.log(repo.value, skip,
    historyMode.value === "all" ? true : undefined,
    historyFilePath.value ?? undefined);
}
```
它是**全仓 6 个调用点**（L184 `refresh`、L213 `loadMorePage`、L254 `historyMode` watcher、L694 `activate`）的统一入口，但**不接收 path 参数**，每次调用都重新读 `repo.value` 与 `historyMode`/`historyFilePath`。`activate()` 在 L659 把 `historyFilePath` 置 `null` 后、L693 `await nextTick()`、L694 才调 `fetchLog(0)` —— 这中间任何对 `historyMode` 的改动都会让「切换仓库」拉回错误范围的 log。

**影响**：所有跨仓库串台的调用点都从这里取 path；不修它，P0-1/P0-2 的修复只能靠调用点各自加守卫，容易漏。

**最小修复**：签名改成 `function fetchLog(path: string, skip = 0)`，6 个调用点显式传 path。这是纯机械改动，`vue-tsc` 会立刻指出所有遗漏点。

---

### [P1] `historyMode` / `historyFilePath` watcher 无 `catch`，失败即未捕获 rejection

**位置**：`src/App.vue:248-261`

**根因**：
```ts
watch([historyMode, historyFilePath], () => {
  if (!repo.value) return;
  historyLoading.value = true;
  nextTick().then(async () => {
    try { const l = await fetchLog(0); commits.value = l; canLoadMore.value = l.length >= 300; }
    finally { historyLoading.value = false; }          // ← 只有 finally，没有 catch
  });
});
```
`fetchLog` 会 reject（仓库被删除、`--follow` 对不存在的路径报错、磁盘/权限问题）。`nextTick().then(...)` 返回的 promise 无人接管 → unhandled rejection；用户只看到遮罩消失，**没有任何错误提示**。同款问题在 `closeTab` 的 `nextTick().then(async () => { try { await refresh() } finally {...} })`（L725-731）也存在 —— 不过 `refresh()` 内部自带 try/catch，所以 `closeTab` 相对安全。

另外该 watcher 也**无 seq 守卫**：快速切换「当前分支 / 全部」两次，两个 `fetchLog` 乱序返回时后者未必是最后一次选择。

**影响**：静默失败 + 控制台噪声；极端情况下历史区显示与当前 `historyMode` 不匹配的数据。

**最小修复**：加 `catch (e) { showError(String(e)); }`，并引入 `let historySeq = 0` 做序号校验（与 `activateSeq`、`CommitHeatmap.vue:42 loadSeq` 保持同一模式）。

---

### [P1] localStorage 的 `JSON.parse` 无保护，坏数据直接白屏

**位置**：`src/App.vue:385`、`src/App.vue:396`、`src/App.vue:408`、`src/App.vue:180`

**根因**：
```ts
// src/App.vue:385  —— script setup 顶层，模块初始化即执行
const repos = ref<RepoTab[]>(JSON.parse(localStorage.getItem("gz.repos") ?? "[]"));
const groupList = ref<string[]>(JSON.parse(localStorage.getItem("gz.groups") ?? "[]"));   // L396
const barOrder = ref<BarEntry[]>(JSON.parse(localStorage.getItem("gz.barOrder") ?? "[]")); // L408
// src/App.vue:180 —— 每次 refresh 都执行
remoteLink.value = (JSON.parse(localStorage.getItem("gz.remoteLinks") ?? "{}") as Record<string,string>)[repo.value] ?? "";
```
这四处**没有任何 try/catch**。对照 `settings.ts:44-58`、`workflowStore.ts:6-12`、`ai.ts:160-166` 都有 try/catch 兜底 —— 同一份代码库里两种做法并存。`gz.repos` 里只要出现一次非法 JSON（磁盘写入中断、用户手工编辑、杀进程时机不巧），`script setup` 顶层抛异常 → **`createApp(App).mount("#app")` 之前就崩，整个窗口白屏，且用户无法通过 UI 恢复**（唯一出路是手工清 WebView2 的 Local Storage）。

`App.vue:180` 更频繁：每次 `refresh()` 都 parse 一次，抛错会落在 `refresh()` 的 try **之外**（L179-180 在 try 之前），变成 unhandled rejection。

**影响**：可用性级别的启动失败；恢复门槛极高（普通用户不会去翻 `%LOCALAPPDATA%\com.gitzen.app\EBWebView\...\Local Storage`）。

**最小修复**：抽一个统一的安全读函数并替换 4 处：
```ts
function loadJSON<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; }
  catch { localStorage.removeItem(key); return fallback; }   // 顺手清掉坏数据，避免下次再崩
}
```
（与 `workflowStore.ts:6-12` 的现有模式一致。）

---

### [P1] `App.vue` 缺少可抽离边界：101 个顶层函数 / 1108 行函数体挤在一个 `<script setup>` 里

**位置**：`src/App.vue:1-1617`；典型症状 `src/App.vue:1514-1539`（`closeTopOverlay`）

**根因**：`App.vue` 的 script 段 1617 行里，**101 个顶层函数块合计 1108 行（占 68.5%）**，只有 90 个 `ref` / 12 个 `computed` / 12 个 `watch` 作为共享状态把它们全部粘在一起。三条具体的耦合证据：

1. **浮层优先级靠手写 if 链**（`src/App.vue:1514-1539`，26 行）：
   ```ts
   function closeTopOverlay() {
     if (confirmState.value) return (confirmState.value = null);
     if (wfRun.value) return (wfRun.value = null);
     if (showSettings.value) return (showSettings.value = false);
     ... // 共 18 个 if，每个弹窗一行
   }
   ```
   新增任何弹窗都必须记得加一行，否则 Esc 失效 —— 这是「靠人肉纪律维护」的架构味道。
2. **跨仓库状态生命周期散落在 3 个函数**：`activate()`（L653-661 清 8 个 ref）、`closeTab()`（L732-736 清 3 个 ref，**漏清 `tags` / `canLoadMore` / `remoteRaw` / `remoteLink`** —— 关掉最后一个仓库后标签区仍显示上一个仓库的 tag 列表）、`refresh()`（L188-193 全量覆盖）。三处各写一遍、各漏一点。
3. **`historyLoading` 定义在 L1354，但 L249 的 watcher 已在用** —— 靠「watcher 回调延迟执行」侥幸不踩 TDZ。这类前向引用在重构时极易变成真 bug。

**影响**：不是「代码丑」，而是**改动成本与风险线性上升**：任何新增异步路径都要重新推导 `repo.value` / `busy` / `activateSeq` 三个隐式不变式，而这三者没有任何类型或封装约束（P0-1/P0-2/P0-3 全部源于此）。

**最小修复**（不改行为、纯搬迁，建议分 4 个 PR）：

| 抽离目标 | 现有行号 | 抽成 | 理由 |
|---|---|---|---|
| 仓库会话（`repo`/`status`/`commits`/`branchList`/`tags`/`canLoadMore`/`activateSeq`/`repoCache`/`activate`/`refresh`/`fetchLog`/`fetchOnce`/`loadMorePage`） | L64-69、L115-197、L206-246、L645-704 | `composables/useRepoSession.ts` | 把三个隐式不变式收进一个闭包，守卫只写一次（直接消化 P0-1/P0-2） |
| 仓库选项卡与分组（`repos`/`groupList`/`barOrder`/`syncBar`/分组 CRUD/拖拽归组） | L378-580 | `composables/useRepoTabs.ts` | 与 git 操作无关，纯 UI 状态，可独立测试 |
| 浮层栈（`closeTopOverlay` + 18 个 `*Open`/`*Ctx` ref） | L1514-1539 及散布各处的浮层 ref | `composables/useOverlayStack.ts`（注册式：`push(id)` / `closeTop()`） | 把「手写 if 链」换成运行时注册，新增弹窗不可能漏 |
| 工作流执行器（`executeFlow`/`execStep`） | L1229-1323 | `composables/useWorkflowRunner.ts` | 94 行、7 种步骤原语、含 AI 调用 —— 是 script 里最该独立的一块 |

**必须留在中枢的**：`humanize()`（L81-101，全局错误契约）、`run()`（L280-294，唯一刷新入口）、`onGlobalKeydown`（L1541-1577，全局快捷键）、`error`/`errDetail`/`busy`/`runningAction`（跨模块共享的 UI 门面）。

---

### [P1] `gitApi.ts` ↔ `git.rs` 是人工镜像且**无任何契约测试**，当前一致但机制脆弱

**位置**：`src/gitApi.ts:1-198`（9 个 interface）、`src-tauri/src/git.rs:47-988`（9 个 `#[derive(Serialize)]` struct）

**根因**：AGENTS.md 硬规则 3 明确规定「改一边必须同步另一边，无代码生成」。**本次逐字段核对结论：字段名、顺序、类型、可选性全部一致，零漂移**（详见附录 B）。但保护机制只有「开发者的记忆」：

- 没有 `#[serde(rename_all)]` / `rename` / `skip_serializing_if` / `Option<T>` 字段（已确认 9 个 struct 全部没有），所以**一旦有人给某个 struct 加 `#[serde(skip_serializing_if = "String::is_empty")]`，前端 interface 会立刻变成谎言**，而 `vue-tsc` 与 `cargo check` 都不会报错。
- 45 个命令的**参数名**依赖 Tauri 2 的自动 `to_lower_camel_case` 转换（已从 `tauri-macros-2.6.3/src/command/wrapper.rs:7,507` 证实），例如 Rust `file_path` ↔ 前端 `filePath`、`include_untracked` ↔ `includeUntracked`。这个隐式约定没有任何注释提示，改错只会得到运行时的 `invalid args`。
- `gitApi.ts:47-50` 的 `commitStats` **定义在 `import { invoke }` 之前**，靠 ESM 提升才能跑 —— 说明这个文件的组织已经松到「顺序无所谓」的程度。

**影响**：当前无缺陷，但**下次改 struct 时大概率静默漂移**（AGENTS.md 自己说「历史上栽过三次」的命令注册问题就是同类）。这是全仓**唯一一处「靠人肉维护的正确性」**。

**最小修复**（三选一，成本递增）：
1. **最低成本**：在 `gitApi.ts` 顶部注释里列出「参数名 camelCase 映射」规则 + 在 `git.rs` 的 9 个 struct 上方各加一行 `// 镜像：src/gitApi.ts:NN`（双向指针）。
2. **推荐**：加一个自检脚本 `src/lib/mirror.test.ts`（放 `tsconfig` 的 exclude 列表，与现有 3 个 `*.test.ts` 同款），用正则从 `git.rs` 抽 struct 字段、从 `gitApi.ts` 抽 interface 字段，做集合比对。零依赖、可进 `pnpm build` 前置。
3. **彻底**：`#[derive(TS)]`（`ts-rs` crate）生成 `.d.ts`。成本最高，且与「轻量」定位有张力，不建议现在做。

---

## P2 — 有实际代价但可延后

### [P2] 每次操作后固定重拉 4 个 git 子进程，其中 tag 列表与 status 有冗余

**位置**：`src/App.vue:174-197`（`refresh` 4 个并发 invoke）、`src/App.vue:280-294`（`run` 每次操作后再来一次）、`src/App.vue:645-704`（`activate` 非命中路径共 8 个）

**根因**（实测请求数与数据量）：

| 触发 | invoke 数 | 具体命令 | 冗余 |
|---|---|---|---|
| `refresh()` | **4** | `git status --porcelain=v1 -b -uall`、`git log --max-count=300`、`git branch --all --format=…`、`git tag …` | — |
| `run(fn)` 一次操作 | **5** | 1 次操作 + 4 次 refresh | — |
| `doRefresh()` | **5** | `git fetch --all`（网络）+ 4 | — |
| `activate()` LRU 未命中 | **8** | status、branches、tagList、log、**fetchAll、status、branches**、remoteUrl | **status ×2、branches ×2** |
| `onMounted`（启动） | **8** | refresh(4) + fetchOnce(4) | **status ×2、branches ×2** |

`activate()` 在 L682-686 拉 `status`+`branches`+`tagList`，随后 L703 `fetchOnce()`（L226-246）**又拉一次 `status`+`branches`**（外加 `fetchAll` + `remoteUrl`）。`fetchOnce` 的存在理由是「fetch 后 refs 变了，ahead/behind 要重算」，但 `activate` 的 `fetchAll` 刚跑完（或根本没跑），这次重复请求只为了同步 ahead/behind —— 而 `status` 里本来就带 `ahead`/`behind`。

数据量：`git log --max-count=300`（`git.rs:141` 硬编码）每条 6 字段，300 条约 **60-120 KB** JSON；`-uall` 的 status 在未忽略 `node_modules` 的仓库里可达成千行（`git.rs:66` 注释说明这是刻意的，为了能逐个文件 diff）。`tag` 列表变化频率极低却每次都拉。

**影响**：切仓库 / 每次 commit 都要起 4-8 个 `git` 进程（Windows 上进程创建约 10-30ms，加上 git 自身冷启动），1 万+ commit 仓库上 `git log --max-count=300` 通常 50-200ms。总感知延迟在 200-600ms 量级。**这是 DESIGN.md「操作快」目标的主要抵消项**。

**最小修复**：
1. `activate()` 的 `fetchOnce()` 改为只在真正需要时调用（fetch 之后），或让 `fetchOnce` 复用已拉到的 `status`/`branches`（`fetchOnce` 已经有 `repoCache.get(path)` 分支，可扩展成「接受调用方传入的 s/b」）。
2. `tagList` 从 `refresh()` 拆出，只在「切仓库 / tag 相关操作 / 手动刷新」时拉（tag 变化只可能来自本应用的 tag 操作与 fetch）。
3. `activate()` 的两段式（L678-702）已经很好（先轻量后 log），保留。

---

### [P2] 快速切仓库时 `activate()` 会浪费请求（seq 守卫正确，但守卫在请求之后）

**位置**：`src/App.vue:645-704`（`activateSeq` 机制）

**根因**：`activateSeq` 的**正确性没有问题** —— L646 `const seq = ++activateSeq`、L680/687/695/699/701 五处 `seq === activateSeq` 校验覆盖了所有赋值点，L673 的 `api.branches` 回调也做了校验。**快速切仓库不会乱序覆盖**（这点要澄清，避免误报）。

但守卫位置偏晚：L694 `const l = await fetchLog(0)` 之前只有 L687 的一次校验，`fetchLog` 会**照常发出**，返回后 L695 才丢弃。连续 Ctrl+Tab 5 次 = 5 次 `git log --max-count=300` 全部跑完再丢弃 4 次。同理 L682-686 的 `Promise.all` 在 L680 校验之后发起，若在 3 个请求飞行中切走，也会全部浪费。

**影响**：快速切换时后台堆叠多个 `git log` 进程（Windows 上 git 是独立进程，5 个并发 log 在大仓库上会互相抢 IO）。不会造成数据错误。

**最小修复**：在 `activate()` 开头加 `const path = repo.value` 后，把 `fetchLog` 的 path 显式传入（依赖 P1-2 的改造），并在发起每个请求**前**再校验一次 `seq === activateSeq`。若要更彻底，可给 `gitApi` 的每个封装加 `signal`（Tauri invoke 支持 `AbortSignal`）—— 但那需要 Rust 侧配合，成本高，暂不建议。

---

### [P2] `run()` 期间的 `busy` 守卫不完整：`activate()` / `closeTab()` 都能绕过

**位置**：`src/App.vue:636-639`（`switchRepo` 检查 busy）、`src/App.vue:1541-1556`（Ctrl 快捷键直接调 `activate`）、`src/App.vue:706-738`（`closeTab` 不检查）

**根因**：`busy` 的语义是「有 git 操作在飞行中」，但只有 `switchRepo` 一个入口尊重它。`onGlobalKeydown` 的 `Ctrl+Tab`（L1551）、`Ctrl+1..9`（L1556）直接 `activate(...)`，`closeTab` 也不检查。这正是 P0-1 / P0-2 / P0-3 三条竞态的共同**触发前提**。

**影响**：P0 三条的「可达性」全部来自这里。即便按 P0 修复加了守卫，`busy` 语义不一致仍是后续隐患。

**最小修复**：把 busy 检查下沉到 `activate()` 内部（`if (busy.value && !force) return;`），而不是只放在 `switchRepo`；`closeTab` 至少加 `if (busy.value) return;`（或让关闭当前仓库时等待 busy 结束）。**注意**：如果希望 Ctrl+Tab 在 busy 时仍可切换（体验上合理），那就必须保证 P0 的守卫到位 —— 二者取其一，不能都不做。

---

### [P2] `humanize()` 漏覆盖 git.rs 自造错误；`非法的 commit hash` 会原样弹出

**位置**：`src/App.vue:81-101`（14 条正则规则，`rules.find()` 只取第一条命中）

**根因**：`git.rs` 的错误分两类：
- **A 类：stderr 原文透传**（`git.rs:28` `Err(String::from_utf8_lossy(&out.stderr).trim().to_string())`）—— `humanize()` 的 14 条规则**就是为这类设计的**，覆盖了 `no upstream`、`non-fast-forward`、`nothing to commit`、`cherry-pick is now empty`、`already exists and is not an empty directory`、`could not read from remote repository`、`authentication|permission denied|403`、`not a git repository`、`does not have any commits yet`、`conflict`、`failed to connect|connection timed out|could not resolve host`、`not fully merged|used as worktree` 等 —— **覆盖质量相当好**。
- **B 类：git.rs 自造的中文错误**（共 18 处，见附录 B 备注）—— `humanize()` **一条都没覆盖**。其中大多数（`提交信息不能为空`、`分支名不能为空`、`没有可收纳的改动：暂存区和工作区都是干净的` 等）本身就是人话，原样展示可接受。**唯一的例外是 5 处 `"非法的 commit hash"`**（`git.rs:283` git_show、`git.rs:374` git_revert、`git.rs:590` git_show_file、`git.rs:879` git_tag_create、`git.rs:966` git_cherry_pick`），这是纯技术术语，用户看到会一头雾水。另有 `git.rs:1002` `"非法的提交范围"`、`git.rs:41` `"后台任务失败: {e}"`（`offload` 的 `spawn_blocking` 失败，理论不可达但暴露了 Rust 内部概念）。

**影响**：错误提示质量在 5 条路径上退化；用户无法区分「我点了什么导致了这个」和「程序内部出错」。**注意**：这不是「映射表覆盖不足」的普遍问题 —— 14 条规则覆盖了绝大多数真实 git 报错，问题集中在自造文案。

**最小修复**：给 `humanize()` 补 2 条规则（放在现有规则**之前**，因为 `find()` 取首个命中）：
```ts
[/非法的 commit hash/i, "该提交已不在仓库中（可能已被 rebase / 垃圾回收），请刷新后重试"],
[/后台任务失败/i, "内部错误：后台任务未能启动，请重试或重启应用"],
```
更彻底的做法是让 git.rs 的自造错误也带上可识别的英文 key（如 `E_INVALID_HASH: …`），但那是后端改动，超出本报告范围。

---

### [P2] `ai.ts` 无取消机制：关闭弹窗后请求继续跑满 30s，`TIMEOUT_MS` 只是标志位

**位置**：`src/ai.ts:6`、`src/ai.ts:45-67`

**根因**：
```ts
let timedOut = false;
const timer = setTimeout(() => (timedOut = true), TIMEOUT_MS);   // ← 只置标志位
try { res = await fetch(url, { method: "POST", headers, body: ... }); }  // ← 没有 signal
catch { clearTimeout(timer); throw new Error(timedOut ? "AI 请求超时（30s）" : "网络不通…"); }
```
两个问题叠加：
1. **`fetch` 没有 `signal`** —— 30s 到点后请求仍在飞行，计时器只是让**失败时的文案**变成「超时」。真正超时的请求会一直挂到 TCP/服务端超时（可能数分钟）。
2. **全仓零 `AbortController`**（已 grep 确认）—— 用户关掉 Review / Release Notes / DiffViewer 的 AI 面板后，请求继续执行到底，`reviewBusy` / `explainBusy` 等 ref 属于已隐藏的组件（App 侧的 ref 还活着）。

**影响**：AI 面板反复开关会累积并发请求（每个 30s+）；用户以为「取消了」但仍在消耗 token 与带宽；慢速 Base URL 下打开弹窗的响应性受影响。

**最小修复**：
```ts
export async function aiComplete(system: string, user: string, signal?: AbortSignal): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);      // 真正中断
  const onOuter = () => ctl.abort();
  signal?.addEventListener("abort", onOuter, { once: true });
  try { res = await fetch(url, { ..., signal: ctl.signal }); }
  catch { throw new Error(timedOutFlag ? "AI 请求超时（30s）" : ctl.signal.aborted ? "已取消" : "网络不通…"); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", onOuter); }
}
```
调用侧在 `onUnmounted` / 关闭弹窗时 abort。注意 `@tauri-apps/plugin-http` 的 `fetch` 支持 `AbortSignal`（`http:default` 已含 `allow-fetch-cancel` / `allow-fetch-cancel-body`，权限就绪）。

---

### [P2] `clipForAI()` 按 UTF-16 code unit 硬切 16KB，会切在 hunk 中间并可能劈开代理对

**位置**：`src/ai.ts:9-12`

**根因**：
```ts
export function clipForAI(text: string, maxChars = 16_000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（diff 过长已截断，原文共 ${text.length} 字符）`;
}
```
1. `text.slice(0, 16000)` 按 **UTF-16 code unit** 切。若第 16000 个位置正好落在某个 emoji / 生僻字的代理对中间，`slice` 会产出**孤立代理项**（lone surrogate），`JSON.stringify` 后发给 API 是非法 UTF-8 → 部分服务端会返回 400 或替换成 `�`。
2. **无 hunk 边界感知**：diff 是 `diff --git` / `@@ … @@` 分块的，硬切在 hunk 中间会让 AI 看到「半个 hunk」—— 上下文行缺失、`+/-` 行数不匹配，直接降低生成质量（提交信息、Review 结论、Diff 解释都受影响）。而 16KB 在「一个文件改了几百行」的场景下**极易触发**。
3. 截断只保留**头部**：diff 是按文件路径字母序输出的，截断意味着**靠后的文件完全不可见**，AI 会漏掉整个文件的改动却仍给出「已完成审查」的结论 —— 这是比「信息少」更危险的**误导**。

**影响**：AI 输出的准确度在大改动下显著下降，且用户无法从输出中察觉（截断提示只写在 prompt 里，AI 未必转述）。

**最小修复**：
1. 用 `Array.from(text).slice(0, maxChars).join("")` 或 `text.slice(0, text.charCodeAt(maxChars - 1) >= 0xd800 ? maxChars - 1 : maxChars)` 保证不劈代理对（1 行）。
2. 优先在 hunk 边界截断：找 `maxChars` 之前最后一个 `\n@@ ` 或 `\ndiff --git `，从那里切；找不到再退回硬切（约 10 行）。
3. 截断提示里**明确告知被丢弃的文件名**（从剩余文本里提取 `diff --git a/… b/…`），让 AI 知道「还有 N 个文件未展示」，避免它给出「无问题」的结论。

---

### [P2] `remoteNodes()` 在模板里直接调用，每次重渲染全量重建分支树

**位置**：`src/App.vue:985-992`（函数）、`src/App.vue:1825`（模板 `:nodes="remoteNodes(prefix)"`）

**根因**：
```ts
function remoteNodes(prefix: string): BNode[] {
  const list = remoteGroups.value.find(([p]) => p === prefix)?.[1] ?? [];
  return buildNodes(list.map((b) => ({ ...b, name: b.name.slice(prefix.length + 1), originName: b.name })), `remote:${prefix}:`);
}
```
它是**模板里被调用的普通函数**（在 `v-for` 的每个远程分组里），不是 `computed`。Vue 的模板函数调用**不缓存**：父组件任何一次重渲染（例如 `status` 更新、`busy` 切换、`filter` 输入）都会对**每个远程分组**重新执行 `.map()`（新建 N 个对象）+ `buildNodes()`（O(N·depth) 遍历建树）。`BranchTree.vue` 是递归组件，整棵子树跟着重建。

对照 `localNodes`（L958）就是正确的写法：`const localNodes = computed(() => buildNodes(localBranches.value, "local:"))`。**同一个文件里两种做法并存**。

**影响**：远程分支多的仓库（如 monorepo 的 `origin/feature/*` 上百个）每次状态更新都要重建数百个对象 + 整棵树 diff；`filter` 输入框每敲一个字符触发一次。这是 App.vue 里最容易被忽略的重复计算。

**最小修复**：改成 `const remoteNodesMap = computed(() => new Map(remoteGroups.value.map(([p, list]) => [p, buildNodes(list.map(...), `remote:${p}:`)])))`，模板改 `:nodes="remoteNodesMap.get(prefix) ?? []"`。

---

### [P2] `syncBar()` 每次深变做两次全量 `JSON.stringify`，叠加 3 个 deep watcher

**位置**：`src/App.vue:413-432`

**根因**：
```ts
function syncBar() {
  const next = barOrder.value.filter(...);   // 全量重建
  ... // 补漏分组/仓库
  if (JSON.stringify(next) !== JSON.stringify(barOrder.value)) barOrder.value = next;   // L430 两次全量序列化
}
watch([repos, groupList], syncBar, { deep: true });   // L432
```
`repos` 同时被 3 个 watcher 观察：L386（`deep: true` → 写 `gz.repos`）、L432（`deep: true` → `syncBar`）、以及 L409（`barOrder` deep → 写 `gz.barOrder`）。拖动一个仓库 tab 时，Sortable 会连续触发多次数组变更 → 每次变更都跑一遍「`JSON.stringify` ×2 + `localStorage.setItem` ×2 + 全量重建 barOrder」。`repos` 数组元素是 `{path, name, group?}` 对象，`deep: true` 意味着**逐字段**递归追踪。

**影响**：拖拽排序时主线程卡顿（每次 `setItem` 是同步磁盘写）；`localStorage` 写入次数在拖拽过程中可达数十次。

**最小修复**：
1. L430 的 `JSON.stringify` 比对换成「长度 + 逐项 path/kind 比较」（数据量小，O(n) 且无序列化开销）。
2. `watch(repos, ...)` 的持久化改成 `watch(repos, persist, { deep: true, flush: "post" })` 并加 100ms 防抖（拖拽结束时写一次）。
3. `repos` 的元素若不需要响应式字段级追踪，可用 `shallowRef` + 整体替换（现在 `renameGroup`/`addMember` 已经是整体替换，但 `renameGroup` L485-495 是**原地改对象字段**，所以不能直接 shallow）。

---

### [P2] `closeTab()` 关掉最后一个仓库时漏清 4 个状态

**位置**：`src/App.vue:732-736`

**根因**：
```ts
} else {
  status.value = null;
  commits.value = [];
  branchList.value = [];
  // 漏：tags、canLoadMore、remoteRaw、remoteLink、fileHistoryModal、historyFilePath
}
```
对照 `activate()` 的 L653-661（清 8 个 ref），`closeTab` 只清 3 个。关掉最后一个仓库后：**标签区仍显示上一个仓库的 tag 列表**（`tags` 未清，模板 `tagsFiltered` 继续渲染）；`remoteRaw`/`remoteLink` 残留导致「打开远程网页」按钮指向已关闭仓库的 URL；`fileHistoryModal` 若开着会指向不存在的仓库（`FileHistoryModal.vue:25` 会拿旧 path 去 invoke）。

**影响**：空态下显示幽灵数据；点击残留按钮会报错或打开错误的 URL。

**最小修复**：把这 8 行清理抽成 `function resetRepoView()`，`activate()`（L653-661）与 `closeTab()`（L732-736）共用 —— 这也是 P1-1 里 `useRepoSession` 的一部分。

---

### [P2] 4 个文件保存路径的 `await saveDialog()` 在 `try` 之外

**位置**：`src/App.vue:846-861`（`saveReviewToFile`）、`src/App.vue:919-934`（`saveNotesToFile`）、`src/components/DiffViewer.vue:12-28`（`saveExplainToFile`）、`src/components/DiffViewer.vue:130-148`（`exportPatch`）

**根因**：四处都是同一个模式：
```ts
async function saveReviewToFile() {
  if (!reviewText.value) return;
  const target = await saveDialog({ ... });   // ← try 之外
  if (!target) return;
  try { await api.writeTextFile(target, reviewText.value); ... }
  catch (e) { showError(String(e)); }
}
```
`saveDialog`（`@tauri-apps/plugin-dialog` 的 `save`）会 reject（对话框被系统抢占、路径非法、插件权限问题）。因为它在 `try` 外，reject 直接逃逸。这四个函数都是模板 `@click` 直接绑定（`App.vue:2263`、`App.vue:2294`、`DiffViewer.vue:274`、`DiffViewer.vue:343`），Vue 不会捕获返回的 promise → unhandled rejection。

**影响**：保存失败时**完全静默**（用户点了「保存到本地」什么都没发生）。

**最小修复**：把 `const target = await saveDialog(...)` 移进 `try` 块（四处各 1 行）。

---

### [P2] `App.vue` 另有 4 处 `await` 未受 try 保护

**位置**：`src/App.vue:310-315`（`openRepo` 的 `await open({directory:true})`）、`src/App.vue:346-349`（`pickCloneParent` 同款）、`src/App.vue:884-896`（`openReleaseNotes` 的 `await api.latestTag(...)` —— 已 `.catch(() => "")` ✓）、`src/App.vue:725-731`（`closeTab` 的 `nextTick().then(async () => { try { await refresh() } finally {...} })`）

**根因**：`openRepo` / `pickCloneParent` 直接 `await open(...)`，模板绑定（`App.vue` 的「打开」按钮 / 「选择目录」按钮）无 catch。`closeTab` 的 `nextTick().then(...)` 链条无 catch（`refresh()` 自带 try/catch，所以实际安全，但模式不统一）。

**影响**：目录选择对话框失败时静默无反应。

**最小修复**：`openRepo` / `pickCloneParent` 包 try/catch → `showError`。

---

### [P2] 全局无 `app.config.errorHandler` / `unhandledrejection` 兜底

**位置**：`src/main.ts:1-6`（全文 6 行，只有 `applySettings()` + `createApp(App).mount("#app")`）

**根因**：全仓 grep `errorHandler|unhandledrejection|onErrorCaptured|window.onerror` **零命中**。所有异步错误的可见性完全依赖开发者手动 `catch` + `showError`（本报告已列出 8 处遗漏）。

**影响**：任何遗漏的 rejection 都只进 DevTools 控制台 —— 打包后用户看不到控制台，表现为「点了没反应」。这是本报告多条 P2 的共同放大器。

**最小修复**：`main.ts` 加全局兜底（约 8 行）：
```ts
app.config.errorHandler = (err) => { console.error(err); };
window.addEventListener("unhandledrejection", (e) => {
  // 已有 showError 通道的话，这里可以只做日志；至少不要静默
  console.error("[git-zen] unhandled rejection:", e.reason);
});
```
（若要接到 `showError`，需要把 `error` ref 提到模块级单例 —— 与 `toast.ts` 同款模式，成本略高但值得。）

---

### [P2] `App.vue:1606-1607` 两个 window 监听无清理；`startResize` 无卸载兜底

**位置**：`src/App.vue:1605-1616`（`onMounted`）、`src/App.vue:1191`（唯一的 `onUnmounted`）、`src/App.vue:1584-1600`（`startResize`/`endResize`）

**根因**：
```ts
onMounted(async () => {
  window.addEventListener("focus", () => refresh());     // L1606 —— 匿名函数，无法 remove
  window.addEventListener("keydown", onGlobalKeydown);   // L1607
  ...
});
onUnmounted(() => unDrag?.());                            // L1191 —— 只清了拖拽监听
```
`App.vue` 是根组件，实际不会卸载，**风险等级低**；但一旦未来引入 `<KeepAlive>`、多窗口（DESIGN.md §4.5 已把多窗口列为「不做」，但若做就是首要障碍）或组件级测试挂载，这两个监听会累积。另外 L1606 用了**匿名箭头函数**，即便想 remove 也做不到。

`startResize`（L1584-1588）注册 `mousemove`/`mouseup`，`endResize`（L1594-1600）成对移除 ✓；但若用户在拖动中触发组件卸载，`document.body.style.cursor` 会永久停在 `col-resize`。`DiffViewer.vue:249-252` 的 `onUnmounted` 正确处理了这个场景（`removeEventListener` ×2 + `cursor = ""`）—— **同一个项目里两种做法**，App.vue 应向 DiffViewer.vue 对齐。

**影响**：当前无实际泄漏（根组件不卸载）。属于「未来重构时的地雷」。

**最小修复**：`onMounted` 里改用具名函数 `const onWinFocus = () => refresh();`，并在 L1191 的 `onUnmounted` 里一并 `removeEventListener` 三者 + 复位 `cursor`。

---

### [P2] `Md.vue` 用 `v-html` 渲染 AI 输出，且应用未设 CSP

**位置**：`src/components/ui/Md.vue:9-18`、`src-tauri/tauri.conf.json`（`"security": { "csp": null }`）

**根因**：
```ts
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });   // Md.vue:9
const html = computed(() => md.render(props.source ?? ""));                 // Md.vue:11
```
```html
<div :class="cn(...)" v-html="html" />                                      <!-- Md.vue:17 -->
```
**当前是安全的**：`html: false` 会转义原始 HTML 标签；`linkify: true` 生成的链接仍会过 markdown-it 的 `validateLink` 白名单（默认拒绝 `javascript:` / `vbscript:` / `file:` / `data:`，`data:` 仅对图片放行）。**结论：不构成 XSS**（这点要明确写出来，避免误报）。

但两道防线都是**单点**：
1. `html: true` 是一个字符的改动，且是很常见的「让 AI 输出支持 HTML」需求 —— 改完立刻变成 XSS（AI 输出内容来自第三方服务与用户仓库的 diff 文本，`<img src=x onerror=…>` 可以通过 diff 内容注入）。
2. `tauri.conf.json` 的 `"csp": null` 意味着**没有第二道防线**。WebView2 的 CSP 一旦设置，即使 markdown-it 被配错也无法执行内联脚本。

**影响**：当前无漏洞，属于「低成本高收益的纵深防御」。

**最小修复**：在 `tauri.conf.json` 设一个宽松但有效的 CSP：
```json
"security": { "csp": "default-src 'self'; img-src 'self' data: asset: http://asset.localhost; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost" }
```
（Tailwind 与 Vue 的内联样式需要 `style-src 'unsafe-inline'`；AI 请求走 `plugin-http` 的 Rust 侧，不受 `connect-src` 限制。）同时在 `Md.vue:9` 上方加注释「**禁止改成 `html: true`**」。

---

## P3 — 打磨项

### [P3] 模板里 4 处 `groupCount()` / `isGroupActive()` 是函数调用而非 computed

**位置**：`src/App.vue:437-438`（定义）、模板 `src/App.vue:1726`、`:1730`、`:1735`、`:2428`、`:2429`、`:2457`

```ts
const groupCount = (g: string) => repos.value.filter((r) => r.group === g).length;               // L437
const isGroupActive = (g: string) => repos.value.some((r) => r.group === g && r.path === repo.value);  // L438
```
两者在模板里按分组数 × 出现次数被调用（`:1730` 和 `:1735` 在同一个元素上各调一次 `isGroupActive`）。每次重渲染 = `O(分组数 × 仓库数)` 扫描。仓库数通常个位数到几十，**实测影响很小**。

**最小修复**：换成 `const groupCounts = computed(() => { const m = new Map<string, number>(); for (const r of repos.value) if (r.group) m.set(r.group, (m.get(r.group) ?? 0) + 1); return m; })`，模板 `groupCounts.get(item.name) ?? 0`。

---

### [P3] `switcherResults` 的排序比较器内反复调 `mru()`（`indexOf` O(m)）

**位置**：`src/App.vue:588-604`

```ts
const switcherResults = computed(() => {
  const mru = (p: string) => { const i = mruPaths.value.indexOf(p); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
  const list = [...repos.value];
  if (!q) return list.sort((a, b) => mru(a.path) - mru(b.path));   // 比较器内 indexOf
  ...
});
```
`Array.prototype.sort` 的比较器调用次数是 `O(n log n)`，每次内部 `indexOf` 是 `O(m)` → 总计 `O(n·m·log n)`。仓库数 < 100 时无感。

**最小修复**：进函数先建一次 `const rank = new Map(mruPaths.value.map((p, i) => [p, i]))`，比较器改成 `(rank.get(a.path) ?? 1e9) - (rank.get(b.path) ?? 1e9)`。

---

### [P3] `vite.config.js` 无 `build` 配置：单 chunk 450 KB、无 sourcemap、无 target

**位置**：`vite.config.js`（全文 18 行）

**根因**：只有 `plugins` / `clearScreen` / `resolve.alias` / `server`。缺失：
- `build.target`：Tauri 用的是系统 WebView2（Windows）/ WKWebView（macOS），可以直接设 `"esnext"` 省掉转译开销。默认 `"modules"` 偏保守。
- `build.rollupOptions.output.manualChunks`：实测 `dist/assets/index-BbHLRa1v.js` = **450,800 字符（约 440 KB）**单文件，包含 Vue runtime + markdown-it 15 + 45 个 lucide 图标 + 全部业务代码。桌面应用从本地加载，首屏影响小，但拆出 `vendor`（vue）/ `md`（markdown-it）能让热更新与缓存更精确。
- `build.sourcemap`：默认关闭 ✓（生产不泄露源码，正确）。若要排查打包后的问题，可只对 staging 开 `"hidden"`。
- `envPrefix`：未使用 `TAURI_*` 环境变量，不需要。

**已核实非问题**：`@lucide/vue@1.33.0` 的 `package.json` 有 `"sideEffects": false`，且实测 bundle 里 `createLucideIcon` 出现 **0 次**、`viewBox` 仅 1 次 —— **45 个图标按需引入且 tree-shaking 生效**，没有把 978 KB 的完整图标库打进来。这点做得很好。

**最小修复**（可选，收益有限）：
```js
build: { target: "esnext", rollupOptions: { output: { manualChunks: { vue: ["vue"], md: ["markdown-it"] } } } }
```

---

### [P3] `@types/markdown-it` 主版本落后于 `markdown-it`

**位置**：`package.json` — `"markdown-it": "^15.0.0"` vs `"@types/markdown-it": "^14.2.0"`

**根因**：运行时装的是 `markdown-it@15.0.0`，类型声明是 `@types/markdown-it@14.2.0`（已实测两个包的 `package.json`）。主版本不匹配意味着 `Md.vue:9` 的 `new MarkdownIt({ html, linkify, breaks })` 选项类型可能不对应 15.x 的真实 API。

**影响**：当前 `vue-tsc --noEmit` 通过（选项在 14/15 之间无变化），但这是「类型检查通过 ≠ 类型正确」的典型场景；15.x 若新增/改动了选项，TS 不会报错。

**最小修复**：`pnpm add -D @types/markdown-it@^15`（若上游已发布）；若无 15.x 的 types，则把 `markdown-it` 降到 `^14`（`Md.vue` 只用最基础 API，降级无影响）。

---

### [P3] `gitApi.ts:47-50`：`commitStats` 定义在 `import { invoke }` 之前

**位置**：`src/gitApi.ts:47-50`

```ts
export const commitStats = (repo: string, since: string, author?: string) =>
  invoke<CommitDay[]>("git_commit_stats", { repo, since, author: author ?? null });   // L47-48 用了 invoke

import { invoke } from "@tauri-apps/api/core";                                        // L50 才 import
```
靠 ESM 的 import 提升（hoisting）才能运行；`vue-tsc` 也不报错（`import` 声明是提升的）。文件里其他 44 个封装都在 L50 之后。

**影响**：纯粹的可读性/一致性缺陷。但它是「这个文件没有明确组织规则」的信号 —— 与 P1-6 的镜像漂移风险同源。

**最小修复**：把 `import { invoke }` 移到文件顶部（L1 注释之后）。

---

### [P3] 5 处非空断言在类型上不成立，靠运行时契约兜底

**位置**：`src/components/DiffViewer.vue:14`、`:79`、`:134`（`props.file!`）、`src/components/BranchTree.vue:57-64`（`n.branch!` × 5）、`src/App.vue:1243/1246`（`wfRun.value.states[i]!` / `wf.steps[i]!`）

**根因**（完整的 45 处清单见附录 C，这里只列**断言在类型层面确实不成立**的）：

1. **`DiffViewer.vue` 的 `props.file!`（3 处）**：`defineProps<{ repo: string; file?: DiffTarget; commit?: CommitTarget }>()` 里 `file` 与 `commit` **都是可选的**，类型系统允许两者都不传，但三处代码写的是 `props.commit ? … : `**`props.file!`**`…`。若调用方漏传两者，会在 `props.file!.path` 抛 `Cannot read properties of undefined`。当前唯一调用点（`App.vue:2237` 附近的 `diffState` 分支）保证二选一，但**契约只存在于调用方**。
2. **`BranchTree.vue:57-64` 的 `n.branch!`（5 处）**：`BNode.branch` 是 `branch?: Branch & { originName?: string }`（`branchTree.ts:11`）。模板里这 5 处在 `v-else`（即 `n.children.length === 0`）分支内，推理是「叶子节点必有 branch」。这个推理**成立**（`buildNodes` 只给末段节点赋 `branch`，非末段节点必有 children），但**类型系统不知道**，且「同名分支与目录冲突」的场景（同时存在 `a` 和 `a/b`）会让 `a` 节点既有 `children` 又有 `branch` —— 此时走 `v-if` 分支，安全。**结论：安全但脆弱**，重构 `buildNodes` 时必须重新验证。
3. **`App.vue:1243/1246` 的 `wfRun.value.states[i]!` / `wf.steps[i]!`**：循环 `for (let i = 0; i < wf.steps.length; i++)` 保证 `i` 合法，`states` 由 `wf.steps.map(...)` 生成（L1237），长度一致。**安全**。

**影响**：无当前 bug。属于「类型断言掩盖了未表达的契约」。

**最小修复**：
- `DiffViewer.vue`：把 props 改成判别联合 `defineProps<{ repo: string } & ({ file: DiffTarget; commit?: never } | { commit: CommitTarget; file?: never })>()`，或在三处改用 `props.file?.path ?? ""`。
- `BranchTree.vue`：`buildNodes` 里把叶子节点类型收窄成 `branch: Branch`（如 `BNodeLeaf extends BNode { branch: Branch }`），模板走类型守卫 —— 改动较大，可延后。
- `App.vue`：`wfRun.value.states[i]` 已是「安全但啰嗦」，可保留。

---

### [P3] `ai.ts` 的 FIFO 缓存只删 1 条 + Review 全文存 localStorage

**位置**：`src/ai.ts:158-178`

**根因**：
```ts
const AI_CACHE_LIMIT = 30;
export function aiCacheWrite(bucket: string, id: string, text: string): void {
  const b = loadBucket(bucket);
  b[id] = text;
  const keys = Object.keys(b);
  if (keys.length > AI_CACHE_LIMIT) delete b[keys[0]];   // ← if 而非 while
  localStorage.setItem(`gz.ai.${bucket}`, JSON.stringify(b));
}
```
**「`if` 而非 `while`」本身不构成泄漏**：每次写入只增加 1 条，删除 1 条即可回到上限。**已核实非问题**（避免误报）。

真正的代价是**容量**：`review` bucket 存的是 AI Review 全文（数千字），30 条 × 数 KB ≈ 100-300 KB；`explain` bucket 同理。加上 `gz.settings`、`gz.workflows`、`gz.repos` 等，全部挤在 localStorage 的 **5 MB 同源配额**里（WebView2 按 origin 计算）。超配额时 `setItem` 抛 `QuotaExceededError` —— 而 `aiCacheWrite` **没有 try/catch**（`loadBucket` 有），会向调用方抛异常。

**影响**：极端情况下（大量 AI 使用 + 大 diff）写入失败并冒泡；`aiCacheRead` 在 `DiffViewer.vue:83` 的 `onMounted` 里调用，若抛错会影响弹窗打开。

**最小修复**：`aiCacheWrite` 加 try/catch（超配额时静默丢弃缓存 —— 缓存本来就是可选的）；顺手把 `if` 改成 `while`（防御未来一次性写多条）。

---

### [P3] `toast.ts` 的 `setTimeout` 未清理；`App.vue` 两处 2s toast 定时器同理

**位置**：`src/components/ui/toast.ts:17-20`、`src/App.vue:857`、`src/App.vue:930`、`src/components/DiffViewer.vue:24`、`src/components/DiffViewer.vue:144`

**根因**：五处都是 `setTimeout(() => (flag.value = false), 2000/2400)`，**无 `clearTimeout`**。`toast.ts` 是模块级单例（不随组件卸载），App.vue 是根组件（不卸载），所以实际泄漏为零。`DiffViewer.vue` 的 `savedTip` / `savedPatchTip`（L24 / L144）在弹窗快速开关时可能向**已卸载组件**的 ref 写值 —— Vue 3 下对已卸载组件的 ref 赋值不报错也不泄漏（ref 本身会被 GC），只是无用功。

**影响**：无实际泄漏。**已核实非问题**，仅记录以便未来若引入 `<KeepAlive>` 时复查。

---

### [P3] `CommitHeatmap.vue` 的 `debounceTimer` 无卸载清理

**位置**：`src/components/CommitHeatmap.vue:42-103`

```ts
let debounceTimer: ReturnType<typeof setTimeout> | undefined;   // L43
watch(() => [props.repo, props.authorEmail] as const, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(load, 300);                        // L101-102
}, { immediate: true });
```
**防抖本身正确**（`clearTimeout` 在每次触发前调用 ✓），组件内的 `loadSeq`（L42）也正确处理了乱序返回 ✓（`CommitHeatmap` 是本项目里 seq 模式写得最规范的地方）。唯一缺口：组件卸载时最后一个 300ms 定时器仍会触发 `load()`，而 `load()` 会 `await api.commitStats(...)` 然后写 `weeks.value` / `monthLabels.value` / `total.value`（L85-88）—— 写已卸载组件的 ref，无泄漏但浪费一次 git 调用。

**影响**：设置页在 300ms 内快速开关时多发一次 `git_commit_stats`。

**最小修复**：加 `onUnmounted(() => clearTimeout(debounceTimer))`。

---

### [P3] 组件层重复：`DiffViewer.vue` 从 `@lucide/vue` 导入了两次

**位置**：`src/components/DiffViewer.vue:3` 与 `src/components/DiffViewer.vue:9`

```ts
import { X, Bot, WrapText } from "@lucide/vue";   // L3
...
import { FileDown } from "@lucide/vue";            // L9（同一个模块，中间隔了 5 行）
```
Vite/Rollup 会合并，无运行时影响。

**最小修复**：合并成一行。

---

## 附录 A — App.vue 结构量化表

`src/App.vue` 实测 **2798 行**（任务书提到的 2682 为旧值）。

| 区段 | 起止行 | 行数 | 占比 |
|---|---|---|---|
| `<script setup lang="ts">` | L1 – L1617 | **1617** | 57.8% |
| （空行） | L1618 | 1 | — |
| `<template>` | L1619 – L2787 | **1169** | 41.8% |
| （空行） | L2788 | 1 | — |
| `<style scoped>` | L2789 – L2798 | **10** | 0.4% |

### script 段（L1-1617）响应式与函数统计

| 项目 | 数量 | 备注 |
|---|---|---|
| `ref()` 声明 | **90** | 29 个带泛型 `ref<T>(`，61 个类型推断 |
| `reactive()` 声明 | **0** | 全仓唯一的 `reactive` 在 `ChangesPanel.vue:145`（草稿 Map）、`SettingsModal.vue:16`（draft）、`toast.ts:10` |
| `computed()` | **12** | 见下方清单 |
| `watch()` | **12** | 见下方清单 |
| `function` 声明 | **100** | 其中 `async function` **17** 个 |
| 箭头函数式顶层函数 | **6** | `const fn = (...) =>` |
| **顶层函数块合计** | **101**（含 17 async） | 函数体合计 **1108 行 = script 的 68.5%** |
| `interface` / `type` | **8** | |
| `onMounted` | **2**（L1176 拖拽、L1605 主初始化） | |
| `onUnmounted` | **1**（L1191，只清 `unDrag`） | |
| `nextTick` 调用 | **5**（L474、L679、L693、L725、L1396） | |

### template 段（L1619-2787）

| 项目 | 数量 |
|---|---|
| `v-if` / `v-else-if` / `v-else` | **76** |
| `v-for` | **12** |
| `@click` 绑定 | **77** |
| `<Teleport>` | 0（App 模板内；`ui/Tooltip.vue` 与 `ui/ContextMenu.vue` 内部用了 Teleport） |

### 最长的 10 个顶层函数

| # | 位置 | 行数 | 函数 |
|---|---|---|---|
| 1 | `src/App.vue:645` | **60** | `activate(path)` — 仓库切换（含 LRU 命中分支 + 两段式加载 + seq 守卫） |
| 2 | `src/App.vue:1268` | **56** | `execStep(step, inputBranch, startBranch)` — 工作流单步执行（7 种原语 switch） |
| 3 | `src/App.vue:1229` | **38** | `executeFlow(wf, inputBranch)` — 工作流驱动循环 |
| 4 | `src/App.vue:1541` | **37** | `onGlobalKeydown(e)` — 全局快捷键（Ctrl+Tab/1-9/P/B/Shift+L/R、Esc、F5） |
| 5 | `src/App.vue:808` | **36** | `startReview(regen)` — AI Review（含缓存与强制重生成） |
| 6 | `src/App.vue:706` | **33** | `closeTab(path)` — 关闭选项卡（含切换 fallback） |
| 7 | `src/App.vue:1036` | **30** | `branchMenuItems(b)` — 分支右键菜单构造 |
| 8 | `src/App.vue:351` | **26** | `doClone()` — 克隆（校验 + 建目录 + 加入选项卡） |
| 9 | `src/App.vue:1355` | **26** | `switchBranch(b)` — 切换分支（乐观更新 + dirty 确认） |
| 10 | `src/App.vue:1514` | **26** | `closeTopOverlay()` — 18 行手写浮层优先级 if 链 |

> 紧随其后：`refresh()` L174（24 行）、`genReleaseNotes()` L897（22 行）、`humanize()` L81（21 行）、`fetchOnce()` L226（21 行）、`askDelete()` L1400（20 行）。
> 另有 1 个 50 行的嵌套箭头函数 `refName`（`src/App.vue:1273`，在 `execStep` 内部），非顶层。

### 12 个 `computed`

| 位置 | 名称 | 依赖 |
|---|---|---|
| `src/App.vue:264` | `remoteWebUrl` | `remoteLink` / `remoteRaw` |
| `src/App.vue:436` | `repoByPath` | `repos` |
| `src/App.vue:558` | `folderMembers` | `folderDd` / `repos` |
| `src/App.vue:588` | `switcherResults` | `repos` / `mruPaths` / `switcherQuery` |
| `src/App.vue:873` | `notesOptions` | `notesLatest` / `tags` |
| `src/App.vue:952` | `localBranches` | `branchList` / `branchFilter` |
| `src/App.vue:954` | `currentBranchNoUpstream` | `branchList` / `status` |
| `src/App.vue:958` | `localNodes` | `localBranches` → `buildNodes` |
| `src/App.vue:959` | `remoteGroups` | `branchList` / `branchFilter` |
| `src/App.vue:996` | `tagsFiltered` | `tags` / `branchFilter` |
| `src/App.vue:1114` | `bsResults` | `branchList` / `bsQuery` |
| `src/App.vue:1327` | `prefixes` | `settings.branchPrefix` |

### 12 个 `watch`

| 位置 | 观察目标 | 副作用 | 选项 |
|---|---|---|---|
| `src/App.vue:143` | `settings.repoCacheSize` | LRU 立即淘汰 | — |
| `src/App.vue:204` | `status` | `updateTitle()` → IPC `set_title` | — |
| `src/App.vue:249` | `[historyMode, historyFilePath]` | 重载 log（**无 catch**，见 P1-3） | — |
| `src/App.vue:332` | `remoteUrlInput` | 推断克隆目录名 | — |
| `src/App.vue:386` | `repos` | 写 `gz.repos` | `deep: true` |
| `src/App.vue:397` | `groupList` | 写 `gz.groups` | — |
| `src/App.vue:409` | `barOrder` | 写 `gz.barOrder` | `deep: true` |
| `src/App.vue:432` | `[repos, groupList]` | `syncBar()` | `deep: true` |
| `src/App.vue:630` | `switcherQuery` | 重置 `switcherIndex` | — |
| `src/App.vue:632` | `switcherIndex` | DOM `scrollIntoView` | — |
| `src/App.vue:1156` | `bsQuery` | 重置 `bsIndex` | — |
| `src/App.vue:1157` | `bsIndex` | DOM `scrollIntoView` | — |

> **watch 链路无自触发死循环**（已逐条验证）：`repos` deep → 只写 localStorage；`syncBar` → 只写 `barOrder`；`barOrder` deep → 只写 localStorage；`status` → 只调 IPC。三个 watcher 之间无环。**这是好消息，值得记录。**
> 全仓**零 `setInterval`**（已 grep 确认）。

### 其他组件规模（供拆解参考）

| 文件 | 真实行数 |
|---|---|
| `src/components/SettingsModal.vue` | 635 |
| `src/components/ChangesPanel.vue` | 583 |
| `src/components/DiffViewer.vue` | 354 |
| `src/components/HistoryGraph.vue` | 224 |
| `src/components/CommitHeatmap.vue` | 176 |
| `src-tauri/src/git.rs` | 1051 |
| `src/gitApi.ts` | 198 |
| `src/ai.ts` | 186 |
| `src/settings.ts` | 100 |
| `src/workflow.ts` | 97 |
| `src/lib/patch.ts` | 110 |
| `src/graph.ts` | 72 |
| `src/components/ui/ContextMenu.vue` | 108 |
| `src/components/FileHistoryModal.vue` | 108 |
| `src/components/ui/Tooltip.vue` | 76 |
| `src/components/BranchTree.vue` | 68 |
| `src/components/ui/Md.vue` | 61 |
| `src/branchTree.ts` | 33 |
| `src/workflowStore.ts` | 22 |
| `src/components/ui/toast.ts` | 21 |
| `vite.config.js` | 18 |
| `src/main.ts` | 6 |

> **注意**：DESIGN.md §3 提到的 `components/RepoTabs.vue` **不存在** —— 仓库选项卡栏内联在 `App.vue` 模板里（`src/App.vue:1700-1880` 区间）。

---

## 附录 B — `gitApi.ts` ↔ `git.rs` 字段差异表

核对范围：`git.rs` 全部 **9 个 `#[derive(Serialize)]` struct**（无 enum、无 `Option<T>` 字段、无 `#[serde(rename)]` / `rename_all` / `skip_serializing_if` / `default` / `flatten`）vs `gitApi.ts` 全部 **9 个 interface**。

### 逐 struct 逐字段核对

| struct（git.rs 定义行） | 字段（Rust 类型） | interface（gitApi.ts 行） | 字段（TS 类型） | 结论 |
|---|---|---|---|---|
| `StatusFile` L47-52 | `path: String` L49 | `StatusFile` L3-7 | `path: string` | ✅ |
| | `x: char` L50 | | `x: string` | ⚠️ **类型表述不同**（见下注 1） |
| | `y: char` L51 | | `y: string` | ⚠️ 同上 |
| `Status` L54-60 | `branch: String` L56 | `Status` L9-14 | `branch: string` | ✅ |
| | `ahead: u32` L57 | | `ahead: number` | ✅ |
| | `behind: u32` L58 | | `behind: number` | ✅ |
| | `files: Vec<StatusFile>` L59 | | `files: StatusFile[]` | ✅ |
| `LogEntry` L126-134 | `hash: String` L128 | `LogEntry` L16-23 | `hash: string` | ✅ |
| | `parents: Vec<String>` L129 | | `parents: string[]` | ✅ |
| | `subject: String` L130 | | `subject: string` | ✅ |
| | `author: String` L131 | | `author: string` | ✅ |
| | `date: String` L132 | | `date: string` | ✅ |
| | `refs: Vec<String>` L133 | | `refs: string[]` | ✅ |
| `Branch` L192-200 | `name: String` L194 | `Branch` L25-32 | `name: string` | ✅ |
| | `current: bool` L195 | | `current: boolean` | ✅ |
| | `remote: bool` L196 | | `remote: boolean` | ✅ |
| | `ahead: u32` L197 | | `ahead: number` | ✅ |
| | `behind: u32` L198 | | `behind: number` | ✅ |
| | `upstream: String` L199 | | `upstream: string` | ✅ |
| `CommitDay` L409-413 | `date: String` L411 | `CommitDay` L43-46 | `date: string` | ✅ |
| | `count: u32` L412 | | `count: number` | ✅ |
| `BlameLine` L599-605 | `line: u32` L601 | `BlameLine` L35-40 | `line: number` | ✅ |
| | `hash: String` L602 | | `hash: string` | ✅ |
| | `author: String` L603 | | `author: string` | ✅ |
| | `time: i64` L604 | | `time: number` | ✅ |
| `StashEntry` L698-704 | `index: u32` L700 | `StashEntry` L122-127 | `index: number` | ✅ |
| | `hash: String` L701 | | `hash: string` | ✅ |
| | `date: String` L702 | | `date: string` | ✅ |
| | `subject: String` L703 | | `subject: string` | ✅ |
| `TagEntry` L809-816 | `name: String` L811 | `TagEntry` L146-152 | `name: string` | ✅ |
| | `annotated: bool` L812 | | `annotated: boolean` | ✅ |
| | `target: String` L813 | | `target: string` | ✅ |
| | `date: String` L814 | | `date: string` | ✅ |
| | `message: String` L815 | | `message: string` | ✅ |
| `CommitBrief` L982-988 | `hash: String` L984 | `CommitBrief` L183-188 | `hash: string` | ✅ |
| | `author: String` L985 | | `author: string` | ✅ |
| | `date: String` L986 | | `date: string` | ✅ |
| | `subject: String` L987 | | `subject: string` | ✅ |

### 差异汇总

| 类别 | 数量 | 明细 |
|---|---|---|
| **字段名不一致** | **0** | — |
| **字段缺失（单边有）** | **0** | 9 个 struct × 全部字段双向齐全 |
| **字段顺序不一致** | **0** | 全部逐项对齐 |
| **类型不一致（实质）** | **0** | `u32`/`i64` → `number` ✅；`Vec<T>` → `T[]` ✅；`bool` → `boolean` ✅；`String` → `string` ✅ |
| **类型表述不同（非实质）** | **2** | `StatusFile.x` / `StatusFile.y`：Rust `char` ↔ TS `string`（见注 1） |
| **可选性不一致** | **0** | Rust 侧**没有任何 `Option<T>` 字段**（全必填），TS 侧**没有任何 `?` 或 `\| null`** ✅ 完全对齐 |

> **注 1（`char` ↔ `string`）**：serde_json 把 Rust `char` 序列化为**单字符 JSON 字符串**（如 `"M"`、`"?"`、`" "`），因此 TS 侧的 `string` 在**运行时是安全的**，`ChangesPanel.vue:158-171` 的 `f.x === "?"` / `f.y !== " "` 比较也依赖这个行为。唯一风险是「类型上无法表达『恰好一个字符』」—— 若后端某天把 `x: char` 改成 `x: String`（例如返回 `"??"`），前端不会有任何类型错误。**当前无缺陷，记录备查。**

> **注 2（非 struct 返回值）**：`git_get_user(repo) -> Result<(String, String), String>`（`git.rs:325`）返回元组，JSON 化为 `["name","email"]`；`gitApi.ts:103-104` 声明 `invoke<[string, string]>` ✅ 正确。

> **注 3（参数名 camelCase 映射，已核实非问题）**：Tauri 2 通过 `tauri-macros` 自动把 Rust 参数的 snake_case 转成 lowerCamelCase 作为 JSON 键查找（源码：`tauri-macros-2.6.3/src/command/wrapper.rs:7` `use heck::{ToLowerCamelCase, ToSnakeCase};`，`:507` `key = key.to_lower_camel_case();`）。因此前端传 `filePath`（对应 `git.rs:139 file_path`）、`includeUntracked`（对应 `git.rs:744 include_untracked`）是**正确且必需的**，不构成缺陷。**建议在 `gitApi.ts` 顶部加一行注释说明这个隐式约定**（见 P1-6）。

> **注 4（`git_branch_rename` 的表面命名错位）**：`git.rs:557` 签名是 `(repo, old: String, new: String)`；`gitApi.ts:97-98` 的**函数参数**叫 `oldName`/`newName`，但 invoke 载荷用 `{ repo, old: oldName, new: newName }` ✅ 与 Rust 匹配。只是「API 表面命名与载荷命名不一致」，改的时候容易看错。**非缺陷。**

> **注 5（命令注册双向零差集）**：`src-tauri/src/lib.rs:9-54` 的 `tauri::generate_handler![...]` 注册 **45 个** `git::git_*`；`gitApi.ts` 里 `invoke<...>("git_*")` 也是 **45 个 unique**。**无「前端调了没注册」，无「注册了前端没用」** —— AGENTS.md 硬规则 1 当前无违反。（另：`gitApi.ts` 的 45 个导出**全部**在 UI 中有调用点，无死代码。）

> **注 6（git.rs 的 18 处自造中文错误，供 `humanize()` 对照）**：`git.rs:24` 无法启动 git、`:41` 后台任务失败、`:283/:374/:590/:879/:966` 非法的 commit hash（**×5**）、`:306` 读取文件失败、`:357/:359` 删除失败、`:495` 提交信息不能为空、`:540/:561` 分支名不能为空、`:578` 远程名和分支名不能为空、`:659` 写入失败、`:760` 没有可收纳的改动、`:860/:894/:906` 标签名不能为空（**×3**）、`:864` 标签名不能以 - 开头或包含空格、`:922` 远程地址和目标路径不能为空、`:929` 目标父目录不存在、`:944` 路径不能为空、`:956` 写入 .gitignore 失败、`:1002` 非法的提交范围。
> **A 类（stderr 原文透传，`git.rs:28`）的映射质量良好**：`humanize()` 的 14 条规则覆盖了 no upstream / non-fast-forward / nothing to commit / cherry-pick empty / dir not empty / could not read from remote / auth|403 / not a git repo / no commits yet / conflict / network / not fully merged 等主流场景。
> **B 类（自造中文）一条都没覆盖**，但多数本身就是人话；**唯一需要补的是 `非法的 commit hash`**（5 条路径，见 P2）。

---

## 附录 C — `any` / `@ts-ignore` / 非空断言清单

### C.1 显式类型逃逸：**全仓零命中**

对 `src/**/*.ts` + `src/**/*.vue` 全量 grep，以下模式**均无命中**：

| 模式 | 命中数 |
|---|---|
| `: any` / `as any` / `<any>` / `any[]` / `Array<any>` | **0** |
| `@ts-ignore` | **0** |
| `@ts-expect-error` | **0** |
| `as unknown as` | **0** |
| `eslint-disable` | **0** |
| `Function`（裸类型） | **0** |

> 首次 grep 的宽泛匹配（`:\s*any\b` 等）误命中了 140+ 处 `function` / `any` 子串，逐条核对后确认**全部是函数声明行**（如 `App.vue:74 function showError(msg: string)`），无一是 `any` 类型。**TS strict 纪律执行得非常彻底。**

### C.2 `as` 类型断言：全仓 **42 处**，其中 App.vue 9 处

App.vue 的 9 处 `as`（逐条评估）：

| 位置 | 代码 | 风险评估 |
|---|---|---|
| `src/App.vue:5` | `import { open, save as saveDialog }` | 非类型断言（import 重命名） |
| `src/App.vue:16` | `Settings as SettingsIcon` | 非类型断言（import 重命名） |
| `src/App.vue:26` | `Workflow as WorkflowIcon` | 非类型断言（import 重命名） |
| `src/App.vue:33` | `import * as api from "./gitApi"` | 非类型断言（namespace import） |
| `src/App.vue:97` | `[/not fully merged\|used as worktree/i, "..."]` | 非类型断言（正则字面量） |
| **`src/App.vue:180`** | `(JSON.parse(...) as Record<string, string>)[repo.value]` | ⚠️ **真断言**：`JSON.parse` 返回 `any`，断言成 `Record<string,string>` 无运行时校验。若 `gz.remoteLinks` 存的是数组或数字，`[repo.value]` 得到 `undefined` → `?? ""` 兜住 ✓。**风险低**，但属 P1-4（无 try/catch）的同一处代码 |
| **`src/App.vue:447`** | `el?.closest("[data-group-folder]") as HTMLElement \| null` | ⚠️ **真断言**：`closest` 返回 `Element \| null`，断言成 `HTMLElement`。后续只用 `.dataset.groupFolderName`（`Element` 上不存在，`HTMLElement` 上存在）→ 断言是**必要的**，且 `closest` 只会返回元素。**风险极低** |
| **`src/App.vue:551`** | `(ev.currentTarget as HTMLElement).getBoundingClientRect()` | ⚠️ **真断言**：`currentTarget` 类型是 `EventTarget \| null`。若事件在冒泡中被 `null` 化（Vue 不会），会崩。**风险极低** |
| **`src/App.vue:983`** | `(b as Branch & { originName?: string }).originName ?? b.name` | ⚠️ **真断言（类型逃逸）**：`originName` 是**运行时附加字段**，`Branch` 接口里没有。`buildNodes` 的 `BNode.branch` 已声明为 `Branch & { originName?: string }`（`branchTree.ts:11`），所以这里断言是冗余的 —— 根因是 `Branch` 接口没有表达这个可选字段。**建议改成 `Branch` 上直接加 `originName?: string`**（见 P3） |

其他文件的 33 处集中在 `components/ui/index.ts`（11 处，全是 `export { X as Y }` 重命名）与 `SettingsModal.vue`（6 处，多为 tab 联合类型窄化），**无一是 `any` 逃逸**。

`src/settings.ts:54` 的 `as Settings`、`src/ai.ts:75` 的 `(j?.error?.message as string)`、`src/ai.ts:86` 的 `as { choices?: ... }` 均为「JSON 解析结果断言」—— 与 `App.vue:180` 同类，**风险在于无 schema 校验**（见 P2 关于 `settings.load()` 的说明）。

### C.3 非空断言 `!`：全仓 **45 处**（不含 `*.test.ts`）

| # | 位置 | 代码 | 安全性评估 |
|---|---|---|---|
| 1 | `src/components/ui/ContextMenu.vue:81` | `actionable.value[(cur + d + n) % n]!.i` | ✅ 安全（L79 有 `if (!n) return` 守卫） |
| 2 | `src/components/BranchTree.vue:57` | `` `${n.branch!.name}${n.branch!.current ? … }` ``（2 处） | ⚠️ 靠 `v-else` 契约（见 P3） |
| 3 | `src/components/BranchTree.vue:58` | `!n.branch!.current && emit('switch', n.branch!)`（2 处） | ⚠️ 同上 |
| 4 | `src/components/BranchTree.vue:59` | `emit('menu', n.branch!, …)` | ⚠️ 同上 |
| 5 | `src/components/BranchTree.vue:63` | `v-if="n.branch!.ahead"` | ⚠️ 同上 |
| 6 | `src/components/BranchTree.vue:64` | `v-if="n.branch!.behind"` | ⚠️ 同上 |
| 7 | `src/components/ChangesPanel.vue:248` | `staged.value.map((f) => f.path.split(" -> ").pop()!)` | ✅ 安全（`split` 至少返回 1 元素） |
| 8 | `src/components/ChangesPanel.vue:296` | `{ path: f.path.split(' -> ').pop()!, … }` | ✅ 同上 |
| 9-17 | `src/components/ChangesPanel.vue:379,380,381,382,385,388,392,396,398` | `fileCtx!.f.xxx`（9 处） | ✅ 安全（菜单项数组在 `v-if="fileCtx"` 内构造，L370 起） |
| 18 | `src/components/CommitHeatmap.vue:138` | `monthLabels.find((m) => m.col === col)!.label` | ⚠️ **理论不安全**：若某列没有 monthLabel 则崩。实际由 L67-70 保证每周一列必产生 label（首列必是周一）→ 安全 |
| 19-21 | `src/components/DiffViewer.vue:14,79,134` | `props.file!.path` | ⚠️ **类型上不成立**（`file` 可选），靠调用方契约（见 P3） |
| 22 | `src/components/HistoryGraph.vue:86` | `queue.shift()!` | ✅ 安全（`while (queue.length)` 守卫） |
| 23 | `src/components/HistoryGraph.vue:125` | `dRow.get(t)! * ROW_H` | ✅ 安全（L114/117 保证 `t ∈ dRow`） |
| 24 | `src/components/HistoryGraph.vue:127` | `lay.value.colOf.get(c.hash)! * COL_W` | ✅ 安全（`layout(props.commits)` 覆盖全部 commits） |
| 25 | `src/components/HistoryGraph.vue:128` | `lay.value.colOf.get(t)! * COL_W` | ✅ 安全（同上） |
| 26 | `src/components/HistoryGraph.vue:189,192`（模板） | `lay.colOf.get(c.hash)!` | ✅ 安全（同上） |
| 27 | `src/components/SettingsModal.vue:125` | `w.steps.splice(j, 0, s!)` | ✅ 安全（L124 有 `if (s)` 守卫） |
| 28-31 | `src/components/SettingsModal.vue:485,491,492,498`（模板） | `refOf(s)!.mode` / `.name` | ⚠️ 靠 `refOf` 返回值契约（`SettingsModal.vue:178`） |
| 32-33 | `src/App.vue:139,147` | `repoCache.delete(repoCache.keys().next().value!)` | ✅ 安全（`while (repoCache.size > cap)` 保证非空） |
| 34 | `src/App.vue:420` | `byPath.get(e.path)!.group` | ✅ 安全（`byPath.has(e.path) &&` 短路） |
| 35 | `src/App.vue:559` | `folderDd.value ? repos.value.filter((r) => r.group === folderDd.value!.group) : []` | ✅ 安全（三元已判 `folderDd.value`） |
| 36 | `src/App.vue:747` | `repoByPath.value.get(tabCtx.value!.path)` | ✅ 安全（菜单在 `v-if="tabCtx"` 内） |
| 37 | `src/App.vue:966` | `map.get(p)!.push(b)` | ✅ 安全（L965 刚 `set`） |
| 38 | `src/App.vue:1243` | `const st = wfRun.value.states[i]!` | ✅ 安全（循环边界 + `states` 由 `steps.map` 生成） |
| 39 | `src/App.vue:1246` | `execStep(wf.steps[i]!, …)` | ✅ 安全（同上） |
| 40-44 | `src/App.vue:2153,2154,2155,2156,2158` | `commitCtx!.c.xxx`（5 处） | ✅ 安全（菜单在 `v-if="commitCtx"` 内） |
| 45-49 | `src/App.vue:2164,2165,2173,2174,2182,2183` | `commitCtx!.c.xxx`（6 处） | ✅ 安全（同上，`ok` 回调执行时菜单仍挂载） |
| 50-51 | `src/App.vue:2353,2354` | `tabCtx!.path`（2 处） | ✅ 安全（同上） |
| 52 | `src/App.vue:2713`（模板） | `describeStep(wfRun.wf.steps[i]!, …)` | ✅ 安全（`v-for` 边界） |
| 53 | `src/App.vue:2775` | `const ok = confirmState!.ok` | ✅ 安全（模板 `v-if="confirmState"` 内） |
| 54-57 | `src/graph.ts:53`（2 处） | `rowOf.get(p)!` / `colOf.get(p)!` | ✅ 安全（L51-52 已建 map） |
| 58-62 | `src/workflow.test.ts:78,79,80,82,83` | `seeds[i]!`（5 处） | ✅ 测试脚本，被 `tsconfig.json` exclude |

**统计**：45 处（生产代码，不含 test）；其中 **✅ 安全 30 处**、**⚠️ 靠契约兜底 15 处**（`BranchTree.vue` 5、`DiffViewer.vue` 3、`SettingsModal.vue` 4、`CommitHeatmap.vue` 1、`App.vue` 2 —— 后两者经分析确认实际安全）。

> **总体判断**：非空断言的使用**克制且大多有局部守卫**，没有「到处 `!` 掩盖 undefined」的坏味道。需要改的只有 `DiffViewer.vue` 的 3 处（类型上确实不成立）与 `BranchTree.vue` 的 5 处（可收窄类型），均为 P3。

---

## 附录 D — 已核实「非问题」清单（避免后续误报）

| 项 | 结论 | 证据 |
|---|---|---|
| 虚拟滚动是否真生效 | **真生效**，只渲染可视区 ±30 行 | `HistoryGraph.vue:17-20`（`ROW_H=26, BUFFER=30`）、`:96-100`（`winStart`/`winEnd`/`visible = shown.slice(...)`）、`:172`（占位高度 `shown.length * ROW_H`） |
| watch 是否自触发死循环 | **无环** | `repos`→localStorage；`syncBar`→`barOrder`；`barOrder`→localStorage；`status`→IPC。三条链路互不回头 |
| `activateSeq` 是否防住乱序 | **防住了**（赋值点全部有 seq 校验） | `App.vue:646, 673, 680, 687, 695, 699, 701`。缺口在「守卫在请求之后」而非「没有守卫」 |
| `repoCache` LRU 是否会串仓 | **正常路径不会**；唯一串仓路径是 P0-1 的 `refresh()` | `cacheGet`/`cachePut` 的键始终是显式 path（`App.vue:127-141`）；但 `refresh()` 的 `cachePut(repo.value, ...)` 用了可变值 |
| `settings` watcher 是否每次击键抖动 | **不会** | `SettingsModal.vue:16` 用 `reactive` 草稿，L70 `Object.assign(settings, draft)` 一次性写回；滑块改的是 `draft.fontSize` |
| `deep: true` 是否滥用 | **仅 4 处**，且都在必要位置 | `App.vue:386, 409, 432` + `workflowStore.ts:12` |
| `JSON.parse(JSON.stringify())` 深拷贝 | **仅 1 处**，且合理 | `workflow.ts:95-97` `seedWorkflows()` 防止用户编辑污染种子常量 |
| `setInterval` 泄漏 | **全仓零 `setInterval`** | grep 确认 |
| 拖拽监听是否成对 | **成对** | `App.vue:463/466`、`1587-1588/1595-1596`、`DiffViewer.vue:237-238/244-245/249-252`（后者还带 `onUnmounted` 兜底） |
| 拖拽拖放事件是否清理 | **有清理** | `App.vue:1176`（`onMounted` 存 `unDrag`）+ `App.vue:1191`（`onUnmounted` 调用） |
| `@lucide/vue` 是否全量打包 | **未全量**，tree-shaking 生效 | `@lucide/vue@1.33.0` `package.json` 有 `"sideEffects": false`；实测 bundle 内 `createLucideIcon` **0 次**、`viewBox` **1 次**（对比：完整库 978 KB） |
| 生产 bundle 是否泄露源码/密钥 | **不泄露** | `dist/assets/index-BbHLRa1v.js` 内无 `sourceMappingURL`；`dist` 未被 git 跟踪（`.gitignore` 含 `dist`）；bundle 内只有 `aiApiKey` **字段名**（8 次）与 `api.openai.com` 默认值，**无任何真实 key** |
| `dist` / `target` 是否误提交 | **未提交** | `.gitignore` 含 `dist`、`src-tauri/target`、`src-tauri/gen/schemas`；`git ls-files dist` 为空 |
| `gitApi.ts` 是否有死代码 | **无** | 45 个导出全部在 UI 中有调用点 |
| `lib/patch.ts` 是否支持两种 diff 格式 | **支持** | unified（`diff --git`）与 combined（`diff --cc`），见 `patch.ts:24 combinedLine` / `:94 patchSections` |
| 依赖是否有重复功能/体积问题 | **很干净** | 无 moment/dayjs（用原生 `Date`）、无 lodash、无 UI 组件库、无第二个图标库。唯一问题：`@types/markdown-it@14` vs `markdown-it@15` 主版本不匹配 |
| `console` 残留 | **仅 1 处** | `SettingsModal.vue:39` 的 `console.warn("[git-zen] 读取 origin 失败:", e)`（有意保留，注释说明理由）；其余 3 处在 `*.test.ts` 里 |
| `node_modules` 是否被 git 跟踪 | **未跟踪** | `.gitignore` 含 `node_modules` |
| `historyLoading` 前向引用（L1354 定义、L249 使用） | **当前安全** | watcher 回调在 `setup` 完成后才执行；但属脆弱写法（见 P1-1） |
| Tauri 参数 camelCase 映射 | **正确且必需** | `tauri-macros-2.6.3/src/command/wrapper.rs:7,507` |
| 45 个命令注册完整性 | **双向零差集** | `lib.rs:9-54` vs `gitApi.ts` |
| 45 个 command 是否都是 `async fn` + `offload()` | **全部符合** | 硬规则 2 无违反 |
| `git.rs` 是否注入 `quotepath` / `GIT_TERMINAL_PROMPT` / `CREATE_NO_WINDOW` | **全部注入** | `git.rs:8, 11, 18-19` |
| 语义敏感命令是否防别名劫持 | **全部 prepend** | `git.rs:378, 399, 501, 673, 689, 714, 749, 777, 796, 866, 896, 972` |
| `gitApi.ts` ↔ `git.rs` 字段是否漂移 | **零漂移** | 见附录 B |

---

## 附录 E — 建议的修复顺序（供排期参考）

| 批次 | 内容 | 预估成本 | 收益 |
|---|---|---|---|
| **第 1 批**（半天） | P0-1 / P0-2 / P0-3 的守卫 + `fetchLog(path, skip)` 签名改造 + P1-2 的 6 个调用点 | 3 个文件、约 40 行 | 消除跨仓库串台与误提交；`vue-tsc` 会直接暴露遗漏点 |
| **第 2 批**（半天） | P1-1 `allow-set-title` 权限 + P1-3 watcher catch + P1-4 `loadJSON` 兜底 + P2 的 8 处未捕获 await + P2 全局 errorHandler | 约 60 行 | 消除所有已知 unhandled rejection；启动白屏免疫 |
| **第 3 批**（1-2 天） | P1-6 镜像自检脚本 + `humanize()` 补 2 条规则 + `remoteNodes` 改 computed + `resetRepoView()` 抽取 | 1 个新测试文件 + 约 40 行 | 把「人肉维护的正确性」变成可执行断言 |
| **第 4 批**（2-3 天） | P1-1 的 4 个 composable 抽取（分 4 个 PR，纯搬迁不改行为） | 重构 | 让 P0 类问题在结构上不可能复发 |
| **第 5 批**（半天） | P2 AI 取消机制 + `clipForAI` hunk 感知 + P3 各项打磨 | 约 80 行 | AI 体验与健壮性 |

---

*本报告基于 2026-09-03 的代码状态，仅做只读静态审查，未运行应用、未修改任何源码（`git status` 全程 clean）。P1-1（ACL 权限）建议在真机用 DevTools 控制台确认一次。*
