# R1 — Rust 后端审查报告（git-zen）

审查对象：`src-tauri/src/git.rs`（1051 行）、`src-tauri/src/lib.rs`（58 行）、`src-tauri/src/main.rs`（5 行）、
`src-tauri/tauri.conf.json`（29 行）、`src-tauri/Cargo.toml`（23 行）、`src-tauri/capabilities/default.json`（18 行）
审查方式：全量读码 + 在 `%TEMP%` 独立临时仓库对 git 2.47.1.windows.2 做行为实证（未触碰项目源码）
日期：审查基线为工作区当前 HEAD

---

## 总体结论

后端整体健康度**中上**：架构高度收敛（全项目只有 1 个子进程创建点 `git.rs:4-30` 的 `run()`），
45 个 command **全部已注册**（`lib.rs:10-54` 与 `git.rs` 的 `#[tauri::command]` 一一对应，0 缺失 0 多余 0 重复），
**45/45 全部 `async fn` + `offload()`**，全项目 0 处 `unwrap()/expect()/panic!`（仅 `lib.rs:57` 启动期 `expect`，可接受），
0 共享可变状态（无 `static/Mutex/RwLock`），无 shell 拼接，`CREATE_NO_WINDOW` 覆盖 1/1。
**AGENTS.md 规则 1 与规则 2 当前均未被违反**——历史上栽过三次的漏注册问题已修复，且现在有成体系的写法。

最该修的三件事：
1. **P0 — 选项注入面**：`git_checkout`(git.rs:533)、`git_push`(git.rs:518)、`git_tag_push`(git.rs:908)、
   `git_merge`(git.rs:570)、`git_branch_delete`(git.rs:552) 等把用户可控字符串直接当位置参数传，
   实证 `git checkout -f` 静默丢弃工作区改动、`git push -u origin --mirror` 把**全部本地分支**推到远程、
   `git push origin --force` 强推覆盖远程。git 2.47 全面支持 `--end-of-options`，是最小修复手段。
2. **P0 — `run()` 只取 stderr**（git.rs:28）：`commit` 无内容、`merge` 冲突这两类**高频**失败的诊断信息全在 stdout，
   实证 stderr 为空 → 前端 `humanize()` 收到空串 → 用户看到**完全空白的错误框**。
3. **P1 — 无超时**（git.rs:22-24 用 `cmd.output()`，Cargo.toml 无 `wait-timeout`）：`fetch/pull/clone` 在
   网络挂起或凭据交互时会**无限阻塞**（`spawn_blocking` 线程池被占满后整个应用的后端能力退化）。

> 说明：`git.rs:112` 的 `line[3..]` 按字节切片、`git.rs:641` 的 `l["author".len()..]` 同样按字节切片，
> 二者都依赖前缀恒为 ASCII，实测安全，仅记为 P3 健壮性建议。

---

## P0

### [P0] `git_checkout` 未隔离位置参数，`-f` 可静默丢弃工作区改动
**位置**：`src-tauri/src/git.rs:531-534`（`run(&repo, &["checkout", &name])`），调用点 `src/App.vue:1278`、`src/App.vue:1297`、`src/App.vue:1365`、`src/App.vue:1459`、`src/App.vue:2165`
**根因**：`name` 完全无校验、命令中也没有 `--` 或 `--end-of-options`。实测（git 2.47.1.windows.2，临时仓库）：
工作区 `a.txt` 有未提交改动（`MODIFIED`）时执行 `git checkout -f` → **exit=0 静默成功**，`a.txt` 回到 HEAD 版本 `CHANGED`，**未提交改动永久丢失**。同时 `git checkout -foo` → exit=129 `error: unknown switch 'o'`。
**影响**：前端任何能构造出 `-` 开头 ref 的入口（分支列表来自 `git branch --all`，而 `git update-ref refs/heads/-f HEAD` 实测 exit=0 可造出此类分支；从远端 fetch 也能带入）点击「切换」即静默毁掉用户工作区。属于**数据丢失级**。
**最小修复**：`run(&repo, &["checkout", "--end-of-options", &name])`。实测 `git checkout --end-of-options -f` → exit=1 `error: pathspec '-f' did not match any file(s) known to git`（选项被成功隔离），且 `git checkout --end-of-options master` → exit=0 正常切换，无回归。

### [P0] `git_push` 无上游回退分支可被 `--mirror` 注入，导致全量分支外泄
**位置**：`src-tauri/src/git.rs:508-524`（关键行 `git.rs:518` `run(&repo, &["push", "-u", "origin", &branch])`）
**根因**：`branch` 只判空（`git.rs:515`）不校验格式，且 `&branch` 位于 `origin` 之后被 git 当 refspec/选项解析。实测：分支名 `--mirror` 存在且 HEAD 在其上时，普通 `git push` 报 `fatal: The current branch --mirror has no upstream branch.`（命中 `git.rs:514` 的 `contains("no upstream")` 分支），回退执行 `git push -u origin --mirror` → **exit=0 真实执行**，输出 `* [new branch] --mirror -> --mirror`、`* [new branch] secret-branch -> secret-branch`、`* [new reference] origin/master -> origin/master`，远程 `for-each-ref refs/heads` 确认多出 `--mirror` 与 `secret-branch`。
**影响**：把仓库**全部本地分支**（含用户从未打算公开的）强推到 origin。**数据外泄级**，且不可撤销（远程已有记录）。
**最小修复**：回退分支改为 `run(&repo, &["push", "-u", "origin", "--end-of-options", &branch])`；并在入口对 `branch` 加 `!branch.starts_with('-')` 拦截。注意 `git push ... -- --mirror` 实测**无效**（`--` 之后仍被当 refspec，报 `src refspec --mirror does not match any`），**push 场景必须用 `--end-of-options` 或白名单**。

