# 工作树（worktree）支持（设计）

> 状态：**第一批已实现，其余仍待做**。
> - 已完成：`git_worktree_list` + 标签栏/顶栏的身份标识（区分主工作树与从属工作树，0.4.0）
> - 未实现：新建 / 删除 worktree、切换分支被占用时的引导、`worktreeOf` 归属字段的完整使用
>
> 任务拆解见 `docs/TASKS.md` 的 M28。

## 为什么

`git worktree` 解决的是「同一个仓库、多个目录、各检出不同分支」。
对 git-zen 来说它不是锦上添花，而是**补掉现有交互的一个硬伤**：

现在的分支切换是「一个目录只能有一个分支」。想一边修 bug 一边跑 dev 服务，
用户只能 stash → 切分支 → 改回来，或者在别处再 clone 一份（两份 `.git`、
两套 remote、同步全靠手动）。

更要紧的是**失败路径**。目标分支被另一个目录检出时，checkout 会直接失败：

```
fatal: 'f2' is already used by worktree at 'C:/work/myproj-fix'
```

目前这条错误被 `lib/errors.ts` 的 `/used (as|by) worktree/` 规则接住，文案却是
「先切到别的分支再删」—— 那是给**删分支**写的。用户在切分支时看到这句话，
完全不知道该怎么继续。这是当前就存在的错配，worktree 功能正好把它一次修掉。

## 核心判断：worktree 是「另一个仓库 tab」，不是新面板

三条实测结论决定了整个设计：

1. **linked worktree 对现有所有命令都合法**。在 worktree 目录里
   `git rev-parse --is-inside-work-tree` 返回 `true`，`git_status` / `git_log` /
   `git_commit` 全部正常工作。也就是说 **`git_check_repo` 通过、能当仓库打开**。
2. **worktree 有自己的分支和独立工作区**，但共享同一份 `.git`（对象库、refs、remote）。
   所以「切到 worktree」在 UI 上等价于「切到另一个 tab」。
3. **从 worktree 里也能管理兄弟 worktree**：`worktree list` 输出全量，
   `worktree add` / `remove` 均可执行（只要不删自己）。

结论：**不新增「工作树面板」这个新概念**。worktree 就是 `repos` 列表里的一条 tab，
只多带一个归属字段 `worktreeOf`（主工作树路径）。这样

- LRU 缓存、选项卡分组、Ctrl+P 切换器、仓库总览、工作流批量执行 **全部零改动复用**；
- 用户心智一致 —— "这不就是再开一个 tab 嘛"；
- 不引入第二套「当前仓库」状态，也就不会出现两套状态互相打架。

代价：tab 栏会变多。这个代价用「tab 图标 + 归属分组」消化，而不是另造界面。

## 数据从哪来

### 唯一真值源是 git，不是 localStorage

`git worktree list --porcelain` 的格式（实测 git 2.47.1）：

```
worktree C:/work/main
HEAD 456a9fd3...
branch refs/heads/master

worktree C:/work/main-fix
HEAD 456a9fd3...
branch refs/heads/feat/x

worktree C:/work/main-det
HEAD 456a9fd3...
detached
locked experiment on usb

worktree C:/work/main-gone
HEAD 456a9fd3...
branch refs/heads/old
prunable gitdir file points to non-existent location
```

解析规则（都是实测确认的，别凭印象写）：

- **记录以空行分隔**，每条记录内 `key value`，key 是第一个空格之前的部分。
  用不带 `-z` 的版本：`run()` 返回 `String`，按行解析可读可测；
  Windows 路径不允许换行，所以按行是安全的。
- **第一条记录一定是主工作树**（git 文档保证 primary worktree 总在首位；
  在 linked worktree 里执行 `list` 输出顺序也不变，实测确认）。→ 用它判 `isMain`。
- `branch refs/heads/x` 要剥前缀成短名；`detached` 是**只有 key 没有 value** 的行；
  `locked` / `prunable` 同理（`locked` 后面可能跟 reason）。
