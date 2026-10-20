use serde::Serialize;
use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// 本地命令超时。git 在认证挂起、网络黑洞、或等一个不存在的锁时会**永远不退出**，
/// 而调用方是 spawn_blocking 线程——被占住就再也回不来，前端的加载遮罩永远不消失。
/// 120 秒足够任何正常本地操作（大仓库的 status/blame 也就几秒）。
const TIMEOUT_LOCAL: Duration = Duration::from_secs(120);
/// 网络命令（clone/fetch/pull/push/ls-remote）给足传输时间，只用来兜住「永久挂起」。
/// 取 10 分钟：克隆大仓库可能真的要几分钟，但卡死时用户最多等 10 分钟而不是无限。
const TIMEOUT_NETWORK: Duration = Duration::from_secs(600);

/// 判断是否网络类命令（决定用哪个超时）。只看 args 里有没有网络子命令——
/// 万一某个分支正好叫 `push` 而命令其实是 `checkout push`，也只会让超时从 120s 变成
/// 600s，无害；所以不必精确解析 `-c alias.x=x` 这类前置参数。
fn is_network(args: &[&str]) -> bool {
    args.iter()
        .any(|a| matches!(*a, "clone" | "fetch" | "pull" | "push" | "ls-remote"))
}

/// 读线程发回的消息：`Some(bytes)` 是数据块，`None` 是「这个管道读到 EOF 了」。
/// 用 EOF 标记而不是靠消息个数推断，是因为孙进程可能让管道永不 EOF。
type PipeMsg = (bool, Option<Vec<u8>>);

/// 把管道**边读边发**，而不是读完了再发一次。
/// 读完了再发要求 read_to_end 返回，而它只在 EOF 时返回——若孙进程持着管道写端，
/// 这批输出就永远送不回来（成功后静默丢失 diff）。边读边发则总能拿到已产生的部分。
/// 泛型是因为 `ChildStdout` 与 `ChildStderr` 是不同类型，但都实现 `Read`。
fn spawn_reader<R: Read + Send + 'static>(
    mut p: R,
    is_err: bool,
    tx: mpsc::Sender<PipeMsg>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match p.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send((is_err, Some(buf[..n].to_vec()))).is_err() {
                        return; // 接收端已放弃等待
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send((is_err, None));
    })
}

/// 带超时的 `Command::output()`。
///
/// 为什么不用 std 的 `output()`：它没有超时，会一直阻塞到进程退出。
/// 为什么不用 wait-timeout crate：它只解决 `wait` 的超时，管道还是得自己并发读，
/// 省不了几行，却要多一个依赖（这个项目刻意保持轻）。
///
/// 关键点：**两个管道必须并发读**。等进程退出再读，输出一旦超过管道缓冲区（约 64KB）
/// 子进程就会阻塞在写、我们阻塞在读 → 死锁。std 的 `output()` 内部也是这么做的，
/// 这里只是补上超时。
fn output_with_timeout(mut cmd: Command, limit: Duration) -> Result<Output, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 git: {e}"))?;

    // 读线程把结果送回主线程，而不是靠 join() 等待。
    // 原因：kill 只杀得掉直接子进程。git 常派生孙进程（git-remote-https / ssh /
    // 凭据助手），孙进程继承了管道写端，join() 会一直阻塞到它自己退出——超时形同虚设。
    // 用 recv_timeout 限时收集，超时就放弃这些字节。
    // 消息带 is_err 标记，不能靠到达顺序区分（两个读线程是竞速的）。
    let (tx, rx) = mpsc::channel();
    let _h_out = child.stdout.take().map(|p| spawn_reader(p, false, tx.clone()));
    let _h_err = child.stderr.take().map(|p| spawn_reader(p, true, tx.clone()));
    // 没接管到的管道视作已 EOF，否则会白等到超时
    let (mut out_eof, mut err_eof) = (_h_out.is_none(), _h_err.is_none());
    drop(tx);

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if start.elapsed() >= limit {
                    // 先杀再 wait 回收，避免留下僵尸进程
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待 git 退出失败: {e}")),
        }
    };

    // 进程已退出，正常情况下管道立刻 EOF；给 2 秒总预算收尾，之后不再等
    // （孙进程可能仍持有管道写端，见上）。超时被 kill 的分支本来就要报错，丢字节无妨。
    // 两个 EOF 标记都收到才提前结束；只收到一个也要把另一个的数据收完。
    let deadline = Instant::now() + Duration::from_secs(2);
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    while !(out_eof && err_eof) {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match rx.recv_timeout(left) {
            Ok((true, Some(buf))) => stderr.extend_from_slice(&buf),
            Ok((false, Some(buf))) => stdout.extend_from_slice(&buf),
            Ok((true, None)) => err_eof = true,
            Ok((false, None)) => out_eof = true,
            Err(_) => break,
        }
    }

    let Some(status) = status else {
        return Err(format!(
            "git 操作超时（{} 秒未完成），已终止。可能是网络不通、凭据卡住或仓库被锁。",
            limit.as_secs()
        ));
    };
    Ok(Output { status, stdout, stderr })
}

fn run(repo: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo)
        // 中文等非 ASCII 路径不转成八进制转义，否则展示和回传 pathspec 都会坏
        .args(["-c", "core.quotepath=false"])
        .args(args)
        // fail fast instead of hanging on credential prompt; system credential helper still works
        .env("GIT_TERMINAL_PROMPT", "0");

    // GUI 应用（windows_subsystem="windows"）里 spawn 控制台程序会弹黑框，
    // 打包后尤其明显（dev 模式父进程在终端里看不出）。必须禁止创建控制台窗口。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let limit = if is_network(args) { TIMEOUT_NETWORK } else { TIMEOUT_LOCAL };
    let out = output_with_timeout(cmd, limit)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        // commit 无内容、merge 冲突这类诊断只写在 stdout，只取 stderr 会让前端弹空白错误框
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        if !err.is_empty() {
            return Err(err.to_string());
        }
        let sout = String::from_utf8_lossy(&out.stdout);
        let sout = sout.trim();
        if !sout.is_empty() {
            return Err(sout.to_string());
        }
        Err(format!("git 退出码 {}", out.status.code().unwrap_or(-1)))
    }
}

/// 位置参数隔离：用户可控字符串要作为位置参数进 argv 时先过这里。挡掉空串、以 - 开头
/// （会被 git 当成选项）、含 ".."（会被当成范围）、含控制字符/换行。支持 --end-of-options
/// 的命令再叠一层 git 自己的隔离。what = 报错里的字段名（如 "分支名"）
fn check_positional(what: &str, s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err(format!("{what}不能为空"));
    }
    if s.starts_with('-') {
        return Err(format!("非法的{what}：不能以 - 开头"));
    }
    if s.contains("..") {
        return Err(format!("非法的{what}：不能包含 .."));
    }
    if s.chars().any(char::is_control) {
        return Err(format!("非法的{what}：不能包含控制字符"));
    }
    Ok(())
}

/// 仓库内相对路径校验：挡掉空串、控制字符、绝对路径与 `..` 越级。
///
/// 为什么不复用 check_positional：它按**子串**拒绝 `..`，那对分支名正确（git ref 本就
/// 禁止 `..`），但文件路径里 `a..b.txt` 是合法名字，按子串判会误杀。这里改成按
/// **路径组件**判断。
///
/// 危害实证：`Path::new(repo).join(path)` 在 path 是绝对路径时会**直接丢掉 base**，
/// 而 `../x` 会逃出仓库——`git_discard(untracked=true)` 会 remove_dir_all 掉仓库外的
/// 任意目录，`git_diff_untracked` 会读出仓库外文件内容。日常 `git status` 不会输出
/// 这种路径，所以这是纵深防御而非当前可利用漏洞，但成本极低。
fn check_repo_path(p: &str) -> Result<(), String> {
    if p.trim().is_empty() {
        return Err("路径不能为空".into());
    }
    if p.chars().any(char::is_control) {
        return Err("非法路径：不能包含控制字符".into());
    }
    let path = std::path::Path::new(p);
    // 注意：Windows 下 `/x` 与 `\x` 的 is_absolute() 是 **false**（有 RootDir 但没有盘符），
    // 而 join 会替换掉除盘符外的全部路径 → 照样逃出仓库。所以不能只看 is_absolute()。
    // 逐个组件判：Prefix（盘符/UNC）或 RootDir 出现即非相对路径，ParentDir 出现即越级。
    // 别写成「先 next() 取首组件、再扫其余」——首组件本身就是 `..` 时会漏过去（实测踩过）。
    for c in path.components() {
        match c {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err("非法路径：必须是仓库内的相对路径".into())
            }
            std::path::Component::ParentDir => return Err("非法路径：不能包含 ..".into()),
            _ => {}
        }
    }
    Ok(())
}

/// commit hash 校验。`"".chars().all(..)` 恒为 true —— 原来的写法会放行空串。
///
/// 定级说明（别夸大）：实测把空串作为**真实 argv 元素**传给 show / revert / cherry-pick /
/// log / rev-parse，git **全部 exit=128**（`fatal: ambiguous argument ''` / `bad revision ''`），
/// 并不会静默作用到 HEAD。所以这是健壮性问题（提前给出明确的中文报错，而不是把 git 的
/// ambiguous argument 抛给用户），不是静默改错目标的缺陷。
///
/// 踩坑提醒：用 PowerShell 验证这条会得出**错误结论**——PS 会把空串参数整个吞掉，
/// 于是实际执行的是「不带该参数」，而 `git show` 不带参数默认就是 HEAD（exit=0）。
/// 要测空 argv 必须用 Rust/Node 这类如实传递参数的宿主。
fn check_hex(hash: &str) -> Result<(), String> {
    let h = hash.trim();
    if h.is_empty() || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("非法的 commit hash".into());
    }
    Ok(())
}

// 同步 command 会阻塞 Tauri 主线程，git CLI 一慢整个窗口就无响应。
// 所有命令一律 async + spawn_blocking 扔到线程池，主线程只管 UI。
async fn offload<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(format!("后台任务失败: {e}")),
    }
}

// ---------- status ----------

#[derive(Serialize)]
pub struct StatusFile {
    path: String,
    x: char, // index/staged 状态码
    y: char, // worktree/unstaged 状态码
}

#[derive(Serialize)]
pub struct Status {
    branch: String,
    ahead: u32,
    behind: u32,
    files: Vec<StatusFile>,
}