### [P0] `run()` 失败时丢弃 stdout，commit/merge 的高频失败返回空错误串
**位置**：`src-tauri/src/git.rs:25-29`（`Err(String::from_utf8_lossy(&out.stderr).trim().to_string())`）
**根因**：只把 stderr 当错误信息返回。实测（临时仓库）：
- `git commit -m x`（无暂存内容）→ **exit=1，诊断信息全在 stdout**（`On branch main … nothing added to commit but untracked files present`），**stderr 为空**；
- `git merge --no-edit side`（冲突）→ **exit=1，stdout 有 `CONFLICT (content): Merge conflict in a.txt` / `Automatic merge failed; fix conflicts and then commit the result.`**，**stderr 为空**。
  两条路径都让 `run()` 返回 `Ok("")` 之外的**空 Err**，`src/App.vue:81-101` 的 `humanize()` 拿到空串 → 所有正则都不命中 → `error.value = ""`。
**影响**：用户点「提交」（未暂存任何文件）或点「合并」（有冲突）时弹出一个**完全空白的错误框**（`src/App.vue:74-78`），既无原因也无指引；且 `humanize` 里已有的 `nothing to commit` / `conflict` 两条规则（`App.vue:86`、`App.vue:95`）**永远不会命中**，是「写了但没生效」的死规则。
**最小修复**：失败分支合并两路输出并优先保留有内容的一侧，例如 `let msg = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)); Err(msg.trim().to_string())`；或 stderr 为空时回落到 stdout。

### [P0] `git_tag_push` 的 tag 名可被当选项，`--force` 触发强推覆盖远程
**位置**：`src-tauri/src/git.rs:901-911`（`run(&repo, &["push", "origin", name.trim()])`），调用点 `src/App.vue:1029`
**根因**：仅判空（`git.rs:905`），无 `--end-of-options`、无 `-` 前缀拦截。实测：`git push origin --force --dry-run` → **exit=0**，输出 `543e757..a494086 master -> master`（`--force` 被当强推选项）；tag 名 `--force` 可由 `git update-ref refs/tags/--force <sha>`（实测 exit=0）造出并出现在 `git tag -l` 里，前端 tag 列表会照常渲染它，用户点「推送」即触发。
**影响**：**强推覆盖远程已有提交**，协作者的提交被丢弃。注意同文件的 `git_tag_create`（`git.rs:863`）**已经**做了 `name.starts_with('-')` 拦截，`git_tag_delete`/`git_tag_push` 却漏了——同一文件内防护标准不一致。
**最小修复**：`run(&repo, &["push", "origin", "--end-of-options", name.trim()])`；并把 `git.rs:863` 的 `-` 前缀校验抽成 `fn check_ref_name()` 供 create/delete/push 三处共用。

---

## P1

### [P1] 所有 git 子进程无超时，fetch/pull/clone 可无限挂起
**位置**：`src-tauri/src/git.rs:22-24`（`cmd.output()`）；`src-tauri/Cargo.toml:13-19` 无 `wait-timeout` 依赖
**根因**：`cmd.output()` 会一直等到子进程退出，没有任何 deadline。`git.rs:274`（fetch --all）、`git.rs:528`（pull）、`git.rs:931`（clone）是长网络命令，且 `spawn_blocking` 的线程池是有限的（默认 512，但 `git.rs:34-43` 每次操作占一个）。
**影响**：网络半开、SSH 握手卡住、或远程仓库巨大时，子进程永久阻塞；`src/App.vue:174-197` 的 `refresh()` 用 `Promise.all` 等 4 个命令，其中 `fetchAll` 挂住则整页刷新遮罩永不消失（`App.vue:105-113` 的 `refreshing` 只能靠 finally 复位）。**用户唯一出路是杀进程**。
**最小修复**：`Cargo.toml` 加 `wait-timeout = "0.2"`，在 `run()` 里改用 `cmd.spawn()` + `child.wait_timeout(Duration)`，超时后 `child.kill()` 并返回 `"git 命令超时（xx s），可能是网络或凭据问题"`。可只对 fetch/pull/clone/push 三类给长超时（如 300s），其余给短超时（如 60s）。
**备注**：`GIT_TERMINAL_PROMPT=0`（`git.rs:11`）已消除「等用户输密码」这一最主要挂起源，NOTES.md:41-44 的判断成立；但网络层挂起不受它保护。

### [P1] 路径类参数无校验，`..` 与绝对路径可越出仓库（读/写/删三处）
**位置**：
- `git.rs:305-306` `Path::new(&repo).join(&path)` + `std::fs::read` —— `git_diff_untracked`
- `git.rs:355-359` `Path::new(&repo).join(&path)` + `remove_dir_all` / `remove_file` —— `git_discard`（untracked 分支）
- `git.rs:659` `std::fs::write(&path, content)` —— `git_write_file`
- `git.rs:946-947` `Path::new(&repo).join(".gitignore")` + `read_to_string` —— `git_ignore_add`
**根因**：四处都直接拼接/使用前端传入的路径，无「必须在 repo 之内」的约束。实测（rustc 临时 probe）：`Path::new("C:\\repo").join("..")` = `C:\repo\..`；`join("..\\outside.txt")` = `C:\repo\..\outside.txt`；**`join(绝对路径)` 会直接替换 base**（`C:\repo`.join(`C:\Windows\win.ini`) = `C:\Windows\win.ini`）。`git_discard` 的 untracked 分支还会 `remove_dir_all`（**递归删除**）。
**影响**：`git_diff_untracked` 可读取仓库外任意文件（内容回传到前端渲染）；`git_discard` 可**递归删除仓库外目录**；`git_write_file` 可写任意路径（该 command 设计上就是给「保存对话框」用的，见 `git.rs:656` 注释与 `src/gitApi.ts:198`，无路径约束属设计取舍，但仍是能力面）；`git_ignore_add` 的 `repo` 也来自前端。
**最小修复**：加一个 `fn safe_join(repo: &str, p: &str) -> Result<PathBuf, String>`：先 `Path::new(p).is_absolute()` 拒绝，再 `canonicalize` 后校验 `starts_with(canonical_repo)`。四处统一走它。`git_write_file` 若确要支持任意路径，至少在注释与调用点明确它只能接系统对话框返回值。