- 空仓库第 HEAD 是全 0（`0000...`），此时 `branch` 仍然存在（unborn 分支）。

### 为什么分支占用信息只能从 list 拿

实测 `git branch --all --format='%(worktree)'` 直接报 `unknown field name: worktree`，
`for-each-ref` 也没有这个原子。**分支被哪个目录占用，只能问 `worktree list`。**

这决定了刷新策略：`refresh()` 的 `Promise.all` 里加一路 `worktreeList`。
`git worktree list` 是纯读 `.git/worktrees/*`，本地约十几毫秒，和 `status` 同级，
不值得为它省一次调用 —— 省下来的后果是「分支树上看不到占用标识」和
「切分支失败才知道被占」，那是这次要消灭的体验。

`RepoCache` 快照同步加一个 `worktrees` 字段（切回 tab 时列表不闪空）。

## 后端（`src-tauri/src/git.rs`）

三个新 command，全部 `async fn` + `offload()`，并注册进 `lib.rs`。

```rust
#[derive(Serialize)]
pub struct WorktreeEntry {
    path: String,
    head: String,        // 40 位；空仓库为全 0
    branch: String,      // 短名；空串 = 不在分支上
    detached: bool,
    locked: bool,
    lock_reason: String, // 空串 = 无
    prunable: bool,      // 目录已消失 / gitdir 指空
    prunable_reason: String,
    is_main: bool,       // 第一条记录
    missing: bool,       // path 目录当前不存在（我们额外 stat 一次）
}
```

- `git_worktree_list(repo) -> Vec<WorktreeEntry>`
  解析函数抽成 `fn parse_worktree_list(out: &str) -> Vec<WorktreeEntry>`，纯函数，
  在 `#[cfg(test)] mod` 里用上面的样例覆盖（含 detached / locked / prunable / 带空格路径 / 中文路径）。

- `git_worktree_add(repo, path, branch, create, base, detach) -> ()`

  | 参数 | 语义 |
  |---|---|
  | `path` | 目标目录**绝对路径**（可落在仓库外） |
  | `branch` | 空串 = 让 git 按目录名推断 |
  | `create` | true → `-b <branch>` 新建分支 |
  | `base` | 新建分支的起点，空 = HEAD |
  | `detach` | true → `--detach`（不占用任何分支） |

  参数互斥在进入 `git` 之前校验：`create && detach` 拒绝；`detach && branch` 非空拒绝。

  校验要点：
  - 路径不能复用 `check_repo_path`（它要求仓库内相对路径）。新写一个：
    非空、无控制字符、**必须绝对路径**、目标不存在或存在且为空目录。
    非空目录 git 会报 `already exists`，提前拦住能给出更好的话。
  - `branch` / `base` 过 `check_positional`。

  **孤儿分支自愈**（实测踩到的真坑）：`git worktree add -b newbr <已存在目录>`
  会先建出分支再失败 —— 报错后 `newbr` 留在分支列表里。
  所以：`create && refs/heads/<branch>` 已存在 → 直接报中文错，不给 git 机会；
  `add` 失败后若 `create` 且该分支是本次新建的，尝试 `git branch -D` 清掉（失败忽略）。
  否则用户会得到一个来路不明的分支。

- `git_worktree_remove(repo, path, force) -> ()`

  先 `parse_worktree_list` 校验 `path` 确实是注册过的工作树 ——
  拒绝任意路径直接进 `remove`。
  提前拦两种 git 自己会拒绝的情况，换成中文：
  - 目标是主工作树（`is a main working tree`）
  - 目标是**当前这个 repo 自己**（Windows 上是 `Permission denied`，因为文件被自己占着）

- `git_worktree_prune(repo) -> ()`：清理 prunable 记录（目录已被外部删除）。

## 前端

### 类型与纯函数（`src/lib/worktree.ts` + `worktree.test.ts`）