#[tauri::command]
pub async fn git_status(repo: String) -> Result<Status, String> {
    offload(move || {
        // -uall：未跟踪目录展开成逐个文件（默认会把整个目录折叠成 src/ 导致无法 diff）
        let out = run(&repo, &["status", "--porcelain=v1", "-b", "-uall"])?;
        let mut st = Status {
            branch: String::new(),
            ahead: 0,
            behind: 0,
            files: vec![],
        };
        for line in out.lines() {
            if let Some(rest) = line.strip_prefix("## ") {
                // porcelain 首行实测有四种形态：
                //   `master...origin/master [ahead 1]`  正常有上游
                //   `master`                            有分支但无上游
                //   `No commits yet on master`          空仓库（还没提交）
                //   `HEAD (no branch)`                  游离 HEAD
                // 只按 "..." 切会在后两种形态下把整句描述当成分支名，而 branch 不只是显示——
                // 它会作为 push 的参数（→ `push -u origin "No commits yet on master"`，
                // 实测 exit=128 invalid refspec）和 AI 缓存键，必须剥干净。
                let head = rest.split("...").next().unwrap_or("").trim();
                st.branch = if let Some(b) = head.strip_prefix("No commits yet on ") {
                    b.trim().to_string()
                } else if let Some(b) = head.strip_prefix("Initial commit on ") {
                    b.trim().to_string()
                } else if head == "HEAD (no branch)" {
                    // 游离 HEAD 没有分支名，留空交给前端显示占位符
                    String::new()
                } else {
                    head.to_string()
                };
                if let Some(a) = line.split("ahead ").nth(1) {
                    st.ahead = a
                        .chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                        .parse()
                        .unwrap_or(0);
                }
                if let Some(b) = line.split("behind ").nth(1) {
                    st.behind = b
                        .chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                        .parse()
                        .unwrap_or(0);
                }
            } else if line.len() >= 3 {
                let mut chars = line.chars();
                let x = chars.next().unwrap_or(' ');
                let y = chars.next().unwrap_or(' ');
                // quotepath=false 后 CJK 不再转义；含特殊字符的路径仍可能带引号，兑底剥掉
                let mut path = line[3..].to_string();
                if path.starts_with('"') && path.ends_with('"') && path.len() > 1 {
                    path = path[1..path.len() - 1].to_string();
                }
                st.files.push(StatusFile { path, x, y });
            }
        }
        Ok(st)
    })
    .await
}

// ---------- log ----------

#[derive(Serialize)]
pub struct LogEntry {
    hash: String,
    parents: Vec<String>,
    subject: String,
    author: String,
    date: String,
    refs: Vec<String>,
}

#[tauri::command]
pub async fn git_log(
    repo: String,
    skip: Option<u32>,
    all: Option<bool>,
    file_path: Option<String>,
) -> Result<Vec<LogEntry>, String> {
    offload(move || {
        let mut args = vec![
            "log".to_string(),
            format!("--skip={}", skip.unwrap_or(0)),
            "--max-count=300".to_string(),
            "--date=relative".to_string(),
            // --pretty 必须在 -- pathspec 之前，否则会被当成第二个路径（--follow 报 exactly one pathspec）
            "--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%ad%x1f%D".to_string(),
        ];
        if all.unwrap_or(false) {
            args.push("--all".to_string());
        }
        if let Some(fp) = file_path {
            // --follow 追踪重命名前的历史；与 --all 互斥（文件历史固定当前分支）
            args.push("--follow".to_string());
            args.push("--".to_string());
            args.push(fp);
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = match run(&repo, &arg_refs) {
            Ok(o) => o,
            Err(e) if e.contains("does not have any commits yet") => return Ok(vec![]),
            Err(e) => return Err(e),
        };
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                (f.len() == 6).then(|| LogEntry {
                    hash: f[0].into(),
                    parents: f[1].split_whitespace().map(String::from).collect(),
                    subject: f[2].into(),
                    author: f[3].into(),
                    date: f[4].into(),
                    refs: f[5]
                        .replace("HEAD -> ", "")
                        .split(", ")
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect(),
                })
            })
            .collect())
    })
    .await
}

// ---------- branches ----------

#[derive(Serialize)]
pub struct Branch {
    name: String,
    current: bool,
    remote: bool,
    ahead: u32,
    behind: u32,
    upstream: String, // 空 = 远程还没有这个分支
}

// 解析 %(upstream:track) 形如 "[ahead 1]" / "[behind 2, ahead 3]" / "[gone]"
fn parse_track(s: &str) -> (u32, u32) {
    let cleaned = s.replace(['[', ']', ','], " ");
    let toks: Vec<&str> = cleaned.split_whitespace().collect();
    let (mut a, mut b) = (0, 0);
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            "ahead" if i + 1 < toks.len() => {
                a = toks[i + 1].parse().unwrap_or(0);
                i += 2;
            }
            "behind" if i + 1 < toks.len() => {
                b = toks[i + 1].parse().unwrap_or(0);
                i += 2;
            }
            _ => i += 1,
        }
    }
    (a, b)
}

#[tauri::command]
pub async fn git_branches(repo: String) -> Result<Vec<Branch>, String> {
    offload(move || {
        let out = run(
            &repo,
            &[
                "branch",
                "--all",
                "--format=%(HEAD)%00%(refname:short)%00%(refname)%00%(upstream:track)%00%(upstream:short)",
            ],
        )?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\u{0}').collect();
                (f.len() == 5).then(|| {
                    let (ahead, behind) = parse_track(f[3]);
                    Branch {
                        current: f[0] == "*",
                        name: f[1].into(),
                        remote: f[2].starts_with("refs/remotes/"),
                        ahead,
                        behind,
                        upstream: f[4].into(),
                    }
                })
            })
            .collect())
    })
    .await
}

// ---------- diff / fetch ----------