### [P1] `git_ignore_add` 对非法 UTF-8 的 .gitignore 会静默清空整个文件
**位置**：`src-tauri/src/git.rs:947`（`let mut content = std::fs::read_to_string(&f).unwrap_or_default();`）
**根因**：`read_to_string` 在文件含非 UTF-8 字节时返回 `Err`，`unwrap_or_default()` 把错误吞成**空串**；随后 `git.rs:954-956` 把「空串 + 新行」写回同一路径。
**影响**：**用户原有 .gitignore 内容全部丢失**，且 `run()` 未参与、无任何错误提示。实测（rustc 临时 probe）：`fs::read_to_string` 对含非法 UTF-8 的文件返回 `Err: stream did not contain valid UTF-8`。GBK 编码的 .gitignore 在中文 Windows 上并不罕见。
**最小修复**：区分「文件不存在」与「读取失败」：`match std::fs::read_to_string(&f) { Ok(c) => c, Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(), Err(e) => return Err(format!(".gitignore 读取失败（可能是非 UTF-8 编码）: {e}")) }`。

### [P1] `git_config_user` 无 `--` 分隔，可把 `--global`/`--unset` 写成配置值
**位置**：`src-tauri/src/git.rs:335-347`（`run(&repo, &["config", "user.name", name.trim()])` 与 `["config", "user.email", email.trim()]`）
**根因**：值以裸位置参数传入。实测（临时仓库）：
`git config user.name --global` → **exit=0**，之后 `git config user.name` 读出 `--global`；同理 `--unset`、`--edit`、`--list` 全部 exit=0 并被写成值。
**影响**：用户提交者信息被写成 `--global` 这类垃圾字符串，此后所有提交的 author name 都是它；且**未来若把命令改成 `git config --global user.name <v>` 就会变成真实的全局配置污染**（当前是仓库级，危害有界）。这是典型的「参数位置错误但 git 不报错」陷阱。
**最小修复**：`run(&repo, &["config", "--", "user.name", name.trim()])` 或 `["config", "user.name", "--end-of-options", name.trim()]`；同时加 `!name.starts_with('-')` 校验（与 `git.rs:863` 的 tag 校验同风格）。

### [P1] 重命名文件的 `path` 未拆分，暂存/丢弃/diff 三个入口全部失效
**位置**：`src-tauri/src/git.rs:107-117`（status 解析，`git.rs:112` `let mut path = line[3..].to_string();`）
**根因**：porcelain v1 的 rename 行形如 `R  a.txt -> b.txt`，解析后 `path` 是整串 `a.txt -> b.txt`（NOTES.md:69-70 已把它记为「待观察」，但未评估下游后果）。实测下游三条路径：
- `git add -- "a.txt -> b.txt"` → **exit=128 `fatal: pathspec 'a.txt -> b.txt' did not match any files`**（`git_stage` git.rs:472-479）
- `git checkout -- "a.txt -> b.txt"` → **exit=1 `error: pathspec … did not match any file(s) known to git`**（`git_discard` git.rs:363）
- `git diff -- "a.txt -> b.txt"` → exit=0 但**静默空输出**（`git_diff` git.rs:259-270）
**影响**：用户对「已重命名的改动」点暂存 → 报 pathspec 错；点丢弃 → 报错；点开看 diff → 空白。三个入口对同一类文件集体失效，且报错文案（`did not match any files`）对用户毫无意义。
**最小修复**：解析时按 ` -> ` 拆分（注意路径本身含 `->` 的极端情况，porcelain 对含特殊字符的路径会加引号，可先判 `starts_with('"')`），`StatusFile` 增加 `orig_path: Option<String>` 字段；`git.rs:112` 处 `let raw = line[3..]` 后 `raw.split_once(" -> ")`。**改这个字段必须同步 `src/gitApi.ts` 的 `StatusFile` interface（AGENTS.md 规则 3）**。

### [P1] `git_get_user` / `git_remote_url` / `git_latest_tag` / `git_check_repo` 用 `unwrap_or_default()` 吞掉真实错误
**位置**：`git.rs:328-329`（`run(...).unwrap_or_default()` ×2）、`git.rs:461-464`、`git.rs:1034-1037`、`git.rs:1046-1048`
**根因**：把「git 报错」与「配置为空」折叠成同一个返回值（空串 / `false`）。例如 `git_check_repo` 对**不存在的路径**也返回 `false`（`run` 的 `current_dir` 失败 → `Err` → `unwrap_or(false)`），与「存在但不是仓库」无法区分；`git_get_user` 在仓库无 `user.name` 时返回空串，前端无法区分「没配」和「git 坏了」。
**影响**：诊断信息丢失，用户遇到异常时看不到任何线索。`git_check_repo` 的误判会让拖入不存在的目录时提示「所选目录不是 Git 仓库」（`src/App.vue:93` 的 humanize 规则），而真实原因是路径不存在。
**最小修复**：这 4 个 command 的返回值语义需要「空」是合法值，故不宜改成 `Err`；建议 `git_check_repo` 至少把 `Err(e)` 里的启动失败区分出来（如返回 `Result<bool,String>` 时 `Err` 只在路径不可访问时抛出）。