```ts
export interface WorktreeRow extends WorktreeEntry {
  name: string;                  // 目录末段
  shortHead: string;             // 前 7 位
  occupiedBranch: string | null; // detached / 无提交 → null
}

export function toRows(entries: WorktreeEntry[]): WorktreeRow[]
/** 分支名 → 占用它的工作树路径。切分支前置判断、分支树标识都靠它 */
export function branchOwners(entries: WorktreeEntry[]): Map<string, string>
/** 新建工作树的默认路径：<主工作树父目录>/<仓库名>-<分支末段>，重名自动加序号 */
export function suggestWorktreePath(mainPath: string, branch: string, taken: string[]): string
```

`branchOwners` 是这次设计的副产品，也是最值钱的一块：现有代码**无法**知道
「这个分支在别处被检出」，只能等 checkout 失败。有了它，切分支可以在**发请求前**
就给出正确选择。

纯函数都进 `worktree.test.ts`，并按仓库规矩加进 `tsconfig.json` 的 `exclude`
与 `package.json` 的 `verify`。

### 入口（三个，都指向同一个弹窗）

1. **分支右键菜单** → 「在新工作树中检出…」
   ← 最符合直觉的入口，也是唯一能解决「分支被占用切不过去」痛点的入口。
   已被别处占用的分支，此项**不置灰**，反而在它旁边标出占用目录。
2. **仓库 tab 右键菜单** → 「工作树管理…」（仅主工作树 tab 显示）。
3. **命令面板**（Ctrl+K）→ `工作树：新建…` / `工作树：管理…`。

### `components/WorktreeModal.vue`

一个弹窗同时承担「列出 / 新建 / 移除」，不拆三个。

列表每行：
- 目录名（粗体）+ 完整路径（小字，`title` 给全路径）
- 分支名 · 短 hash · `detached` 标记
- 状态胶囊：`当前`（正在看的这个）/ `主` / `已锁定` / `目录已丢失`
- 行操作：`切到这个目录` / `移除…`

`切到这个目录`：已在 `repos` 里 → `activate`；不在 → `addRepo` + `activate`
（对齐 `git_clone` 完成后的行为）。
**移除当前所在的工作树**：先 `activate` 到别的仓库再移除（不自作主张，先弹确认）。

新建表单：
- 目标目录：`Input` + 「选择…」（`plugin-dialog` 的目录选择），默认值来自 `suggestWorktreePath`
- 分支：`Select` 列本地分支 —— **已被别处占用的项禁用**，右侧写明占用路径；
  切到「新建分支」时变成 `Input` + 起点（默认当前 HEAD）
- 勾选「不检出分支（detached）」→ 分支选择整体禁用
- 脚注一句话解释规则：同一个分支不能同时在两个工作目录里检出

移除确认框文案按情况分支：
- 有未提交改动 → 需要第二层「强制移除」确认（对应 `--force`），文案写清「未提交的改动会丢失」
- `locked` → 提示先解锁
- 主工作树 / 自己 → 从一开始就不给按钮

### tab 的视觉标识

`RepoBar.vue` 加一个纯数据 prop `worktreeMainByPath: ReadonlyMap<string, string>`
（由 `repos` 里的 `worktreeOf` 现算）。worktree tab 在名字前放一个小分支图标，
`title` 写「属于 <主仓库> 的工作树」。分组不自动归组 —— 用户亲手排的顺序不该被猜。

### App.vue 接线

- `RepoTab` 加 `worktreeOf?: string`。**它只是首屏渲染的缓存**：
  真值以 `git_worktree_list` 为准，激活仓库时用 list 校正一次
  （用户可能在资源管理器里把目录删了）。不做成"只信 localStorage"。
- `refresh()` 的 `Promise.all` 加 `worktreeList`，结果存 `worktrees` ref + `cachePut`。
- `switchBranch` 前置判断：目标分支命中 `branchOwners` 且不是当前目录 →
  不调 checkout，直接弹确认框「这个分支已在 <路径> 检出，要不要在新工作树里打开？」→
  是则走 add + 切 tab。**这一步是错误文案修复之外的功能兑现点。**