#[tauri::command]
pub async fn git_diff(repo: String, paths: Vec<String>, cached: bool) -> Result<String, String> {
    offload(move || {
        let mut args = vec!["diff", "--no-color"];
        if cached {
            args.push("--cached");
        }
        args.push("--");
        args.extend(paths.iter().map(|s| s.as_str()));
        run(&repo, &args)
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(repo: String) -> Result<(), String> {
    offload(move || run(&repo, &["fetch", "--all"]).map(|_| ())).await
}

/// 单个 commit 的完整 patch（多文件）
/// -m --first-parent：普通 commit 同默认；merge commit 对比第一父提交，否则合并提交无输出
#[tauri::command]
pub async fn git_show(repo: String, hash: String) -> Result<String, String> {
    offload(move || {
        check_hex(&hash)?;
        run(
            &repo,
            &[
                "show",
                "--no-color",
                "--format=",
                "-m",
                "--first-parent",
                "--end-of-options",
                &hash,
            ],
        )
    })
    .await
}

/// 预览读取上限。这个命令只用于「看一眼」，却一度用 std::fs::read 把整个文件读进内存，
/// 再判二进制、再截 2000 行——一个 GB 级的未跟踪文件（镜像、数据库转储）足以把内存打满。
const MAX_PREVIEW: u64 = 1024 * 1024;

/// 只读文件前 MAX_PREVIEW 字节；调用方据此预览。
fn read_preview(p: &std::path::Path) -> Result<Vec<u8>, String> {
    let mut f = std::fs::File::open(p).map_err(|e| format!("读取文件失败: {e}"))?;
    let mut bytes = Vec::new();
    f.by_ref()
        .take(MAX_PREVIEW)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(bytes)
}

/// 未跟踪文件的合成 diff：读文件内容，每行当新增行展示（上限 2000 行，二进制文件提示）
#[tauri::command]
pub async fn git_diff_untracked(repo: String, path: String) -> Result<String, String> {
    offload(move || {
        check_repo_path(&path)?;
        use std::path::Path;
        let p = Path::new(&repo).join(&path);
        let bytes = read_preview(&p)?;
        if bytes.contains(&0) {
            return Ok(format!(
                "diff --git a/{path} b/{path}\n（二进制文件，无法预览内容）"
            ));
        }
        let content = String::from_utf8_lossy(&bytes);
        let mut out = format!("diff --git a/{path} b/{path}\n@@ 新文件 @@\n");
        for line in content.lines().take(2000) {
            out.push('+');
            out.push_str(line);
            out.push('\n');
        }
        Ok(out)
    })
    .await
}

/// 读取当前仓库的提交者信息（仓库级 + 全局 git config）
#[tauri::command]
pub async fn git_get_user(repo: String) -> Result<(String, String), String> {
    offload(move || {
        // --default "" 让「没配过」变成 exit 0 + 空输出，与真正的失败（找不到 git、
        // 目录不存在）区分开。原来用 unwrap_or_default() 把两种都吞成空串，
        // 于是仓库打不开时设置页只显示两个空框，用户以为是自己没配。
        let n = run(&repo, &["config", "--default", "", "user.name"])?;
        let e = run(&repo, &["config", "--default", "", "user.email"])?;
        Ok((n.trim().to_string(), e.trim().to_string()))
    })
    .await
}

#[tauri::command]
pub async fn git_config_user(repo: String, name: String, email: String) -> Result<(), String> {
    offload(move || {
        // --end-of-options 让值即使写成 --global 也只当普通字符串（实测 2.47）
        if !name.trim().is_empty() {
            run(&repo, &["config", "--end-of-options", "user.name", name.trim()])?;
        }
        if !email.trim().is_empty() {
            run(&repo, &["config", "--end-of-options", "user.email", email.trim()])?;
        }
        Ok(())
    })
    .await
}

/// 丢弃更改：已跟踪文件 checkout -- 恢复；未跟踪文件直接删除（目录递归）
#[tauri::command]
pub async fn git_discard(repo: String, path: String, untracked: bool) -> Result<(), String> {
    offload(move || {
        check_repo_path(&path)?;
        if untracked {
            use std::path::Path;
            let p = Path::new(&repo).join(&path);
            if p.is_dir() {
                std::fs::remove_dir_all(&p).map_err(|e| format!("删除失败: {e}"))?
            } else {
                std::fs::remove_file(&p).map_err(|e| format!("删除失败: {e}"))?
            }
            Ok(())
        } else {
            run(&repo, &["checkout", "--", &path]).map(|_| ())
        }
    })
    .await
}

/// 丢弃暂存区的全部改动：暂存内容与工作区一起还原到 HEAD。
///
/// 不能用 `reset --hard HEAD -- <paths>`（git 直接拒绝：`fatal: Cannot do hard reset with paths.`），
/// 也不能先 `reset -q HEAD -- <paths>` 再 `checkout -- <paths>`（新增文件在 reset 后变成未跟踪，
/// checkout 会对它报 `pathspec ... did not match` 并整体失败）。
/// 正确做法是按「HEAD 里有没有这个路径」分区：
/// 有的走 `checkout HEAD --`（还原），没有的走 `rm`（新加进来的）。
///
/// 注意 `checkout -- <path>` 是**从暂存区**取内容，对已暂存的改动等于什么都没做，
/// 必须写成 `checkout HEAD -- <path>` 才是从 HEAD 取。
///
/// 路径由前端从 status 计算：重命名文件必须**同时传旧名和新名** ——
/// 旧名在 HEAD 里会被还原，新名不在 HEAD 里会被删除，只传一个会留下残缺状态。
/// 未跟踪文件不在暂存区，前端不会传进来。
///
/// `delete_new` 决定「HEAD 里没有的路径」怎么处理：true 连文件一起删（真正的丢弃），
/// false 只 `rm --cached` 取消暂存、文件留在磁盘上变成未跟踪。默认该由 UI 让用户选 ——
/// 新增文件往往是从未提交过的工作成果，删掉不可恢复。
#[tauri::command]
pub async fn git_discard_staged(
    repo: String,
    paths: Vec<String>,
    delete_new: bool,
) -> Result<(), String> {
    offload(move || {
        if paths.is_empty() {
            return Ok(());
        }
        for p in &paths {
            check_repo_path(p)?;
        }
        // 空仓库（无 HEAD）时把全部路径都当「不在 HEAD 里」。这里单独判 HEAD 而不是靠
        // ls-tree 失败兜底 —— 后者会把「仓库损坏」之类真错误也当成「都没提交过」，
        // 于是本该还原的文件被 rm 删掉。
        let has_head = run(&repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok();
        let tracked: Vec<String> = if has_head {
            // --end-of-options 之后全部当路径，防止以 - 开头的文件名被当成选项
            let mut ls = vec!["ls-tree", "-r", "--name-only", "HEAD", "--end-of-options", "--"];
            ls.extend(paths.iter().map(|s| s.as_str()));
            run(&repo, &ls)?
                .lines()
                .map(|s| s.to_string())
                .collect()
        } else {
            Vec::new()
        };
        let (in_head, not_in_head): (Vec<&String>, Vec<&String>) =
            paths.iter().partition(|p| tracked.iter().any(|t| t == *p));

        if !in_head.is_empty() {
            let mut args = vec!["checkout", "HEAD", "--end-of-options", "--"];
            args.extend(in_head.iter().map(|s| s.as_str()));
            run(&repo, &args)?;
        }
        if !not_in_head.is_empty() {
            // git rm **不认** `--end-of-options`（会把它后面的 `--` 当 pathspec 报
            // `did not match any files`），只能用 `--` 分隔
            let mut args = if delete_new {
                vec!["rm", "-q", "-f", "--"]
            } else {
                vec!["rm", "--cached", "-q", "-f", "--"]
            };
            args.extend(not_in_head.iter().map(|s| s.as_str()));
            run(&repo, &args)?;
        }
        Ok(())
    })
    .await
}

/// revert 指定提交（生成反向提交）
#[tauri::command]
pub async fn git_revert(repo: String, hash: String) -> Result<(), String> {
    offload(move || {
        check_hex(&hash)?;
        run(
            &repo,
            &[
                "-c",
                "alias.revert=revert",
                "revert",
                "--no-edit",
                "--end-of-options",
                &hash,
            ],
        )
        .map(|_| ())
    })
    .await
}

/// 未推送提交的合并 diff（upstream..HEAD）；ahead=0 时按钮不出现，无需处理无上游错误分支
#[tauri::command]
pub async fn git_diff_unpushed(repo: String) -> Result<String, String> {
    offload(move || run(&repo, &["diff", "--no-color", "@{upstream}..HEAD"]))
    .await
}

/// 放弃未推送的提交：硬重置回上游（未提交的工作区改动一并丢弃，确认框负责明示；
/// reflog 在 git 默认 gc 期内仍可找回）。ahead>0 才有入口，无上游由 git 报错兜底
#[tauri::command]
pub async fn git_reset_unpushed(repo: String) -> Result<(), String> {
    offload(move || {
        run(
            &repo,
            &["-c", "alias.reset=reset", "reset", "--hard", "@{upstream}"],
        )
        .map(|_| ())
    })
    .await
}

/// 提交热力图数据：since（YYYY-MM-DD）以来的提交按天计数（作者日期）。
/// author 非空时按作者过滤（--author，传 user.email 即"只看当前提交者"）。
/// Rust 侧聚合，只返回有提交的日期，避免大仓库传几万行原始日志
#[derive(Serialize)]
pub struct CommitDay {
    date: String, // YYYY-MM-DD
    count: u32,
}

#[tauri::command]
pub async fn git_commit_stats(
    repo: String,
    since: String,
    author: Option<String>,
) -> Result<Vec<CommitDay>, String> {
    offload(move || {
        let mut args = vec![
            "log".to_string(),
            format!("--since={}", since),
            "--pretty=format:%ad".to_string(),
            "--date=short".to_string(),
        ];
        if let Some(a) = author.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            args.push(format!("--author={}", a));
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = match run(&repo, &arg_refs) {
            Ok(o) => o,
            Err(e) if e.contains("does not have any commits yet") => return Ok(vec![]),
            Err(e) => return Err(e),
        };
        let mut counts: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
        for l in out.lines() {
            let d = l.trim();
            if !d.is_empty() {
                *counts.entry(d).or_insert(0) += 1;
            }
        }
        let mut days: Vec<CommitDay> = counts
            .into_iter()
            .map(|(date, count)| CommitDay {
                date: date.to_string(),
                count,
            })
            .collect();
        days.sort_by(|a, b| a.date.cmp(&b.date));
        Ok(days)
    })
    .await
}

/// origin 远程的 URL（无远程返回空串）；前端据此推断网页链接
#[tauri::command]
pub async fn git_remote_url(repo: String) -> Result<String, String> {
    offload(move || {
        Ok(run(&repo, &["remote", "get-url", "origin"])
            .unwrap_or_default()
            .trim()
            .to_string())
    })
    .await
}

// ---------- actions ----------

#[tauri::command]
pub async fn git_stage(repo: String, paths: Vec<String>) -> Result<(), String> {
    offload(move || {
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        run(&repo, &args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(repo: String, paths: Vec<String>) -> Result<(), String> {
    offload(move || {
        let mut args = vec!["reset", "-q", "HEAD", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        run(&repo, &args).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_commit(repo: String, message: String) -> Result<(), String> {
    offload(move || {
        if message.trim().is_empty() {
            return Err("提交信息不能为空".into());
        }
        // alias.commit=commit 强制用内置 commit，防止用户全局别名把提交劫持成“提交并推送”
        // 注意：post-commit hook 不受此控制，若仓库 hook 里有 push 仍会触发
        run(
            &repo,
            &["-c", "alias.commit=commit", "commit", "-m", &message],
        )
        .map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_push(repo: String, branch: String) -> Result<(), String> {
    offload(move || {
        // 远程还没有这个分支时，普通 push 会报 no upstream；自动改用 -u 建立跟踪并推送
        match run(&repo, &["push"]) {
            Ok(_) => Ok(()),
            Err(e) if e.contains("no upstream") || e.contains("no tracking information") => {
                let b = branch.trim();
                if b.is_empty() {
                    return Err(e);
                }
                check_positional("分支名", b)?;
                run(&repo, &["push", "-u", "origin", "--end-of-options", b]).map(|_| ())
            }
            Err(e) => Err(e),
        }
    })
    .await
}

/// 强制推送：必须带 --force-with-lease（远程被别人更新过就拒绝），严禁裸 --force。
/// branch 为空 = 推当前分支到它的上游
#[tauri::command]
pub async fn git_push_force(repo: String, branch: String) -> Result<(), String> {
    offload(move || {
        let b = branch.trim();
        if b.is_empty() {
            return run(&repo, &["push", "--force-with-lease"]).map(|_| ());
        }
        check_positional("分支名", b)?;
        // push 的第一个位置参数是远程名，必须显式给 origin，否则 git 拿分支名当远程（实测 2.47）
        run(
            &repo,
            &["push", "--force-with-lease", "origin", "--end-of-options", b],
        )
        .map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_pull(repo: String) -> Result<(), String> {
    // --no-edit：合并由 pull 自己发起时，别弹出编辑器卡住无终端的 GUI 进程
    offload(move || run(&repo, &["pull", "--no-edit"]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_checkout(repo: String, name: String) -> Result<(), String> {
    offload(move || {
        // checkout 支持 --end-of-options：-f 之类会被当成分支名而不是选项（实测 2.47）
        let name = name.trim();
        check_positional("分支名", name)?;
        run(&repo, &["checkout", "--end-of-options", name]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_branch_create(repo: String, name: String) -> Result<(), String> {
    offload(move || {
        // name 在 -b 的参数位，不会被当成选项，校验只为挡空串/控制字符
        let name = name.trim();
        check_positional("分支名", name)?;
        run(&repo, &["checkout", "-b", name]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_branch_delete(repo: String, name: String, force: bool) -> Result<(), String> {
    offload(move || {
        // 默认 -d 安全删（未合并会拒绝）；force 用 -D 强删
        let name = name.trim();
        check_positional("分支名", name)?;
        let flag = if force { "-D" } else { "-d" };
        run(&repo, &["branch", flag, "--end-of-options", name]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_branch_rename(repo: String, old: String, new: String) -> Result<(), String> {
    offload(move || {
        let old = old.trim();
        let new = new.trim();
        check_positional("分支名", old)?;
        check_positional("新分支名", new)?;
        // -m 不带参数，两个名字都是位置参数，--end-of-options 放在它们之前（实测 2.47）
        run(&repo, &["branch", "-m", "--end-of-options", old, new]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_merge(repo: String, name: String) -> Result<(), String> {
    offload(move || {
        // merge 支持 --end-of-options：-s/-X 之类会被当成分支名（实测 2.47）
        let name = name.trim();
        check_positional("分支名", name)?;
        run(&repo, &["merge", "--no-edit", "--end-of-options", name]).map(|_| ())
    })
    .await
}

/// 中断冲突中的多步操作，工作区回到操作之前。
///
/// 按 detect_op 分派：原来只跑 `merge --abort`，在 cherry-pick / revert 冲突时
/// 会报「There is no merge to abort」，于是这三种操作在界面上有「继续」没有「放弃」。
#[tauri::command]
pub async fn git_merge_abort(repo: String) -> Result<(), String> {
    offload(move || {
        match detect_op(&repo)?.as_deref() {
            Some("merge") => run(&repo, &["merge", "--abort"]),
            Some("cherry-pick") => run(&repo, &["cherry-pick", "--abort"]),
            Some("revert") => run(&repo, &["revert", "--abort"]),
            Some(other) => Err(format!("当前是 {other} 状态，请在终端里放弃")),
            None => Err("当前没有进行中的合并或拣选".into()),
        }
        .map(|_| ())
    })
    .await
}

/// 删除远程分支：git push <remote> --delete <name>
#[tauri::command]
pub async fn git_push_delete(repo: String, remote: String, name: String) -> Result<(), String> {
    offload(move || {
        let remote = remote.trim();
        let name = name.trim();
        // remote 在 --end-of-options 之前、处于位置参数位，得自己校验；--end-of-options
        // 只能放在 --delete 之后（放它前面实测会把 --delete 当成 refspec）
        check_positional("远程名", remote)?;
        check_positional("分支名", name)?;
        run(&repo, &["push", remote, "--delete", "--end-of-options", name]).map(|_| ())
    })
    .await
}

/// 单个 commit 中单个文件的 patch（文件历史弹窗右侧用）
#[tauri::command]
pub async fn git_show_file(repo: String, hash: String, path: String) -> Result<String, String> {
    offload(move || {
        check_hex(&hash)?;
        run(
            &repo,
            &["show", "--no-color", "--format=", "--end-of-options", &hash, "--", &path],
        )
    })
    .await
}

/// 逐行归属（blame）。rev 为空 = blame 工作区内容；带 rev（如 `<hash>^`）= blame 指定版本。
/// 解析 --porcelain 输出：sha 只在首次出现的块里带 author/author-time 元信息，需按 sha 缓存
#[derive(Serialize)]
pub struct BlameLine {
    line: u32,    // 该版本文件中的行号（1-based）
    hash: String, // 最后修改该行的提交
    author: String,
    time: i64, // author-time（epoch 秒）
}

#[tauri::command]
pub async fn git_blame(repo: String, rev: Option<String>, path: String) -> Result<Vec<BlameLine>, String> {
    offload(move || {
        let mut args = vec!["blame", "--porcelain"];
        // blame 不支持 --end-of-options 与 -- 同时出现（实测报 fatal: bad revision '<path>'），
        // 所以 rev 走严格校验，path 继续靠 -- 兜底
        if let Some(r) = rev.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            check_positional("提交版本", r)?;
            args.push(r);
        }
        args.push("--");
        args.push(&path);
        let out = run(&repo, &args)?;
        let mut lines = Vec::new();
        let mut meta: std::collections::HashMap<String, (String, i64)> =
            std::collections::HashMap::new();
        let mut cur: Option<(String, u32)> = None; // (sha, 该块末行号 final-line)
        for l in out.lines() {
            if l.starts_with('\t') {
                // 内容行 = 一个归属块的结束
                if let Some((sha, line)) = cur.take() {
                    let m = meta.get(&sha).cloned().unwrap_or_default();
                    lines.push(BlameLine { line, hash: sha, author: m.0, time: m.1 });
                }
                continue;
            }
            let mut it = l.split_whitespace();
            let tok0 = it.next().unwrap_or("");
            if tok0.len() == 40 && tok0.chars().all(|c| c.is_ascii_hexdigit()) {
                // 块头：<sha> <orig-line> <final-line> [count]
                let _orig: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let final_line: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                cur = Some((tok0.to_string(), final_line));
            } else if let Some(sha) = cur.as_ref().map(|(s, _)| s.clone()) {
                match tok0 {
                    "author" => {
                        let e = meta.entry(sha).or_insert((String::new(), 0));
                        e.0 = l["author".len()..].trim().to_string();
                    }
                    "author-time" => {
                        let e = meta.entry(sha).or_insert((String::new(), 0));
                        e.1 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                    }
                    _ => {}
                }
            }
        }
        Ok(lines)
    })
    .await
}

/// 把文本写入指定路径（AI 报告/解释导出用；路径来自系统保存对话框）
#[tauri::command]
pub async fn git_write_file(path: String, content: String) -> Result<(), String> {
    offload(move || std::fs::write(&path, content).map_err(|e| format!("写入失败: {e}")))
    .await
}

// ---------- amend / 撤销提交 ----------

/// 追加到上次提交（amend）：message 非空时同时更新提交信息，否则保留原信息（--no-edit）。
/// 是否已推送的警告由前端确认框负责
#[tauri::command]
pub async fn git_amend(repo: String, message: Option<String>) -> Result<(), String> {
    offload(move || {
        let msg = message.as_deref().map(str::trim).unwrap_or("");
        // alias.commit=commit 防全局别名劫持（同 git_commit）
        let args: Vec<&str> = if msg.is_empty() {
            vec!["-c", "alias.commit=commit", "commit", "--amend", "--no-edit"]
        } else {
            vec!["-c", "alias.commit=commit", "commit", "--amend", "-m", msg]
        };
        run(&repo, &args).map(|_| ())
    })
    .await
}

/// 撤销最近一次提交：soft 重置到 HEAD~1，全部改动回到暂存区，工作区不动。
/// 根提交（仓库唯一提交）没有 HEAD~1，git 会报错，前端按提交数禁用按钮兜底
#[tauri::command]
pub async fn git_undo_commit(repo: String) -> Result<(), String> {
    offload(move || {
        run(
            &repo,
            &["-c", "alias.reset=reset", "reset", "--soft", "HEAD~1"],
        )
        .map(|_| ())
    })
    .await
}

// ---------- stash（暂存架） ----------

#[derive(Serialize)]
pub struct StashEntry {
    index: u32,      // stash@{N} 的 N
    hash: String,
    date: String,    // 相对日期（与历史区 --date=relative 风格一致）
    subject: String, // reflog 主题：WIP on <分支>: ... / On <分支>: 自定义备注
}

/// stash 列表（stash list 接受 log 的 --format）
#[tauri::command]
pub async fn git_stash_list(repo: String) -> Result<Vec<StashEntry>, String> {
    offload(move || {
        let out = run(
            &repo,
            &[
                "-c",
                "alias.stash=stash",
                "stash",
                "list",
                "--format=%gd%x1f%H%x1f%ar%x1f%gs",
            ],
        )?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                (f.len() == 4).then(|| StashEntry {
                    index: f[0]
                        .trim_start_matches("stash@{")
                        .trim_end_matches('}')
                        .parse()
                        .unwrap_or(0),
                    hash: f[1].into(),
                    date: f[2].into(),
                    subject: f[3].into(),
                })
            })
            .collect())
    })
    .await
}

/// 收纳当前改动到 stash（含暂存区与工作区）；include_untracked 时 -u 一并收未跟踪文件。
/// 没有改动时 git 仍以退出码 0 结束并输出 "No local changes to save"，这里转成明确报错
#[tauri::command]
pub async fn git_stash_push(
    repo: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<(), String> {
    offload(move || {
        let mut args = vec!["-c", "alias.stash=stash", "stash", "push"];
        if include_untracked {
            args.push("-u");
        }
        let msg = message.as_deref().map(str::trim).unwrap_or("");
        if !msg.is_empty() {
            args.push("-m");
            args.push(msg);
        }
        let out = run(&repo, &args)?;
        if out.contains("No local changes to save") {
            return Err("没有可收纳的改动：暂存区和工作区都是干净的".into());
        }
        Ok(())
    })
    .await
}

/// 恢复 stash：pop=true 恢复并删除记录（发生冲突时 git 会自动保留记录）；
/// pop=false 仅恢复（apply），记录始终保留
#[tauri::command]
pub async fn git_stash_apply(repo: String, index: u32, pop: bool) -> Result<(), String> {
    offload(move || {
        let sub = if pop { "pop" } else { "apply" };
        run(
            &repo,
            &[
                "-c",
                "alias.stash=stash",
                "stash",
                sub,
                &format!("stash@{{{}}}", index),
            ],
        )
        .map(|_| ())
    })
    .await
}

/// 删除一条 stash 记录（不恢复内容，记录丢弃后不可找回）
#[tauri::command]
pub async fn git_stash_drop(repo: String, index: u32) -> Result<(), String> {
    offload(move || {
        run(
            &repo,
            &[
                "-c",
                "alias.stash=stash",
                "stash",
                "drop",
                &format!("stash@{{{}}}", index),
            ],
        )
        .map(|_| ())
    })
    .await
}

// ---------- tag ----------

#[derive(Serialize)]
pub struct TagEntry {
    name: String,
    annotated: bool, // 附注标签（-a，带独立 message）
    target: String,  // 指向的 commit 全 hash（附注标签取解引用后的提交）
    date: String,    // 相对日期
    message: String, // 附注信息；轻量标签为空串
}

/// tag 列表：for-each-ref，附注标签用 *objectname 解引用到真实提交。
/// 注意 for-each-ref 的 format 不支持 %x1f 转义（会原样输出），用真实 tab 分隔——
/// ref 名不允许控制字符、contents:subject 恒为单行，tab 不会撞内容
#[tauri::command]
pub async fn git_tag_list(repo: String) -> Result<Vec<TagEntry>, String> {
    offload(move || {
        let out = run(
            &repo,
            &[
                "for-each-ref",
                "refs/tags",
                "--format=%(refname:short)\t%(objecttype)\t%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)\t%(creatordate:relative)\t%(contents:subject)",
            ],
        )?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                (f.len() == 5).then(|| TagEntry {
                    name: f[0].into(),
                    annotated: f[1] == "tag",
                    target: f[2].into(),
                    date: f[3].into(),
                    message: if f[1] == "tag" { f[4].into() } else { String::new() },
                })
            })
            .collect())
    })
    .await
}

/// 新建 tag：message 非空 = 附注标签（-a -m），否则轻量标签；target 为空时打在当前 HEAD
#[tauri::command]
pub async fn git_tag_create(
    repo: String,
    name: String,
    message: Option<String>,
    target: Option<String>,
) -> Result<(), String> {
    offload(move || {
        let name = name.trim();
        // 以 - 开头会被当成 git 选项，提前拦下；其余合法性（重名等）交给 git 校验
        check_positional("标签名", name)?;
        if name.contains(char::is_whitespace) {
            return Err("标签名不能包含空格".into());
        }
        let mut args: Vec<String> = vec!["-c".into(), "alias.tag=tag".into(), "tag".into()];
        let msg = message.as_deref().map(str::trim).unwrap_or("");
        if !msg.is_empty() {
            args.push("-a".into());
            args.push(name.into());
            args.push("-m".into());
            args.push(msg.into());
        } else {
            args.push(name.into());
        }
        let t = target.as_deref().map(str::trim).unwrap_or("");
        if !t.is_empty() {
            if !t.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err("非法的 commit hash".into());
            }
            args.push(t.into());
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run(&repo, &arg_refs).map(|_| ())
    })
    .await
}

/// 删除本地 tag（远程同名 tag 不受影响，需在终端 push origin :refs/tags/<name>）
#[tauri::command]
pub async fn git_tag_delete(repo: String, name: String) -> Result<(), String> {
    offload(move || {
        let name = name.trim();
        check_positional("标签名", name)?;
        run(&repo, &["-c", "alias.tag=tag", "tag", "-d", "--end-of-options", name]).map(|_| ())
    })
    .await
}

/// 推送单个 tag 到 origin
#[tauri::command]
pub async fn git_tag_push(repo: String, name: String) -> Result<(), String> {
    offload(move || {
        let name = name.trim();
        check_positional("标签名", name)?;
        // remote 之后接 --end-of-options，refspec 只在它之后解析（实测 2.47）
        run(&repo, &["push", "origin", "--end-of-options", name]).map(|_| ())
    })
    .await
}

/// 克隆远程仓库到本地（dest 为完整目标路径，须不存在或为空目录）。
/// cwd 用 dest 的父目录；url 前加 `--` 防止以 - 开头的地址被当成选项。
/// 认证走系统 credential helper（GIT_TERMINAL_PROMPT=0 只是禁掉终端交互输密码）
#[tauri::command]
pub async fn git_clone(url: String, dest: String) -> Result<(), String> {
    offload(move || {
        let url = url.trim();
        let dest = dest.trim();
        if url.is_empty() || dest.is_empty() {
            return Err("远程地址和目标路径不能为空".into());
        }
        let parent = std::path::Path::new(dest)
            .parent()
            .and_then(|p| p.to_str())
            .ok_or_else(|| "目标路径不合法".to_string())?;
        if parent.is_empty() || !std::path::Path::new(parent).is_dir() {
            return Err(format!("目标父目录不存在: {parent}"));
        }
        run(parent, &["clone", "--", url, dest]).map(|_| ())
    })
    .await
}

// ---------- M10：.gitignore / cherry-pick / Release Notes 数据 ----------

/// 把路径追加进仓库根 .gitignore（整行已存在则跳过；文件不存在则创建）
#[tauri::command]
pub async fn git_ignore_add(repo: String, path: String) -> Result<(), String> {
    offload(move || {
        let p = path.trim();
        if p.is_empty() {
            return Err("路径不能为空".into());
        }
        let f = std::path::Path::new(&repo).join(".gitignore");
        // 读不到就当成空文件来追加；但**读取失败≠文件不存在**：非 UTF-8（中文 Windows 上
        // GBK 编码很常见）会让 read_to_string 报错，之前用 unwrap_or_default 把它吞成空串，
        // 紧接着写回就把整份 .gitignore 清空了。这里只对 NotFound 放行，其余一律中止。
        let mut content = match std::fs::read_to_string(&f) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(_) => {
                return Err(
                    "现有 .gitignore 不是 UTF-8 编码，为避免覆盖其内容已中止（请先转为 UTF-8）"
                        .into(),
                )
            }
        };
        if content.lines().any(|l| l.trim() == p) {
            return Ok(());
        }
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(p);
        content.push('\n');
        std::fs::write(&f, content).map_err(|e| format!("写入 .gitignore 失败: {e}"))
    })
    .await
}

/// cherry-pick 单个提交到当前分支；空拣选/冲突交给 humanize
#[tauri::command]
pub async fn git_cherry_pick(repo: String, hash: String) -> Result<(), String> {
    offload(move || {
        check_hex(&hash)?;
        run(
            &repo,
            &[
                "-c",
                "alias.cherry-pick=cherry-pick",
                "cherry-pick",
                hash.trim(),
            ],
        )
        .map(|_| ())
    })
    .await
}

#[derive(Serialize)]
pub struct CommitBrief {
    hash: String,   // 短 hash
    author: String,
    date: String,   // YYYY-MM-DD
    subject: String,
}

/// Release Notes 数据：from..to 区间内的提交清单（from 空 = 全部可达提交；to 空 = HEAD）。
/// from 允许 tag 名（如 v1.0），只拦 - 开头防选项注入，其余交给 git 校验
#[tauri::command]
pub async fn git_commits_range(
    repo: String,
    from: String,
    to: Option<String>,
) -> Result<Vec<CommitBrief>, String> {
    offload(move || {
        let from = from.trim();
        let to = to.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("HEAD");
        if from.starts_with('-') || to.starts_with('-') {
            return Err("非法的提交范围".into());
        }
        let range = if from.is_empty() {
            to.to_string()
        } else {
            format!("{from}..{to}")
        };
        let out = run(
            &repo,
            &["log", &range, "--pretty=%h%x1f%an%x1f%ad%x1f%s", "--date=short"],
        )?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                (f.len() == 4).then(|| CommitBrief {
                    hash: f[0].into(),
                    author: f[1].into(),
                    date: f[2].into(),
                    subject: f[3].into(),
                })
            })
            .collect())
    })
    .await
}

/// HEAD 可达的最近 tag（git describe --tags --abbrev=0）；无 tag 返回空串。
/// Release Notes 的默认对比起点
#[tauri::command]
pub async fn git_latest_tag(repo: String) -> Result<String, String> {
    offload(move || {
        Ok(run(&repo, &["describe", "--tags", "--abbrev=0"])
            .unwrap_or_default()
            .trim()
            .to_string())
    })
    .await
}

/// 判断路径是否是 git 仓库（拖拽文件夹进窗口打开时校验）
#[tauri::command]
pub async fn git_check_repo(path: String) -> Result<bool, String> {
    offload(move || {
        Ok(run(&path, &["rev-parse", "--is-inside-work-tree"])
            .map(|o| o.trim() == "true")
            .unwrap_or(false))
    })
    .await
}

/// 在 path 下执行 git init。path 本身还不是仓库，所以只能靠 current_dir 定位，
/// run() 的 repo 参数正好就是 cwd。已存在仓库时 git init 是幂等的（会重新初始化）。
#[tauri::command]
pub async fn git_init(path: String) -> Result<(), String> {
    offload(move || {
        let path = path.trim();
        if path.is_empty() {
            return Err("目录不能为空".into());
        }
        if !std::path::Path::new(path).is_dir() {
            return Err(format!("目录不存在: {path}"));
        }
        run(path, &["init"]).map(|_| ())
    })
    .await
}

// ---------- 后悔药与多步操作（M19） ----------

#[derive(Serialize)]
pub struct ReflogEntry {
    hash: String,
    /// `HEAD@{3}` 这类选择器。它跟 `stash@{n}` 一样是**按位置编号**的，列表一变同一编号就
    /// 指向另一条记录 —— 所以「回到这一步」永远回传 hash，不回传 selector
    selector: String,
    /// git 自己记的动作摘要，如 `commit: 修复 x` / `reset: moving to HEAD~1`
    action: String,
    date: String,
}

/// reflog：当前 HEAD 最近 200 次位置变动。
///
/// 应用里 6 个破坏性出口都有确认框，但确认框只防「点错」，防不了「点对了想错了」。
/// 这是那一层缺失的兜底。
#[tauri::command]
pub async fn git_reflog(repo: String) -> Result<Vec<ReflogEntry>, String> {
    offload(move || {
        let out = match run(
            &repo,
            &[
                "reflog",
                "--date=relative",
                "--no-color",
                "-n",
                "200",
                "--pretty=format:%H%x1f%gd%x1f%gs%x1f%ad",
            ],
        ) {
            Ok(o) => o,
            // 空仓库还没有 reflog，不算错误
            Err(e) if e.contains("does not have any commits yet") => return Ok(vec![]),
            Err(e) => return Err(e),
        };
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                (f.len() == 4).then(|| ReflogEntry {
                    hash: f[0].into(),
                    selector: f[1].into(),
                    action: f[2].into(),
                    date: f[3].into(),
                })
            })
            .collect())
    })
    .await
}

/// 回到某个提交。mode = `hard`（工作区一起回到那一刻，会丢未提交改动）或
/// `soft`（只挪 HEAD，改动全部留在暂存区）。
#[tauri::command]
pub async fn git_reset_to(repo: String, hash: String, mode: Option<String>) -> Result<(), String> {
    offload(move || {
        check_hex(&hash)?;
        let hard = !matches!(mode.as_deref(), Some("soft"));
        let flag = if hard { "--hard" } else { "--soft" };
        run(
            &repo,
            &["-c", "alias.reset=reset", "reset", flag, hash.trim()],
        )
        .map(|_| ())
    })
    .await
}

/// 检测进行中的多步操作。
///
/// 用 `rev-parse --absolute-git-dir` 再拼文件名，而不是直接拼 `repo/.git/MERGE_HEAD`：
/// worktree、子目录、GIT_DIR 重定向下前者才是对的。用绝对路径则是因为子进程的 cwd
/// 是仓库根，而我们自己进程的 cwd 不是 —— 相对路径的 exists() 会判到别处去。
fn detect_op(repo: &str) -> Result<Option<String>, String> {
    let git_dir = run(repo, &["rev-parse", "--absolute-git-dir"])?;
    let dir = std::path::Path::new(git_dir.trim());
    for (name, probe) in [
        ("merge", "MERGE_HEAD"),
        ("cherry-pick", "CHERRY_PICK_HEAD"),
        ("revert", "REVERT_HEAD"),
        ("rebase", "rebase-merge"),
    ] {
        if dir.join(probe).exists() {
            return Ok(Some(name.to_string()));
        }
    }
    Ok(None)
}

#[derive(Serialize)]
pub struct OpState {
    /// "" = 没有进行中的操作；否则 merge / cherry-pick / revert / rebase
    operation: String,
    /// 仍未解决的冲突文件（`--diff-filter=U`）
    conflicts: Vec<String>,
}

/// 合并/拣选/变基的状态：冲突没解决完时，前端要能告诉用户「下一步做什么」，
/// 而不是只给一个「放弃合并」。
#[tauri::command]
pub async fn git_op_state(repo: String) -> Result<OpState, String> {
    offload(move || {
        let operation = detect_op(&repo)?.unwrap_or_default();
        if operation.is_empty() {
            return Ok(OpState {
                operation,
                conflicts: vec![],
            });
        }
        let conflicts = run(&repo, &["diff", "--name-only", "--diff-filter=U"])?
            .lines()
            .map(String::from)
            .collect();
        Ok(OpState {
            operation,
            conflicts,
        })
    })
    .await
}

/// 继续完成 merge / cherry-pick / revert。
///
/// 必须带 `-c core.editor=true`：`--continue` 会打开编辑器让人确认提交信息，而 GUI 里
/// 没有终端，编辑器起不来就会永远卡在「操作进行中」——那正是「把用户踢出应用」的老毛病。
#[tauri::command]
pub async fn git_op_continue(repo: String) -> Result<(), String> {
    offload(move || {
        let op = detect_op(&repo)?;
        let editor = ["-c", "core.editor=true"];
        match op.as_deref() {
            Some("merge") => run(&repo, &[editor[0], editor[1], "merge", "--continue"]),
            Some("cherry-pick") => {
                run(&repo, &[editor[0], editor[1], "cherry-pick", "--continue"])
            }
            Some("revert") => run(&repo, &[editor[0], editor[1], "revert", "--continue"]),
            Some(other) => Err(format!("当前是 {other} 状态，请在终端里完成")),
            None => Err("当前没有进行中的合并或拣选".into()),
        }
        .map(|_| ())
    })
    .await
}

/// 把最近 count 个提交压成一条：soft reset 到 HEAD~count 再重新提交。
///
/// 这是 interactive rebase 的**替代品**，不是它的完整实现：只覆盖「最近几条整理成一条」
/// 这个 80% 的场景，但不动 reflog 以外的东西，风险低一个量级。
///
/// 抽成同步函数是为了能直接被单测调用（command 那层只有 offload，没有逻辑）。
fn squash_recent_impl(repo: &str, count: u32, message: &str) -> Result<(), String> {
    if count < 2 {
        return Err("至少要合并 2 个提交".into());
    }
    let msg = message.trim();
    if msg.is_empty() {
        return Err("提交信息不能为空".into());
    }
    let target = format!("HEAD~{count}");
    // 先验目标存在再动手：soft reset 已经改了 HEAD，才发现越界就晚了。
    // 边界是「根提交不能一起压」—— 它没有父提交可以回退，这不是 bug 而是刻意不做的部分
    run(repo, &["rev-parse", "--verify", "--quiet", &target]).map_err(|_| {
        format!("当前分支的提交不足 {count} 个（最早的提交不能一起压）")
    })?;
    run(repo, &["-c", "alias.reset=reset", "reset", "--soft", &target])?;
    run(repo, &["-c", "alias.commit=commit", "commit", "-m", msg]).map(|_| ())
}

#[tauri::command]
pub async fn git_squash_recent(
    repo: String,
    count: u32,
    message: String,
) -> Result<(), String> {
    offload(move || squash_recent_impl(&repo, count, &message)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// 临时仓库，Drop 时自清理。
    struct TempRepo(std::path::PathBuf);

    impl TempRepo {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("gz-test-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let p = dir.to_str().unwrap().to_string();
            run(&p, &["init", "-q"]).unwrap();
            run(&p, &["config", "user.email", "t@t"]).unwrap();
            run(&p, &["config", "user.name", "t"]).unwrap();
            TempRepo(dir)
        }

        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // ---------- 纯函数 ----------

    #[test]
    fn check_repo_path_rejects_escapes() {
        for bad in [
            "", "   ", "../x", "..\\x", "/abs/path", "a/../../x", "a\\..\\..\\x", "..",
        ] {
            assert!(
                check_repo_path(bad).is_err(),
                "应当拒绝越界路径: {bad:?}"
            );
        }
        // 控制字符
        assert!(check_repo_path("a\u{0}b").is_err());
        assert!(check_repo_path("a\nb").is_err());
    }

    #[test]
    fn check_repo_path_allows_normal_paths() {
        // `a..b.txt` 是合法文件名：按路径组件判断才不会误杀（这正是它不复用
        // check_positional 的原因，后者按子串拒绝 ".."）
        for ok in [
            "src/App.vue",
            "a..b.txt",
            "dir/file with space.txt",
            "中文目录/文件.txt",
            "src-tauri/src/git.rs",
        ] {
            assert!(check_repo_path(ok).is_ok(), "不应拒绝正常路径: {ok:?}");
        }
    }

    #[test]
    fn check_positional_rejects_option_like_names() {
        for bad in ["", "-f", "--mirror", "a..b", "a\nb"] {
            assert!(check_positional("分支名", bad).is_err(), "应当拒绝: {bad:?}");
        }
        for ok in ["feature/x", "中文分支", "release-1.0"] {
            assert!(check_positional("分支名", ok).is_ok(), "不应拒绝: {ok:?}");
        }
    }

    #[test]
    fn check_hex_rejects_empty_but_allows_abbrev() {
        // 空串是原本的漏洞：`"".chars().all(is_ascii_hexdigit)` 恒为 true
        assert!(check_hex("").is_err());
        assert!(check_hex("zzz").is_err());
        // git 允许缩写 hash，别把短 hash 误杀
        assert!(check_hex("abc123").is_ok());
        assert!(check_hex("ABC123").is_ok());
    }

    #[test]
    fn is_network_classifies_transfer_commands() {
        assert!(is_network(&["push"]));
        assert!(is_network(&["push", "-u", "origin", "main"]));
        assert!(is_network(&["clone", "--", "u", "d"]));
        assert!(is_network(&["fetch", "--all"]));
        assert!(is_network(&["pull", "--no-edit"]));
        // 前置参数不影响判断
        assert!(is_network(&["-c", "core.quotepath=false", "fetch"]));

        assert!(!is_network(&["status", "--porcelain=v1", "-b"]));
        assert!(!is_network(&["log", "-1"]));
        assert!(!is_network(&["checkout", "main"]));
    }

    // ---------- 超时与管道 ----------

    /// 回归测试：输出远超管道缓冲区（约 64KB）时必须完整读回、不能死锁。
    /// 如果实现是「先 wait 再读管道」，子进程写满缓冲区后会阻塞在写、我们阻塞在读，
    /// 这个测试会挂住——所以放进线程用 recv_timeout 兜底，让它**失败**而不是**卡死**。
    #[test]
    fn run_reads_large_output_without_deadlock() {
        let repo = TempRepo::new("bigout");
        // 300KB 的文本，确保超过管道缓冲区
        let big = "x".repeat(300 * 1024);
        std::fs::write(repo.0.join("big.txt"), &big).unwrap();
        run(repo.path(), &["add", "big.txt"]).unwrap();
        run(repo.path(), &["commit", "-q", "-m", "big"]).unwrap();

        let (tx, rx) = mpsc::channel();
        let p = repo.path().to_string();
        std::thread::spawn(move || {
            let _ = tx.send(run(&p, &["show", "HEAD:big.txt"]));
        });
        let out = rx
            .recv_timeout(Duration::from_secs(60))
            .expect("读取大输出时死锁了（管道未并发读）")
            .expect("git show 应当成功");
        assert_eq!(out.trim().len(), big.len(), "大输出被截断了");
    }

    /// 超时必须真的杀掉子进程，而不是只是「不再等」。
    #[test]
    fn output_with_timeout_kills_hung_process() {
        #[cfg(windows)]
        let cmd = {
            let mut c = Command::new("cmd");
            // ping 用来稳定地睡 ~30 秒（timeout 命令在有管道时会被拒）
            c.args(["/C", "ping", "-n", "30", "127.0.0.1"]);
            c
        };
        #[cfg(not(windows))]
        let cmd = {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };

        let start = Instant::now();
        let err = output_with_timeout(cmd, Duration::from_secs(1)).unwrap_err();
        let elapsed = start.elapsed();

        assert!(err.contains("超时"), "错误信息应说明超时，实际: {err}");
        // 若只是「不再等待」而没杀进程，这里仍会很快返回，所以要额外确认进程真的没了
        assert!(
            elapsed < Duration::from_secs(15),
            "超时未生效，等了 {elapsed:?}"
        );
    }

    /// 超时后不留僵尸进程：能立刻再跑一次正常命令。
    #[test]
    fn git_still_usable_after_timeout() {
        let repo = TempRepo::new("afterkill");        #[cfg(windows)]
        let cmd = {
            let mut c = Command::new("cmd");
            c.args(["/C", "ping", "-n", "30", "127.0.0.1"]);
            c
        };
        #[cfg(not(windows))]
        let cmd = {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        let _ = output_with_timeout(cmd, Duration::from_secs(1));
        assert!(run(repo.path(), &["status", "--porcelain"]).is_ok());
    }

    /// 失败时 stdout 要能回落：commit 无内容、merge 冲突的诊断都只写在 stdout。
    #[test]
    fn run_falls_back_to_stdout_on_failure() {
        let repo = TempRepo::new("stdoutfb");
        // 没有任何改动就 commit → exit=1，信息在 stdout（stderr 为空）
        let err = run(repo.path(), &["commit", "-m", "x"]).unwrap_err();
        assert!(
            !err.trim().is_empty(),
            "失败时不应返回空错误（否则前端弹空白框）"
        );
        assert!(
            err.contains("nothing to commit") || err.contains("nothing added"),
            "应回落取到 stdout 的诊断，实际: {err}"
        );
    }

    /// 子进程退出后，即使管道因孙进程而**永不 EOF**，已产生的输出也必须能拿到。
    /// 若实现是「read_to_end 读完再发一次」，这里会一个字都收不到。
    #[test]
    fn partial_output_survives_when_pipe_never_eofs() {
        #[cfg(windows)]
        let cmd = {
            let mut c = Command::new("cmd");
            // 先 echo，再用 start /B 起一个继承句柄的长命孙进程，然后父进程立刻退出
            c.args([
                "/C",
                "echo hello-partial & start /B cmd /C ping -n 30 127.0.0.1 >nul",
            ]);
            c
        };
        #[cfg(not(windows))]
        let cmd = {
            let mut c = Command::new("sh");
            c.args(["-c", "echo hello-partial; sleep 30 &"]);
            c
        };

        let out = output_with_timeout(cmd, Duration::from_secs(30)).expect("父进程正常退出");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            text.contains("hello-partial"),
            "孙进程持有管道时丢了已产生的输出，实际: {text:?}"
        );
    }

    /// 预览必须有读取上限：原来用 std::fs::read 整个读进来，几个 GB 的未跟踪文件会打满内存。
    #[test]
    fn read_preview_caps_bytes_read() {
        let repo = TempRepo::new("preview");
        let big = repo.0.join("big.txt");
        // 5 MiB，超过 1 MiB 的上限；内容全 'a' 便于断言
        std::fs::write(&big, vec![b'a'; 5 * 1024 * 1024]).unwrap();

        let got = read_preview(&big).unwrap();
        assert_eq!(
            got.len() as u64,
            MAX_PREVIEW,
            "应只读上限内的字节，实际读了 {}",
            got.len()
        );

        // 小文件要完整读到，不能被上限截断
        let small = repo.0.join("small.txt");
        std::fs::write(&small, b"hello").unwrap();
        assert_eq!(read_preview(&small).unwrap(), b"hello");
    }

    /// git_get_user 必须区分「没配过」与「真失败」：前者返回空串，后者要把错误抛出来。
    /// 原来两边都用 unwrap_or_default()，仓库打不开时设置页只显示两个空框。
    #[test]
    fn git_get_user_distinguishes_unset_from_failure() {
        // 仓库有效且配过：读到真实值
        let repo = TempRepo::new("getuser");
        let (n, e) = tauri::async_runtime::block_on(git_get_user(repo.path().to_string()))
            .expect("正常仓库应成功");
        assert_eq!((n.as_str(), e.as_str()), ("t", "t@t"));

        // 清掉配置：应返回空串而不是报错
        run(repo.path(), &["config", "--unset", "user.name"]).unwrap();
        // 同时屏蔽全局配置，避免开发机自己的 user.name 干扰
        let empty_cfg = repo.0.join("no-such-global-config");
        let saved = std::env::var("GIT_CONFIG_GLOBAL").ok();
        std::env::set_var("GIT_CONFIG_GLOBAL", &empty_cfg);
        let (n2, _) = tauri::async_runtime::block_on(git_get_user(repo.path().to_string()))
            .expect("未配置不应报错");
        match saved {
            Some(v) => std::env::set_var("GIT_CONFIG_GLOBAL", v),
            None => std::env::remove_var("GIT_CONFIG_GLOBAL"),
        }
        assert_eq!(n2, "", "未配置时应为空串，实际: {n2:?}");

        // 目录不存在（真失败）：必须报错，不能吞成空串
        let missing = repo.0.join("does-not-exist");
        let err = tauri::async_runtime::block_on(git_get_user(
            missing.to_str().unwrap().to_string(),
        ))
        .expect_err("无效目录应报错");
        assert!(!err.trim().is_empty(), "错误信息不应为空");
    }

    // ---------- 丢弃暂存区全部改动 ----------

    fn write_file(repo: &TempRepo, p: &str, c: &str) {
        let full = repo.0.join(p);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(&full, c).unwrap();
    }

    fn read_file(repo: &TempRepo, p: &str) -> Option<String> {
        std::fs::read_to_string(repo.0.join(p)).ok()
    }

    fn commit_files(repo: &TempRepo, files: &[(&str, &str)], msg: &str) {
        for (p, c) in files {
            write_file(repo, p, c);
        }
        run(repo.path(), &["add", "-A"]).unwrap();
        run(repo.path(), &["commit", "-q", "-m", msg]).unwrap();
    }

    /// 当前分支名（git init 的默认分支名随版本/配置而变，不能写死 master）
    fn branch_name(repo: &TempRepo) -> String {
        run(repo.path(), &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap()
            .trim()
            .to_string()
    }

    fn porcelain(repo: &TempRepo) -> String {
        run(repo.path(), &["status", "--porcelain=v1"]).unwrap()
    }

    fn discard(repo: &TempRepo, paths: &[&str], delete_new: bool) -> Result<(), String> {
        let v: Vec<String> = paths.iter().map(|s| s.to_string()).collect();
        tauri::async_runtime::block_on(git_discard_staged(repo.path().to_string(), v, delete_new))
    }

    /// 修改 / 暂存区删除 / 重命名 / 新增四类一起丢弃，工作区应当完全干净。
    /// 重命名行**同时给旧名和新名**是这里要守住的关键：只给新名会留下 `D old.txt`。
    #[test]
    fn discard_staged_restores_every_kind_of_change() {
        let repo = TempRepo::new("dstaged");
        commit_files(
            &repo,
            &[
                ("mod.txt", "M0"),
                ("del.txt", "D0"),
                ("old.txt", "R0"),
                ("keep.txt", "K0"),
            ],
            "init",
        );

        write_file(&repo, "mod.txt", "M1");
        std::fs::remove_file(repo.0.join("del.txt")).unwrap();
        std::fs::rename(repo.0.join("old.txt"), repo.0.join("new.txt")).unwrap();
        write_file(&repo, "added.txt", "A1");
        run(repo.path(), &["add", "-A"]).unwrap();

        discard(
            &repo,
            &["mod.txt", "del.txt", "old.txt", "new.txt", "added.txt"],
            true,
        )
        .expect("丢弃应当成功");

        assert_eq!(read_file(&repo, "mod.txt").as_deref(), Some("M0"), "修改应还原");
        assert_eq!(read_file(&repo, "del.txt").as_deref(), Some("D0"), "删除应还原");
        assert_eq!(
            read_file(&repo, "old.txt").as_deref(),
            Some("R0"),
            "重命名的旧名应还原"
        );
        assert!(!repo.0.join("new.txt").exists(), "重命名的新名应消失");
        assert!(!repo.0.join("added.txt").exists(), "delete_new=true 时新增文件应删除");
        assert_eq!(read_file(&repo, "keep.txt").as_deref(), Some("K0"), "未传的路径不该动");
        let st = porcelain(&repo);
        assert_eq!(st.trim(), "", "工作区应完全干净，实际: {st:?}");
    }

    /// delete_new=false 时新增文件只取消暂存、留在磁盘上变成未跟踪。
    /// 这是默认行为：新增文件往往是从未提交过的工作成果，删掉不可恢复。
    #[test]
    fn discard_staged_keeps_new_files_when_not_deleting() {
        let repo = TempRepo::new("dkeep");
        commit_files(&repo, &[("mod.txt", "M0")], "init");
        write_file(&repo, "mod.txt", "M1");
        write_file(&repo, "added.txt", "A1");
        run(repo.path(), &["add", "-A"]).unwrap();

        discard(&repo, &["mod.txt", "added.txt"], false).expect("丢弃应当成功");

        assert_eq!(read_file(&repo, "mod.txt").as_deref(), Some("M0"), "修改应还原");
        assert_eq!(
            read_file(&repo, "added.txt").as_deref(),
            Some("A1"),
            "新增文件应保留在磁盘上"
        );
        let st = porcelain(&repo);
        assert!(st.contains("?? added.txt"), "应变成未跟踪，实际: {st:?}");
    }

    /// 未跟踪文件不在暂存区、前端不会传给这个命令，所以必须原封不动。
    #[test]
    fn discard_staged_leaves_untracked_files_alone() {
        let repo = TempRepo::new("duntracked");
        commit_files(&repo, &[("mod.txt", "M0")], "init");
        write_file(&repo, "mod.txt", "M1");
        write_file(&repo, "loose.txt", "L1");
        run(repo.path(), &["add", "mod.txt"]).unwrap();

        discard(&repo, &["mod.txt"], true).expect("丢弃应当成功");

        assert_eq!(read_file(&repo, "mod.txt").as_deref(), Some("M0"));
        assert_eq!(
            read_file(&repo, "loose.txt").as_deref(),
            Some("L1"),
            "未跟踪文件不该被动"
        );
    }

    /// 空仓库（还没有 HEAD）时全部路径都当「不在 HEAD 里」。
    /// 这里不能靠 ls-tree 失败兜底 —— 那会把「仓库损坏」也当成「都没提交过」而误删文件。
    #[test]
    fn discard_staged_works_in_repo_without_head() {
        let repo = TempRepo::new("dempty");
        write_file(&repo, "a.txt", "A1");
        run(repo.path(), &["add", "a.txt"]).unwrap();

        discard(&repo, &["a.txt"], false).expect("空仓库也应当能丢弃暂存");

        assert_eq!(read_file(&repo, "a.txt").as_deref(), Some("A1"), "文件应保留");
        assert!(porcelain(&repo).contains("?? a.txt"), "应变成未跟踪");
    }

    /// 路径必须限制在仓库内：不能让前端传来的路径去动仓库外的文件。
    #[test]
    fn discard_staged_rejects_paths_outside_repo() {
        let repo = TempRepo::new("descape");
        commit_files(&repo, &[("a.txt", "A0")], "init");
        let err = discard(&repo, &["../outside.txt"], true).unwrap_err();
        assert!(err.contains("非法路径"), "应拒绝越界路径，实际: {err:?}");
        // 空列表是合法的空操作，不该报错
        discard(&repo, &[], true).expect("空列表应当直接返回");
    }

    /// 合并冲突（UU，文件在 HEAD 里）时不能炸：应当按 HEAD 的版本解决。
    #[test]
    fn discard_staged_resolves_uu_conflict_to_head() {
        let repo = TempRepo::new("dcuu");
        commit_files(&repo, &[("c.txt", "base")], "base");
        let base = branch_name(&repo);

        run(repo.path(), &["checkout", "-q", "-b", "side"]).unwrap();
        commit_files(&repo, &[("c.txt", "from-side")], "side");
        run(repo.path(), &["checkout", "-q", &base]).unwrap();
        commit_files(&repo, &[("c.txt", "from-base")], "base2");

        run(repo.path(), &["merge", "--no-edit", "side"]).expect_err("应当冲突");
        assert!(porcelain(&repo).contains("UU c.txt"), "应当处于 UU 冲突态");

        discard(&repo, &["c.txt"], true).expect("冲突文件也应当能丢弃");

        assert_eq!(
            read_file(&repo, "c.txt").as_deref(),
            Some("from-base"),
            "应按 HEAD 版本解决"
        );
        let st = porcelain(&repo);
        assert!(!st.contains("UU"), "冲突状态应被清除，实际: {st:?}");
    }

    /// 合并冲突 AA（两边都新增同名文件）。**AA 的路径其实在 HEAD 里** —— HEAD 就是其中
    /// 一边，所以它走的是 `checkout HEAD` 分支，应当还原成 HEAD 版本。
    #[test]
    fn discard_staged_resolves_aa_conflict() {
        let repo = TempRepo::new("dcaa");
        commit_files(&repo, &[("keep.txt", "K0")], "base");
        let base = branch_name(&repo);

        run(repo.path(), &["checkout", "-q", "-b", "side"]).unwrap();
        commit_files(&repo, &[("n.txt", "from-side")], "side-adds");
        run(repo.path(), &["checkout", "-q", &base]).unwrap();
        commit_files(&repo, &[("n.txt", "from-base")], "base-adds");

        run(repo.path(), &["merge", "--no-edit", "side"]).expect_err("应当冲突");
        assert!(porcelain(&repo).contains("AA n.txt"), "应当处于 AA 冲突态");

        discard(&repo, &["n.txt"], true).expect("AA 冲突文件也应当能丢弃");

        assert_eq!(
            read_file(&repo, "n.txt").as_deref(),
            Some("from-base"),
            "应按 HEAD 版本解决"
        );
        let st = porcelain(&repo);
        assert!(!st.contains("AA"), "冲突状态应被清除，实际: {st:?}");
    }

    /// 合并冲突 DU（我方删除、对方修改）：这个路径**不在 HEAD 里**，
    /// 是唯一会走到 `git rm` 分支的冲突形态 —— 也是最容易被漏掉的一条路径。
    #[test]
    fn discard_staged_resolves_du_conflict() {
        let repo = TempRepo::new("dcdu");
        commit_files(&repo, &[("c.txt", "base")], "base");
        let base = branch_name(&repo);

        run(repo.path(), &["checkout", "-q", "-b", "side"]).unwrap();
        commit_files(&repo, &[("c.txt", "from-side")], "side-modifies");
        run(repo.path(), &["checkout", "-q", &base]).unwrap();
        std::fs::remove_file(repo.0.join("c.txt")).unwrap();
        run(repo.path(), &["add", "-A"]).unwrap();
        run(repo.path(), &["commit", "-q", "-m", "base-deletes"]).unwrap();

        run(repo.path(), &["merge", "--no-edit", "side"]).expect_err("应当冲突");
        assert!(porcelain(&repo).contains("DU c.txt"), "应当处于 DU 冲突态");

        discard(&repo, &["c.txt"], true).expect("DU 冲突文件也应当能丢弃");

        assert!(
            !repo.0.join("c.txt").exists(),
            "HEAD 里已经删掉这个文件，丢弃后也应当不存在"
        );
        let st = porcelain(&repo);
        assert!(!st.contains("DU"), "冲突状态应被清除，实际: {st:?}");
    }

    /// 用户报的 bug（「合并冲突时不弹提示、界面不更新，要手动点刷新」）的后端前提：
    /// **git_merge 报错，但仓库状态确实变了** —— 冲突文件已经躺在索引里。
    ///
    /// 把这两件事钉在一起，是为了说明前端「失败就不刷新」的假设错在哪：
    /// 只要「命令返回 Err」与「状态已改变」同时成立，界面就会停在合并前的快照上，
    /// 冲突横幅（ChangesPanel 的 conflictFiles）和冲突文件都不会出现。
    #[test]
    fn merge_conflict_fails_but_state_changes() {
        let repo = TempRepo::new("mconf");
        commit_files(&repo, &[("c.txt", "base")], "base");
        let base = branch_name(&repo);

        run(repo.path(), &["checkout", "-q", "-b", "side"]).unwrap();
        commit_files(&repo, &[("c.txt", "from-side")], "side");
        run(repo.path(), &["checkout", "-q", &base]).unwrap();
        commit_files(&repo, &[("c.txt", "from-base")], "base2");

        let before = tauri::async_runtime::block_on(git_status(repo.path().to_string())).unwrap();
        assert!(before.files.is_empty(), "合并前工作区应当干净");

        let err =
            tauri::async_runtime::block_on(git_merge(repo.path().to_string(), "side".to_string()))
                .expect_err("冲突时 git_merge 返回 Err —— 前端 run() 因此走 catch 分支");
        assert!(!err.trim().is_empty(), "冲突时不能弹空白错误框");

        // 关键：状态确实变了。前端若不刷新，这一整块信息用户都看不到
        let after = tauri::async_runtime::block_on(git_status(repo.path().to_string())).unwrap();
        let conflicts: Vec<&str> = after
            .files
            .iter()
            .filter(|f| {
                f.x == 'U' || f.y == 'U' || (f.x == 'A' && f.y == 'A') || (f.x == 'D' && f.y == 'D')
            })
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(
            conflicts,
            vec!["c.txt"],
            "冲突文件应当出现在 status 里（前端靠它显示冲突横幅）"
        );
    }

    // ---------- M19：后悔药与多步操作 ----------

    #[test]
    fn reflog_and_reset_to_step_back() {
        let repo = TempRepo::new("reflog");
        commit_files(&repo, &[("a.txt", "1")], "one");
        commit_files(&repo, &[("a.txt", "2")], "two");

        let entries = tauri::async_runtime::block_on(git_reflog(repo.path().to_string())).unwrap();
        assert!(entries.len() >= 2, "两次提交后 reflog 至少两条");
        assert_eq!(entries[0].action, "commit: two", "reflog 最新一条在最前");
        assert_eq!(entries[1].action, "commit (initial): one");

        // 回到「那一刻」：工作区也一起回去
        tauri::async_runtime::block_on(git_reset_to(
            repo.path().to_string(),
            entries[1].hash.clone(),
            Some("hard".into()),
        ))
        .unwrap();
        assert_eq!(
            run(repo.path(), &["log", "--pretty=format:%s"]).unwrap().trim(),
            "one"
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("a.txt")).unwrap().trim(),
            "1",
            "hard 重置后工作区内容也回到那一刻"
        );

        // 非法 hash 在进 git 之前就该被挡住
        assert!(tauri::async_runtime::block_on(git_reset_to(
            repo.path().to_string(),
            "-f".into(),
            None
        ))
        .is_err());
    }

    #[test]
    fn op_state_tracks_merge_until_continue() {
        let repo = TempRepo::new("opstate");
        commit_files(&repo, &[("c.txt", "base")], "base");
        let base = branch_name(&repo);
        run(repo.path(), &["checkout", "-q", "-b", "side"]).unwrap();
        commit_files(&repo, &[("c.txt", "side")], "side");
        run(repo.path(), &["checkout", "-q", &base]).unwrap();
        commit_files(&repo, &[("c.txt", "main")], "main");
        let _ = tauri::async_runtime::block_on(git_merge(
            repo.path().to_string(),
            "side".to_string(),
        ));

        let st = tauri::async_runtime::block_on(git_op_state(repo.path().to_string())).unwrap();
        assert_eq!(st.operation, "merge", "冲突后应处于 merge 状态");
        assert_eq!(st.conflicts, vec!["c.txt"], "未解决冲突要能列出来");

        // 冲突没解决完就 continue 必须失败 —— 不能静默「成功」把用户骗过去
        assert!(
            tauri::async_runtime::block_on(git_op_continue(repo.path().to_string())).is_err(),
            "冲突未解决时 --continue 应当报错"
        );

        std::fs::write(repo.0.join("c.txt"), "merged").unwrap();
        run(repo.path(), &["add", "c.txt"]).unwrap();
        let solved = tauri::async_runtime::block_on(git_op_state(repo.path().to_string())).unwrap();
        assert!(
            solved.conflicts.is_empty(),
            "全部标记已解决后冲突列表应为空（前端据此把按钮点亮）"
        );

        // core.editor=true 是关键：没有它这里会挂起等编辑器
        tauri::async_runtime::block_on(git_op_continue(repo.path().to_string())).unwrap();
        let after = tauri::async_runtime::block_on(git_op_state(repo.path().to_string())).unwrap();
        assert_eq!(after.operation, "", "完成后不应再有进行中的操作");
        assert!(run(repo.path(), &["log", "-1", "--pretty=format:%s"])
            .unwrap()
            .contains("side"));
    }

    #[test]
    fn squash_recent_keeps_content_and_guards() {
        let repo = TempRepo::new("squash");
        commit_files(&repo, &[("base.txt", "0")], "base");
        commit_files(&repo, &[("a.txt", "1")], "one");
        commit_files(&repo, &[("b.txt", "2")], "two");
        commit_files(&repo, &[("c.txt", "3")], "three");

        squash_recent_impl(repo.path(), 3, "all in one").unwrap();
        // 4 条压掉后 3 条 → 2 条（根提交留着，它没有父可回退）
        assert_eq!(
            run(repo.path(), &["rev-list", "--count", "HEAD"]).unwrap().trim(),
            "2"
        );
        assert_eq!(
            run(repo.path(), &["log", "-1", "--pretty=format:%s"]).unwrap().trim(),
            "all in one"
        );
        // soft reset 不动工作区：三个文件一个都不能少
        for f in ["a.txt", "b.txt", "c.txt"] {
            assert!(repo.0.join(f).exists(), "压成一条后 {f} 应当还在");
        }

        // 守卫：数量太少 / 提交不足 / 空提交信息，且失败时不能已经动了 HEAD
        assert!(squash_recent_impl(repo.path(), 1, "x").is_err());
        assert!(squash_recent_impl(repo.path(), 5, "x").is_err());
        assert!(squash_recent_impl(repo.path(), 2, "   ").is_err());
        assert_eq!(
            run(repo.path(), &["rev-list", "--count", "HEAD"]).unwrap().trim(),
            "2",
            "被守卫拦下时 HEAD 必须原封不动"
        );
    }
}