---

## P2

### [P2] `git_status` 的 ahead/behind 解析有两套并存，第一套（`git.rs:77-90`）是死逻辑
**位置**：`src-tauri/src/git.rs:77-90`（`for tok in line.split_whitespace() { match tok.parse::<u32>() { … } }`）
**根因**：`git.rs:91-106` 已用 `split("ahead ")` / `split("behind ")` + 数字前缀解析实现同样功能且更直白；`git.rs:77-90` 的匹配条件（把 token 与 `line.split("ahead").nth(1)` 的首 token 比对）几乎不可能命中，且即使命中也会被 `git.rs:91` 覆盖。
**影响**：无功能影响，但每次读代码都要判断「哪套是真的」，属认知负担与未来改错的隐患（NOTES.md:87-91 描述的格式 `[ahead 1]` / `[behind 2, ahead 3]` / `[gone]` 已由第二套正确覆盖）。
**最小修复**：删除 `git.rs:77-90`，只保留 `git.rs:91-106`。

### [P2] 空仓库/detached HEAD 时 `branch` 字段被污染成提示语句
**位置**：`src-tauri/src/git.rs:74-76`
**根因**：实测 `git status --porcelain=v1 -b -uall` 首行在空仓库是 `## No commits yet on main`，`rest.split("...").next()` 得到整句 `No commits yet on main`；detached HEAD 时是 `## HEAD (no branch)` → branch = `HEAD (no branch)`。
**影响**：前端会把这句话当分支名渲染（如提交框上方的「当前分支」）。属显示层瑕疵，非崩溃。
**最小修复**：解析时特判 `No commits yet on` 与 `HEAD (no branch)`，分别给出空分支名或 `HEAD`，前端再用 i18n 文案兜底。

### [P2] `git_pull` 未传 `--no-edit`，特定配置下会等编辑器
**位置**：`src-tauri/src/git.rs:526-529`（`run(&repo, &["pull"])`）
**根因**：实测当前环境（git 2.47.1，默认配置）下 `git pull` 自动合并**不会**调起编辑器（用 `GIT_EDITOR=<marker 脚本>` 验证 marker 未生成，12 秒内正常结束并输出 `Merge made by the 'ort' strategy.`）。但该行为受 `merge.edit`、`GIT_MERGE_AUTOEDIT`、`pull.rebase` 等配置影响，用户环境不可控；结合 **P1 无超时**，一旦进入交互即为永久挂起。
**影响**：低概率但后果严重（窗口卡死，见 P1 无超时条目）。
**最小修复**：`run(&repo, &["pull", "--no-edit"])`（`git_merge` 的 `git.rs:570` 已经这么做了，`git_pull` 漏了）。

### [P2] `git_status` 单次刷新触发 4 个并发 git 调用，`git_get_user` 等存在 N+1
**位置**：`src/App.vue:174-197`（`refresh()` 用 `Promise.all([api.status, fetchLog(0), api.branches, api.tagList])`）；后端侧 `src-tauri/src/git.rs:327-331`（`git_get_user` 串行两次 `run`）、`git.rs:508-521`（`git_push` 失败时第二次 `run`）
**根因**：`refresh()` 一次拉 4 个 command = 4 个 git 进程（并发，可接受）；`git_get_user` 用两次独立 `run()` 分别读 `user.name` 与 `user.email`，本可一次 `git config --get-regexp '^user\.'` 或 `git config --list` 完成；`git_push` 的「先试 `push` 再回退 `push -u`」是**必然**的两次调用（首次必失败）。
**影响**：轻微——`git_get_user` 多一次进程启动（Windows 下 `git.exe` 冷启动约 20-50 ms）；`git_push` 的两次调用是设计取舍（换取「不猜上游」的简洁），可接受。
**最小修复**：`git_get_user` 改为一次 `run(&repo, &["config", "--get-regexp", "^user\\."])` 后解析两行。其余保持现状。

### [P2] 别名劫持防护（`-c alias.X=X`）覆盖不全，且实测其必要性低于文档预期
**位置**：已加防护：`git.rs:378`（revert）、`git.rs:399`（reset）、`git.rs:501`（commit）、`git.rs:673/675`（amend）、`git.rs:689`（reset）、`git.rs:713`（stash list）、`git.rs:749`（stash push）、`git.rs:777`（stash apply）、`git.rs:795`（stash drop）、`git.rs:866`（tag create）、`git.rs:896`（tag delete）、`git.rs:972`（cherry-pick）
未加防护：`branch`（`git.rs:230/552/563`）、`checkout`（`git.rs:533/542`）、`merge`（`git.rs:570`）、`push`（`git.rs:512/518/580/908`）、`pull`（`git.rs:528`）、`fetch`（`git.rs:274`）、`clone`（`git.rs:931`）、`show`（`git.rs:285/592`）、`log`（`git.rs:162`）、`status`（`git.rs:66`）、`diff`（`git.rs:267/388`）、`blame`（`git.rs:616`）、`config`（`git.rs:339/342`）
**根因/实证**：实测 `git config alias.log '!echo HIJACKED-LOG'` 后执行 `git log --oneline` → **仍输出真实提交**，`GIT_TRACE=1` 显示 `git.c:479 trace: built-in: git log --oneline`；`alias.status`/`reset`/`branch`/`clone` 同样**不能影子内置命令**。→ 该防护在当前 git 版本下属**纵深防御**，防的是「用户把 `alias.commit` 定义成 `commit && push`」这类（NOTES.md:99-103 的原始意图），而非影子命令。
**影响**：AGENTS.md:41 要求「语义敏感命令 prepend」，当前覆盖不一致，新加 command 时容易被漏掉；但实际风险等级低于注入类问题。
**最小修复**：把已用的 12 处与未用的清单写进 `docs/NOTES.md` 并规定「新 command 一律加」；或在 `run()` 里对白名单命令名自动注入，消除人工遗漏。**不建议**因此把 P2 提到 P1——实测必要性有限。