- 新浮层 `worktree` 登记进 `lib/overlays.ts` 的 `overlayOrder`（放 `createBranch` 之后）
  与 `App.vue` 的 `overlayLayers`。

### `lib/errors.ts` 顺带修的错配

现有 `/used (as|by) worktree/` 的文案只适合删分支。新增更精确的一条，
放在 `/cannot delete branch/` **之后**、`/used (as|by) worktree/` 之前：

| 匹配 | 文案 |
|---|---|
| `/is already used by worktree at '([^']+)'/` | 这个分支已在 `<路径>` 检出：要么切到那个目录，要么用「在新工作树中检出」 |
| `/'[^']+' already exists/` | 目标目录已存在：换一个目录名（空目录可以用，非空不行） |
| `/is a main working tree/` | 主工作目录不能这样移除 |
| `/contains modified or untracked files/` | 这个工作目录里有未提交的改动，确认丢弃后可强制移除 |

## 明确不做

分期之外（长期不做）：

- **`worktree move`**：Windows 上路径搬移边界多，需求也弱，收益不抵风险。
- **`worktree repair`**：属于故障恢复。目录丢了就标「目录已丢失」+ 允许 prune 清记录，
  不做自动修复 —— 猜错路径比不修更糟。
- **自动清理 prunable**：清理是删记录，不做静默动作，只在列表里显式提示。
- **在总览里汇总各工作树的 status**：那是总览的另一个维度，先让 worktree 能以
  tab 形式被看见；汇总等有人真的需要再说。
- **远程分支直接建工作树**：只认本地分支（+ 后续的新建分支）。DWIM 的坑比收益多。

本期（第一期）不做，但已在设计中留好位置：

- **新建工作树 / 移除 / prune / 强制移除**：所有写操作都推后。
- **分支占用拦截（`switchBranch` 前置 + 分支树标识）**：见 S4。
  第一期只在该分支被占用而报错时给出更准的话，不改变切换流程。

## 分期（每期都能独立交付、独立回滚）

> **已拍板（2026-11-17）**：第一期只做 **S1 + S2** —— 只读列表 + 切换。
> S3（新建 / 移除 / prune）与 S4（分支占用拦截）本轮不做：
> `git_worktree_add`、`git_worktree_remove`、`git_worktree_prune`、`suggestWorktreePath`
> 一并推迟。因此本期**没有任何写操作** —— 不建目录、不删目录、不动分支，
> 只读 `git worktree list`，外加一个「切到该目录」。

| 期 | 内容 | 价值 |
|---|---|---|
| S1 | 后端 `list` + 弹窗只读展示 + tab 标识 | 零风险，先把「你有几个工作树」这件事显出来 |
| S2 | 点一行「切到这个目录」 | 已经很实用：不切分支就能在多份代码间跳 |
| S3 | 新建 / 移除 / prune | 完整闭环，不再需要开终端 |
| S4 | `branchOwners` 接入分支树标识 + `switchBranch` 前置拦截 | 消灭「切不过去」的困惑 |

## 验收标准

- `git_worktree_list` 对上面四种样例（普通 / detached / locked / prunable）解析正确，
  Rust 单测覆盖；带空格与中文路径不丢字符。
- `check-contract` 通过（4 个新 command 已注册 + `gitApi.ts` 镜像一致）。
- `git_worktree_add` 在目标目录非空时失败，且**分支列表里不残留新分支**。
- 移除当前正在浏览的工作树：先切走再删，成功；移除主工作树：按钮不存在，
  强行调用得到中文错误。
- `branchOwners` 单测覆盖：同一分支被两个记录声明时取第一个（git 本身不允许，
  但解析不能崩）。
- 切到被占用分支时不再直接抛 `fatal`，而是给出可选路径。
- `pnpm verify` 全绿（含新增的 `worktree.test.ts`）。
- 手工冒烟：主仓库 + 2 个工作树，三边各自 commit / stash / push，互相不串台。