### [P2] `git_clone` 的 dest 语义与 `run()` 的 `current_dir` 组合易误用
**位置**：`src-tauri/src/git.rs:917-934`
**根因**：`git.rs:931` 用 `run(parent, &["clone", "--", url, dest])`——cwd 是 dest 的父目录，`dest` 是完整路径。实测 `git clone -- <本地源> <目标>` → exit=0 成功，语法正确。但 `run()` 的第一个参数在别处一律是「仓库路径」，此处是「父目录」，语义不一致；`git.rs:928` 只校验父目录存在，不校验 dest 是否已存在/为空。
**影响**：可读性与误用风险；`dest` 已存在且非空时由 git 报错（`src/App.vue:88` 有对应 humanize 规则，文案正常）。
**最小修复**：把 `clone` 单独实现（不复用 `run()`），或在 `git.rs:931` 上方补一行注释说明「第一个参数是父目录而非仓库」。

### [P2] `git_diff_untracked` 一次性把整个未跟踪文件读进内存
**位置**：`src-tauri/src/git.rs:306`（`std::fs::read(&p)`）
**根因**：先用 `std::fs::read` 全量读入 `Vec<u8>`，之后才用 `content.lines().take(2000)` 截断输出（`git.rs:314`）。截断只作用于**输出**，不作用于**读取**。
**影响**：未跟踪的大文件（如误入工作区的 ISO/日志/数据库文件）会一次性占满内存，`Vec<u8>` 与 `String::from_utf8_lossy` 的结果（`git.rs:312`）可能同时存在，峰值达文件大小的 2 倍。
**最小修复**：用 `std::fs::File` + `BufReader`，先读前 N KB 判二进制（`\0` 检测）并限制行数，避免全量 `read`；或先 `metadata().len()` 判大小，超过阈值（如 5 MB）直接返回「文件过大，请在终端查看」。

### [P2] `git_commit_stats` 无 `--max-count`，大仓库返回全量日志行
**位置**：`src-tauri/src/git.rs:421-436`
**根因**：`["log", format!("--since={}", since), "--pretty=format:%ad", "--date=short"]` 只有时间过滤，没有条数上限。Rust 侧聚合（`git.rs:437-452`）确实避免了把几万行传给前端（注释 `git.rs:408` 的意图达成），但**进程间管道仍要传完整日志**。
**影响**：活跃大仓库上首次打开热力图要等较久（git 输出 + 管道读取 + HashMap 聚合）。相对可控。
**最小修复**：`--since` 由前端给（如近一年），保持现状即可；若需优化，可加 `--no-merges` 或限制 `--max-count=50000`。

### [P2] `--all` 与 `--follow` 同时传入的行为与注释不符
**位置**：`src-tauri/src/git.rs:152-160`
**根因**：`git.rs:156` 注释写「与 `--all` 互斥（文件历史固定当前分支）」，但代码在 `all=true` 且 `file_path` 有值时**两个都 push**。实测 `git log --all --follow -- a.txt` → **exit=0 正常输出**，不报错。
**影响**：不崩溃，但「全部历史 + 文件历史」这个组合语义含糊（`--follow` 只沿重命名链，`--all` 会带上其他分支的同名文件提交）。前端 `src/App.vue:162-169` 的 `historyMode === "all"` 与 `historyFilePath` 可同时为真，会走到这条路径。
**最小修复**：按注释意图改为互斥（`file_path` 存在时不 push `--all`），或修正注释说明实测行为。

---

## P3

### [P3] `git.rs:112` / `git.rs:641` 按字节切片，依赖前缀恒为 ASCII
**位置**：`src-tauri/src/git.rs:112`（`let mut path = line[3..].to_string();`）、`src-tauri/src/git.rs:641`（`l["author".len()..].trim()`）
**根因**：Rust 的 `str` 索引按字节，落在多字节字符中间会 panic。实测安全性：porcelain 状态行恒为「2 字符状态码 + 1 空格」，前 3 字节必为 ASCII；`author` 行前缀也是 ASCII。故当前**不会 panic**。
**影响**：无当前影响。但若 git 未来改动格式（或有人复制这段到别处），会变成 panic（Tauri command 内 panic 会中止该任务并返回错误，非进程崩溃，但用户看到的是无信息错误）。
**最小修复**：改用 `line.get(3..).unwrap_or("")` 与 `l.strip_prefix("author").unwrap_or("").trim()`，把 panic 风险变成显式回落。

### [P3] `git_show` / `git_revert` / `git_cherry_pick` / `git_show_file` 的 hex 校验放行空串
**位置**：`src-tauri/src/git.rs:282`、`git.rs:373`、`git.rs:589`、`git.rs:965`（四处均为 `!hash.chars().all(|c| c.is_ascii_hexdigit())`）
**根因**：`"".chars().all(...)` 恒为 `true`，空串通过校验。实测 `git show --no-color --format= -m --first-parent ""` → **exit=0、stderr 为空**（git 把空串当 HEAD），即校验被绕过但未造成破坏。
**影响**：低。空 hash 时命令退化为「显示 HEAD」，行为不符合「非法的 commit hash」这一错误文案的意图。
**最小修复**：条件改为 `hash.trim().is_empty() || !hash.chars().all(...)`；顺带把四处重复校验抽成 `fn check_hash(h: &str) -> Result<(), String>`。

### [P3] `git_commits_range` 的 `from`/`to` 只拦 `-` 开头，未拦 `..`/`^` 等 rev 语法
**位置**：`src-tauri/src/git.rs:998-1012`（校验在 `git.rs:1001-1003`）
**根因**：`from`/`to` 被拼进 `format!("{from}..{to}")` 当 rev 表达式用（`git.rs:1007`），只做了 `starts_with('-')` 检查。`^`、`~`、`@{...}`、`:` 等 rev 语法未拦（但这些本就是合法的 rev 语法，属于设计意图，见 `git.rs:991` 注释「from 允许 tag 名」）。
**影响**：无越权（rev 表达式只能在仓库内解析），属输入面宽但危害低。
**最小修复**：无需修；若想收紧，可要求 `from`/`to` 匹配 `^[A-Za-z0-9._/@{}^~-]+$`。

### [P3] 依赖与配置面
**位置**：`src-tauri/Cargo.toml:13-19`、`src-tauri/tauri.conf.json:22`、`src-tauri/capabilities/default.json:6-17`
- **`csp: null`**（`tauri.conf.json:22`）：CSP 完全关闭。结合 `capabilities/default.json:13-16` 的 `http:default` scope 为 `https://**` + `http://**`（**全放开**）、AI Key 明文存 localStorage（`src/settings.ts:73`）、AI 输出经 `v-html` 渲染（`src/components/ui/Md.vue:17`，虽已 `html:false` 见 `Md.vue:9`），构成一条「注入 → 读 Key → 外发」的链路。建议把 `http` scope 收窄到用户配置的 baseUrl 域名，并给 CSP 设 `default-src 'self'` 起步。
- **`reqwest` 0.12.28 与 0.13.4 双版本共存**（`Cargo.lock`，523 个 package 中 `name = "reqwest"` 出现 2 次）：正是 NOTES.md:151-156 记录的坑（`tauri_plugin_http::reqwest` re-export 版本必须与显式依赖一致）。当前项目**无显式 reqwest 依赖**（`Cargo.toml:13-19` 只有 tauri 三件套 + serde），所以未触发编译错误；一旦要重做 AI SSE 转发并显式加 `reqwest`，极易踩中。
- **`glib 0.18.5`**：命中 [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)（`VariantStrIter` 的 `Iterator`/`DoubleEndedIterator` 实现不健全，影响 `<0.20.0`，无补丁版本）。glib 是 Linux 侧 GTK 依赖（Windows 构建不参与），属**低实际影响**；`cargo-audit` 在本机不可用（`error: no such command: audit`），**未能用工具复核 CVE**，以上为版本号比对结论。
- 其余版本较新：`tauri 2.11.5`、`tauri-plugin-dialog 2.7.2`、`tauri-plugin-http 2.5.9`、`time 0.3.55`（已远超 RUSTSEC-2020-0071 的 `<0.2.23`）、`tokio 1.53.1`、`rustls 0.23.43`、`h2 0.4.19`。
- `serde_json`/`serde`/`tauri` 用 `"1"`/`"2"` 宽松版本约束（`Cargo.toml:14-16`），有 `Cargo.lock` 锁定时无实际风险。

### [P3] 进程句柄与管道：无泄漏、无死锁，但 `spawn_blocking` 线程可能被长期占用
**位置**：`src-tauri/src/git.rs:22-24`（`cmd.output()`）、`git.rs:39`（`spawn_blocking(f).await`）
**根因**：`cmd.output()` 内部是 `wait_with_output()`——**并发**读取 stdout/stderr 后 `wait()` 回收子进程，因此（a）不存在「先读满 stdout 再读 stderr」的经典管道死锁；（b）子进程退出即被 reap，**无僵尸进程、无句柄泄漏**；`out` 在 `run()` 返回时 drop，两个管道句柄随之关闭。唯一的资源面是：每个 command 占一个 `spawn_blocking` 线程，配合 **P1 的无超时**，挂死的 git 会永久占住该线程。
**影响**：正常路径无资源问题；异常路径（网络挂起）下线程只增不减，极端情况耗尽 `tauri::async_runtime` 的 blocking 池。
**最小修复**：随 P1 的超时一起解决（超时后 `kill()` + `wait()` 回收）；无需额外改动。

### [P3] `git.rs:113-115` 的剥引号兜底对含 `"` 的路径不完整
**位置**：`src-tauri/src/git.rs:113-115`
**根因**：只在「首尾都是 `"`」时剥一层，未处理 git 的 C 风格转义（`\"`、`\\`、`\t`）。`core.quotepath=false` 只影响非 ASCII，含 `"` 或控制字符的路径 git 仍会加引号并转义。
**影响**：极罕见路径下 `path` 会带上转义字符，导致后续 pathspec 不匹配（与 P1 重命名问题同类，但触发条件苛刻）。
**最小修复**：若确要支持，需实现 git 的 `unquote_c_style`；否则在注释里记明「不支持含引号的路径」。

---

## 附 1：命令注册对照表（`git.rs` 的 `#[tauri::command]` vs `lib.rs` 的 `generate_handler!`）

核对方法：正则提取 `git.rs` 中 `#[tauri::command]` 之后的 `pub async fn <name>`，与 `lib.rs:10-54` 的 `git::<name>` 逐条比对。
结果：**45 个 command，45 个已注册，0 缺失，0 多余，0 重复**。**AGENTS.md 规则 1（历史上栽过三次的漏注册）当前未被违反。**

| # | command | git.rs 行 | lib.rs 行 | # | command | git.rs 行 | lib.rs 行 |
|---|---|---|---|---|---|---|---|
| 1 | git_status | 62 | 10 | 24 | git_branch_rename | 557 | 25 |
| 2 | git_log | 136 | 11 | 25 | git_merge | 568 | 26 |
| 3 | git_branches | 224 | 12 | 26 | git_push_delete | 574 | 27 |
| 4 | git_diff | 258 | 13 | 27 | git_get_user | 325 | 28 |
| 5 | git_fetch | 272 | 14 | 28 | git_config_user | 335 | 29 |
| 6 | git_show | 279 | 15 | 29 | git_discard | 350 | 30 |
| 7 | git_diff_untracked | 301 | 16 | 30 | git_revert | 370 | 31 |
| 8 | git_stage | 471 | 17 | 31 | git_diff_unpushed | 386 | 32 |
| 9 | git_unstage | 481 | 18 | 32 | git_write_file | 657 | 33 |
| 10 | git_commit | 491 | 19 | 33 | git_remote_url | 458 | 34 |
| 11 | git_push | 508 | 20 | 34 | git_show_file | 586 | 35 |
| 12 | git_pull | 526 | 21 | 35 | git_blame | 607 | 36 |
| 13 | git_checkout | 531 | 22 | 36 | git_reset_unpushed | 394 | 37 |
| 14 | git_branch_create | 536 | 23 | 37 | git_commit_stats | 415 | 38 |
| 15 | git_branch_delete | 547 | 24 | 38 | git_amend | 667 | 39 |
| 16 | git_undo_commit | 684 | 40 | 39 | git_stash_list | 707 | 41 |
| 17 | git_stash_push | 742 | 42 | 40 | git_stash_apply | 769 | 43 |
| 18 | git_stash_drop | 789 | 44 | 41 | git_tag_list | 821 | 45 |
| 19 | git_tag_create | 850 | 46 | 42 | git_tag_delete | 890 | 47 |
| 20 | git_tag_push | 902 | 48 | 43 | git_clone | 916 | 49 |
| 21 | git_ignore_add | 939 | 50 | 44 | git_cherry_pick | 962 | 51 |
| 22 | git_commits_range | 992 | 52 | 45 | git_latest_tag | 1031 | 53 |
| 23 | git_check_repo | 1043 | 54 | | | | |

（左列 1-23 与右列 24-45 共同构成 45 条；`lib.rs:56-57` 的 `.run(...).expect(...)` 为启动期唯一 `expect`。）

---

## 附 2：CREATE_NO_WINDOW 覆盖表

| 子进程创建点 | 位置 | 是否带 CREATE_NO_WINDOW | 说明 |
|---|---|---|---|
| `run()` 内 `Command::new("git")` | `src-tauri/src/git.rs:5` | ✅ `git.rs:17-19`（`#[cfg(windows)]` + `creation_flags(CREATE_NO_WINDOW)`，常量 `0x0800_0000`） | **全项目唯一的子进程创建点** |

- 全项目 `src-tauri/**/*.rs` 内 `Command::new` 仅出现在 `git.rs:5`；`Command::new("sh")` / `"cmd"` / `"powershell"` **0 处** → **无 shell 拼接**。
- `.output()` 仅出现在 `git.rs:23`（`cmd.output()`，内部 `wait_with_output()` 并发读双管道）→ **无「先读 stdout 再读 stderr」的经典管道死锁**。
- 结论：**覆盖 1/1，无遗漏**。AGENTS.md「平台与构建坑」第一条当前满足。

---

## 附 3：命令清单（名称 / 是否 async / 是否 offload / 参数校验）

| command | async | offload | 参数校验 | 选项隔离 |
|---|---|---|---|---|
| git_status | ✅ 62 | ✅ | repo 无校验 | — |
| git_log | ✅ 136 | ✅ | skip/all/file_path 无校验；file_path 有 `--` | ✅ `--`(158) |
| git_branches | ✅ 224 | ✅ | repo 无校验 | — |
| git_diff | ✅ 258 | ✅ | paths 无校验；有 `--` | ✅ `--`(265) |
| git_fetch | ✅ 272 | ✅ | repo 无校验 | — |
| git_show | ✅ 279 | ✅ | hash hex 校验（放行空串，见 P3） | hash 在末位 |
| git_diff_untracked | ✅ 301 | ✅ | **path 无校验，可越出 repo（P1）** | 文件直读 |
| git_stage | ✅ 471 | ✅ | paths 无校验；有 `--` | ✅ `--`(474) |
| git_unstage | ✅ 481 | ✅ | paths 无校验；有 `--` | ✅ `--`(484) |
| git_commit | ✅ 491 | ✅ | message 非空校验 | ✅ alias(501) |
| git_push | ✅ 508 | ✅ | **branch 仅判空（P0）** | ❌ 需 `--end-of-options` |
| git_pull | ✅ 526 | ✅ | — | ❌ 缺 `--no-edit`（P2） |
| git_checkout | ✅ 531 | ✅ | **name 无校验（P0）** | ❌ 需 `--end-of-options` |
| git_branch_create | ✅ 536 | ✅ | name 非空 + trim | `-b` 后为值 |
| git_branch_delete | ✅ 547 | ✅ | **name 无校验** | ❌ 需 `--end-of-options` |
| git_branch_rename | ✅ 557 | ✅ | new 非空；**old 无校验** | ❌ 需 `--end-of-options` |
| git_merge | ✅ 568 | ✅ | **name 无校验** | ❌ 需 `--end-of-options` |
| git_push_delete | ✅ 574 | ✅ | remote/name 非空 | ❌ 实测未注入成功 |
| git_get_user | ✅ 325 | ✅ | — | ⚠️ `unwrap_or_default` 吞错（P1） |
| git_config_user | ✅ 335 | ✅ | **name/email 无校验（P1）** | ❌ 缺 `--` |
| git_discard | ✅ 350 | ✅ | **path 无校验，untracked 走 `remove_dir_all`（P1）** | tracked 用 ✅ `--`(363) |
| git_revert | ✅ 370 | ✅ | hash hex 校验 | ✅ alias(378) |
| git_diff_unpushed | ✅ 386 | ✅ | — | — |
| git_write_file | ✅ 657 | ✅ | **path 完全无校验（P1，设计取舍）** | 文件直写 |
| git_remote_url | ✅ 458 | ✅ | — | ⚠️ `unwrap_or_default` 吞错（P1） |
| git_show_file | ✅ 586 | ✅ | hash hex 校验；有 `--` | ✅ `--`(592) |
| git_blame | ✅ 607 | ✅ | **rev 无校验**；有 `--` | ✅ `--`(614) |
| git_reset_unpushed | ✅ 394 | ✅ | — | ✅ alias(399) |
| git_commit_stats | ✅ 415 | ✅ | **since/author 无校验** | `--since=`/`--author=` 前缀拼接 |
| git_amend | ✅ 667 | ✅ | message 可空 | ✅ alias(673/675) |
| git_undo_commit | ✅ 684 | ✅ | — | ✅ alias(689) |
| git_stash_list | ✅ 707 | ✅ | — | ✅ alias(713) |
| git_stash_push | ✅ 742 | ✅ | message 可空；stdout 特判 `No local changes to save` | ✅ alias(749) |
| git_stash_apply | ✅ 769 | ✅ | index 为 u32（类型安全） | ✅ alias(777) |
| git_stash_drop | ✅ 789 | ✅ | index 为 u32 | ✅ alias(795) |
| git_tag_list | ✅ 821 | ✅ | — | tab 分隔（符合 NOTES.md:183-189） |
| git_tag_create | ✅ 850 | ✅ | name 空校验 + `-` 前缀 + 空白校验（**全项目最严**）；target hex 校验 | ✅ alias(866) |
| git_tag_delete | ✅ 890 | ✅ | name 仅判空 | ❌ 需 `--end-of-options` |
| git_tag_push | ✅ 902 | ✅ | **name 仅判空（P0）** | ❌ 需 `--end-of-options` |
| git_clone | ✅ 916 | ✅ | url/dest 非空 + 父目录存在；有 `--` | ✅ `--`(931) |
| git_ignore_add | ✅ 939 | ✅ | path 非空 | ⚠️ 非 UTF-8 清空文件（P1） |
| git_cherry_pick | ✅ 962 | ✅ | hash hex 校验 | ✅ alias(972) |
| git_commits_range | ✅ 992 | ✅ | from/to 拦 `-` 开头 | ❌ 无 `--`（rev 语法本就宽） |
| git_latest_tag | ✅ 1031 | ✅ | — | ⚠️ `unwrap_or_default` 吞错（P1） |
| git_check_repo | ✅ 1043 | ✅ | path 无校验 | ⚠️ `unwrap_or(false)` 吞错（P1） |

**统计**：45/45 全部 `async fn`；45/45 全部走 `offload()`；**同步 command 0 个**（AGENTS.md 规则 2 满足）。
显式参数校验：仅 12 个 command 有非空/hash/格式校验；**选项隔离（`--` 或 `--end-of-options`）缺失的命令 9 个**（checkout / branch_delete / branch_rename / merge / push / tag_delete / tag_push / config_user / commits_range）。

---

## 附 4：本次审查使用的实证方法与可复现命令

所有探针都在 `$env:TEMP\gz-*` 下的一次性临时仓库执行，**未读写 `E:\yoga app\ans\git-zen` 下的任何文件**。
环境：`git version 2.47.1.windows.2`（`LC_ALL`/`LANG` 为空；另测 `LANG=zh_CN.UTF-8` 后 git 消息仍为英文 → `git.rs:164/434/514/759` 的英文字符串匹配在当前环境可靠）。

关键可复现命令（均在临时仓库内）：

```powershell
# P0-1 checkout -f 静默丢改动
git checkout -f                                    # exit=0，未提交改动消失
git checkout --end-of-options -f                   # exit=1 "pathspec '-f' did not match"（修复验证）

# P0-2 push --mirror 外泄
git update-ref refs/heads/--mirror HEAD; git symbolic-ref HEAD refs/heads/--mirror
git push                                           # fatal: ... has no upstream branch  → 命中 git.rs:514
git push -u origin --mirror                        # exit=0，全部分支被推

# P0-3 stdout 承载错误
git commit -m x                                    # exit=1，stdout 有诊断，stderr 空
git merge --no-edit side                           # 冲突：exit=1，stdout 有 CONFLICT，stderr 空

# P0-4 tag push --force
git update-ref refs/tags/--force HEAD
git push origin --force --dry-run                  # exit=0，输出 ... master -> master

# P1-4 config 值注入
git config user.name --global; git config user.name   # 读出 "--global"

# P2-1 别名不能影子内置命令
git config alias.log '!echo HIJACKED-LOG'; git log --oneline   # 仍输出真实提交
```
