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

/// 读取仓库内某个文本文件的工作区内容。只服务于「给 AI 喂仓库约定文档」（CONTRIBUTING 等）：
/// 路径必须落在仓库内、有大小上限、二进制直接当不存在。
///
/// 返回 `Option`：文件不存在是**正常情况**（多数仓库没有 CONTRIBUTING.md），
/// 不该让调用方把它当错误处理；真正的读取失败（权限、编码）才返回 Err。
#[tauri::command]
pub async fn git_read_repo_file(
    repo: String,
    path: String,
    max_bytes: Option<usize>,
) -> Result<Option<String>, String> {
    offload(move || {
        check_repo_path(&path)?;
        let limit = max_bytes.unwrap_or(16_384).clamp(256, 65_536);
        let full = std::path::Path::new(&repo).join(&path);
        let meta = match std::fs::metadata(&full) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("读取 {path} 失败：{e}")),
        };
        if !meta.is_file() {
            return Ok(None);
        }
        let bytes = std::fs::read(&full).map_err(|e| format!("读取 {path} 失败：{e}"))?;
        Ok(text_prefix(&bytes, limit))
    })
    .await
}

/// 取字节前 `limit` 个字节当作文本：二进制（含 NUL）返回 None，
/// 截断点落在多字节字符中间时最多回退 3 字节找 UTF-8 边界（否则末尾多一个 U+FFFD），
/// 文件本身不是 UTF-8 时退回 lossy。
fn text_prefix(bytes: &[u8], limit: usize) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    let mut end = bytes.len().min(limit);
    let floor = end.saturating_sub(3);
    while end > floor && std::str::from_utf8(&bytes[..end]).is_err() {
        end -= 1;
    }
    Some(String::from_utf8_lossy(&bytes[..end]).into_owned())
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

#[derive(Serialize)]
#[derive(Debug)]
pub struct ResetCleanReport {
    /// 被丢弃的已跟踪改动条目数（工作区 + 暂存区，重命名算一条）
    discarded: u32,
    /// 被删掉的未跟踪条目数（-uall，一个文件算一条）
    removed: u32,
    /// 顺手放弃掉的多步操作（merge / cherry-pick / revert / rebase），没有就是 None
    aborted: Option<String>,
    /// 因「未提交的 .gitignore 是忽略规则的来源」而被主动保留的数量
    kept_ignores: u32,
    /// 重置后仍然存在的条目数：嵌套仓库（`clean` 不带 `-ff` 不动它）、被删掉 `.gitignore`
    /// 后由「忽略」变「未跟踪」的目录、超长路径等。>0 时说明「已重置但不完全干净」，
    /// 不能对用户报「都是干净的」。
    leftover: u32,
    /// 非致命提示（例如 clean 因文件被占用没能整轮跑完）。有值就说明「重置了但不完美」，
    /// 上层直接展示原文即可。
    note: Option<String>,
}

/// 把工作区恢复到「刚 clone 下来」的干净状态：放弃进行中的合并/拣选/撤销/变基，
/// 已跟踪文件全部回到 HEAD，再删掉未跟踪文件与目录。
///
/// **刻意不带 `-x`**：`.gitignore` 忽略的（node_modules / target / dist）不动 ——
/// 删了要重装重编，那不叫「代码脏」。
/// 空仓库没有 HEAD，`reset --hard` 会报 ambiguous argument，所以先探一下，改清空索引。
#[tauri::command]
pub async fn git_reset_clean(repo: String) -> Result<ResetCleanReport, String> {
    offload(move || {
        // 一律在仓库根上执行：仓库可能以子目录身份打开（用户选中了 `repo/sub`），
        // 而 `clean` 的生效范围跟着 cwd 走 —— 在 sub/ 里跑只会清 sub/，
        // 根上的未跟踪文件永远清不掉，看起来就是「怎么点都不干净」。
        let root = run(&repo, &["rev-parse", "--show-toplevel"])
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| repo.clone());

        // 空仓库没有 HEAD：`reset --hard` 会报 ambiguous argument。
        // 清空索引后这些文件变成未跟踪，交给后面的 clean 收走 —— 否则它们留在索引里、
        // 文件也还在，报告却说「丢弃了 N 个改动」，是骗人的。
        let has_head = run(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok();
        if !has_head {
            run(&root, &["read-tree", "--empty"])?;
        }

        // 先数一遍：重置之后就数不出来了。用 status 自己数，不解析 `clean -n` 的英文文案
        // （git 本地化一改，`Would remove` 就匹配不上，计数会静默变 0）。
        // `-uall` 不能省：`status.showUntrackedFiles=no` 时默认输出为空，会出现
        // 「文件被删光了、提示却说工作区本来就是干净的」。
        let before = run(&root, &["status", "--porcelain=v1", "-uall"])?;
        let (discarded, untracked_before) = count_pending(&root, &before);

        // 退出进行中的多步操作。**abort 被 git 拒绝不算致命**：索引与工作区不一致时
        // （冲突已 add 之后又改动该文件）abort 会拒绝执行，而紧随其后的 reset --hard
        // 照样能把 MERGE_HEAD 清掉 —— 所以失败先记下，reset 之后再重试一次。
        let mut aborted: Option<String> = None;
        let mut abort_err = String::new();
        if let Some(op) = detect_op(&root)? {
            aborted = Some(display_op(&root, &op));
            if let Err(e) = run(&root, &abort_args(&root, &op)?) {
                abort_err = e;
            }
        }

        // clean 必须排在 reset **之前**：`reset --hard` 会把 `.gitignore` 还原成 HEAD 版本，
        // 用户本地新加的忽略规则会在那一刻失效，随后 clean 就把它本来在保护的目录删掉 ——
        // 而确认框承诺的正是「被 .gitignore 忽略的文件保持不动」。
        // clean 只认**工作区**的 .gitignore。用户若刚把 .gitignore 删掉、或删掉其中
        // `node_modules/` 那一行，这些目录在 clean 眼里就是「未跟踪」，会连 node_modules /
        // dist / target 一起删 —— 而确认框承诺的正是「被忽略的文件不动」。所以把 HEAD 版本的
        // 规则也并进 `-e`：两套规则同时生效，宁可多留（留给 leftover 报出来）也不能多删。
        // **clean 必须保住 .gitignore 本身**：未提交的 `.gitignore` 在 clean 眼里也是未跟踪文件。
        // 第一轮它还能替 node_modules 挡一下（工作区规则当时还在），但文件被删掉后规则就没了，
        // 用户看到 leftover 提示再点第二次时，node_modules / dist 会连根删掉。
        //（真实事故路径，见 docs/BUGS.md）
        let (mut head_ignores, truncated) = head_ignore_patterns(&root);
        // 用户把 core.excludesFile 指向仓库内的相对文件时，那个文件本身也得保住：
        // `clean` 先删掉它，下一轮就一条全局规则都不剩了。
        let kept_excludes = configured_excludes_in_repo(&root);
        if let Some(rel) = kept_excludes.as_deref() {
            head_ignores.push(format!("/{rel}"));
        }
        let mut notes: Vec<String> = Vec::new();
        if truncated {
            notes.push("忽略规则太多，超出上限的部分没有参与保护".to_string());
        }
        let excludes = write_excludes(&root, &head_ignores)?;
        let mut clean_args: Vec<String> = Vec::new();
        if let Some(tmp) = &excludes {
            let path = tmp
                .0
                .as_ref()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            clean_args.push("-c".to_string());
            clean_args.push(format!("core.excludesFile={path}"));
        }
        clean_args.extend(["clean", "-fd", "-e", ".gitignore"].map(str::to_string));
        let clean_refs: Vec<&str> = clean_args.iter().map(String::as_str).collect();
        // clean 可能因为文件被占用（Windows 开了就别想删）整体失败。它失败就整个中止的话，
        // 用户点一次什么都没变；而降级继续 reset 后，残留会在最后被 leftover 如实数出来。
        let clean_err = run(&root, &clean_refs).err();

        // 「删掉了几个」= 清理前后未跟踪条目之差。直接数清理前的状态会把嵌套仓库这类
        // clean 跳过的条目也算成「已删除」，和 leftover 重复报同一件事。
        let removed = untracked_before.saturating_sub(
            run(&root, &["status", "--porcelain=v1", "-uall"])?
                .lines()
                .filter(|l| l.starts_with("??"))
                .count() as u32,
        );

        if has_head {
            run(&root, &["-c", "alias.reset=reset", "reset", "--hard", "HEAD"])?;
        }

        // 重试：此时索引已经等于 HEAD，之前被「not uptodate」拒掉的 abort 通常就能跑了。
        // 少了这一步，`git am` + `MM` 这种组合会「改动已销毁、报错、状态还卡着」，得点第二次。
        if detect_op(&root)?.is_some() {
            if let Some(op) = detect_op(&root)? {
                aborted = Some(display_op(&root, &op));
                if let Err(e) = run(&root, &abort_args(&root, &op)?) {
                    if abort_err.is_empty() {
                        abort_err = e;
                    }
                }
            }
        }

        let mut sub_removed = 0u32;
        // 子模块：顶层 `reset --hard` 与 `clean` 都不进 submodule，不清的话顶层永远显示 ` M sub`。
        // 子模块内部要单独走一遍，而且**同样先 clean 再 reset**、同样要带上它自己 HEAD 版本的
        // 忽略规则 —— 否则子模块的 .gitignore 被删/改窄时，它的 node_modules、target 会被删掉，
        // 而顶层 leftover 还是 0，前端一句都不提。
        let mut sub_kept_ignores = 0u32;
        for sub in submodule_paths(&root) {
            let sub_dir = format!("{}/{}", root.trim_end_matches('/'), sub);
            // 未初始化（deinit）的子模块里 `-C sub` 只是个空目录，后续 rev-parse/status 会
            // 向上落到父仓库上：既会误报「指针漂移」，`clean` 也会跑在父仓库上下文里。
            if !std::path::Path::new(&sub_dir).join(".git").exists() {
                continue;
            }
            let (sub_ignores, sub_truncated) = head_ignore_patterns(&sub_dir);
            if sub_truncated {
                notes.push(format!(
                    "子模块 {sub} 的忽略规则超过上限，超出部分没有参与保护"
                ));
            }
            let sub_excludes = write_excludes(&sub_dir, &sub_ignores).map_err(|err| {                format!("父仓库已清理完成，但子模块 {sub} 未能清理：{err}")            })?;
            let mut sub_args: Vec<String> = Vec::new();
            if let Some(tmp) = &sub_excludes {
                let path = tmp
                    .0
                    .as_ref()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                sub_args.push("-c".to_string());
                sub_args.push(format!("core.excludesFile={path}"));
            }
            sub_args.extend(["clean", "-fdq", "-e", ".gitignore"].map(str::to_string));
            let sub_refs: Vec<&str> = sub_args.iter().map(String::as_str).collect();
            // 子模块内部的未跟踪文件不在父仓库的 status 里，不单独数就会「删了但不计入 removed」
            let count_sub_untracked = |dir: &str| -> u32 {
                run(dir, &["status", "--porcelain", "-uall"])
                    .map(|o| o.lines().filter(|l| l.starts_with("?? ")).count() as u32)
                    .unwrap_or(0)
            };
            let sub_untracked_before = count_sub_untracked(&sub_dir);
            // 尽力而为：一个子模块失败不该拦住别的，最后由 leftover 如实报告
            let _ = run(&sub_dir, &sub_refs);
            let _ = run(&sub_dir, &["reset", "--hard", "-q", "HEAD"]);
            sub_removed += sub_untracked_before.saturating_sub(count_sub_untracked(&sub_dir));
            if let Ok(st) = run(&sub_dir, &["status", "--porcelain", "-uall"]) {
                sub_kept_ignores += count_kept_ignores(&st);
            }
            // 子模块停在别的提交时，清干净工作区也还是显示 ` M sub`：指针要对齐 gitlink 才行，
            // 而 `submodule update --force` 会销毁子模块里的本地提交，不能替用户决定。
            // 这里只负责把「不一致」说清楚，别让 toast 笼统归咎于「嵌套仓库、子模块等」。
            if let Some((cur, want)) = submodule_drift(&root, &sub) {
                notes.push(format!(
                    "子模块 {sub} 停在 {}，与父仓库记录的 {} 不一致，需手动对齐",
                    &cur[..cur.len().min(7)],
                    &want[..want.len().min(7)],
                ));
            }
        }

        // 复查：中间态没能退出去就别假装成功（`reset --hard` 清不掉 rebase-apply 这类目录）
        if let Some(op) = detect_op(&root)? {
            let hint = if abort_err.is_empty() {
                String::new()
            } else {
                format!("：{abort_err}")
            };
            let shown = display_op(&root, &op);
            return Err(format!(
                "无法退出 {shown} 状态{hint}。已跟踪的改动已被重置，请手动处理后再试"
            ));
        }

        // 现状复查：`clean -fd` 删不掉嵌套仓库（要 `-ff`，但那会把用户自己的 clone 也删了），
        // 也不保证删得掉长路径/被锁的文件。数出来如实报告，不要谎报「干净」。
        let removed = removed + sub_removed;
        if sub_kept_ignores > 0 {
            notes.push(format!(
                "子模块里保留了 {sub_kept_ignores} 个未提交的 .gitignore（忽略规则的来源，不能删）"
            ));
        }
        let after = run(&root, &["status", "--porcelain=v1", "-uall"])?;
        // `-e .gitignore` 保留下来的那个未提交 `.gitignore` 本身也是未跟踪文件，会一直出现在
        // status 里。它不算「没清干净的残留」（是我们主动留的），否则每次点击都报「仍有 1 项」，
        // 还把原因错归给嵌套仓库/子模块。
        let kept_ignores = count_kept_ignores(&after);
        // 已跟踪的 .gitignore 本地被改「宽」时，它保护的目录这一轮保得住（工作区规则还在），
        // 但 `reset --hard` 会把规则还原掉：用户照 leftover 提示再点一次，那些目录就会被
        // 真删掉 —— 而确认框承诺「被忽略的文件保持不动」。必须提前说清楚。
        // 必须看 reset 之前的 status：reset --hard 会把 .gitignore 还原成 HEAD 的样子，
        // 之后再看就永远干净，提示永远出不来。
        let ignore_touched = before.lines().any(|l| {
            let path = l.get(3..).unwrap_or("").trim().trim_matches('"');
            (l.starts_with(" M") || l.starts_with("M ") || l.starts_with("MM"))
                && (path == ".gitignore" || path.ends_with("/.gitignore"))
        });
        // 被我们主动保下来的仓库内全局忽略文件也不算残留（它出现在 status 里只是因为没删）。
        let kept_excludes_left = match kept_excludes.as_deref() {
            Some(rel) => after
                .lines()
                .filter(|l| l.get(3..).unwrap_or("").trim().trim_matches('"') == rel)
                .count() as u32,
            None => 0,
        };
        let leftover = (after.lines().count() as u32)
            .saturating_sub(kept_ignores)
            .saturating_sub(kept_excludes_left);
        if kept_ignores > 0 {
            notes.push(format!(
                "保留了 {kept_ignores} 个未提交的 .gitignore（忽略规则的来源，不能删）"
            ));
        }
        if let Some(rel) = kept_excludes.as_deref().filter(|_| kept_excludes_left > 0) {
            notes.push(format!(
                "仓库内的全局忽略文件 {rel} 已保留（它是忽略规则的来源，不能删）"
            ));
        }
        if ignore_touched {
            notes.push(
                ".gitignore 有未提交改动：本次新增的忽略规则会随重置丢弃，它保护的目录建议先提交再重置"
                    .to_string(),
            );
        }

        if let Some(e) = clean_err {
            notes.push(format!("有文件清不掉（可能被占用）：{e}"));
        }
        Ok(ResetCleanReport {
            discarded,
            removed,
            aborted,
            kept_ignores,
            leftover,
            note: if notes.is_empty() {
                None
            } else {
                Some(notes.join("；"))
            },
        })
    })
    .await
}

/// 临时 excludes 文件：`clean` 期间挂在 `core.excludesFile` 上，用完就删。
struct TempExcludes(Option<std::path::PathBuf>);

impl Drop for TempExcludes {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 把规则写成临时 excludes 文件，返回的守卫一 drop 就删。
///
/// 为什么不再用 `clean -e <rule>`：`-e` 的优先级高于 `.gitignore` 里的 `!取反`，而且每条规则
/// 占两个 argv，400 条长规则能直接超过 Windows 的 32767 上限（`os error 206`，clean 根本没跑）。
/// 写进 excludes 文件后两件事一起解决，且 remains 是 git 自己的匹配器在处理。
fn write_excludes(repo: &str, rules: &[String]) -> Result<Option<TempExcludes>, String> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut lines: Vec<String> = Vec::new();
    // 用户全局规则优先级最低，原样垫在最前面，避免被我们遮蔽后多删文件。
    // `-c core.excludesFile` 是**整体覆盖**该配置，所以没配的时候必须回退到 git 的默认路径，
    // 否则 `~/.config/git/ignore` 里的规则会静默失效 —— 那些被它忽略的文件会被删掉，
    // 而且报告里一个字都不会提。
    if let Some(body) = read_global_excludes(repo)? {
        lines.extend(body.lines().map(|l| l.to_string()));
    }
    lines.extend(rules.iter().cloned());
    if lines.is_empty() {
        return Ok(None);
    }
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut path = std::env::temp_dir();
    path.push(format!("git-zen-ignore-{}-{n}.tmp", std::process::id()));
    let mut body = lines.join("
");
    body.push('\n');
    std::fs::write(&path, body)
        .map_err(|e| format!("无法写入临时忽略规则文件 {}（{e}）", path.display()))?;
    Ok(Some(TempExcludes(Some(path))))
}

/// 读用户全局忽略规则（`core.excludesFile`，没配就用 git 的默认路径）。
///
/// 三件事必须一起做，少一件就会静默多删文件：
/// 1. `--path`：让 git 自己展开 `~/gi` 与相对路径（直接读 `~` 在 Windows 上必失败）；
/// 2. 没配时回退 `$XDG_CONFIG_HOME/git/ignore` 或 `~/.config/git/ignore`（git 的默认值）；
/// 3. 读不出来就**报错中止**，不能当成「没有规则」——宁可这次不清理，也不能删掉用户忽略的文件。
fn read_global_excludes(repo: &str) -> Result<Option<String>, String> {
    let configured = run(repo, &["config", "--path", "--get", "core.excludesFile"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let path = match configured {
        Some(p) => {
            let pb = std::path::PathBuf::from(&p);
            if pb.is_absolute() {
                pb
            } else if let Some(full) = relative_to_root(repo, &p) {
                full
            } else {
                // git 把相对的 core.excludesFile 解析成「相对 git 进程 cwd」，而我们是
                // `-C <仓库根>`；`std::fs::read_to_string` 用的却是**应用进程**的 cwd
                //（GUI 下是 exe 所在目录），直接读必然 NotFound —— 用户规则被当成
                //「没有规则」，被他忽略的文件会被静默删掉。
                let top = run(repo, &["rev-parse", "--show-toplevel"])
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|_| repo.trim().to_string());
                std::path::Path::new(&top).join(pb)
            }
        }
        None => match default_global_ignore() {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    match std::fs::read_to_string(&path) {
        Ok(body) => Ok(Some(body)),
        // 没配/配了但文件不存在：git 眼里就是没有规则，与默认行为一致
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!(
            "读不到全局忽略规则 {}（{err}），为避免误删被忽略的文件，本次未执行"
        , path.display())),
    }
}

/// 把相对的 `core.excludesFile` 落到仓库根上（git 的基准是它自己的 cwd，即仓库根）。
fn relative_to_root(repo: &str, rel: &str) -> Option<std::path::PathBuf> {
    let top = run(repo, &["rev-parse", "--show-toplevel"]).ok()?;
    let top = top.trim().to_string();
    if top.is_empty() {
        return None;
    }
    Some(std::path::Path::new(&top).join(rel))
}

/// 配置的全局忽略文件落在仓库里时，返回其在仓库内的相对路径（posix 分隔）。
fn configured_excludes_in_repo(root: &str) -> Option<String> {
    let configured = run(root, &["config", "--path", "--get", "core.excludesFile"]).ok()?;
    let configured = configured.trim();
    if configured.is_empty() {
        return None;
    }
    let path = std::path::PathBuf::from(configured);
    let full = if path.is_absolute() {
        path
    } else {
        std::path::Path::new(root).join(path)
    };
    let rel = full.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    if rel.is_empty() || rel.starts_with("..") {
        return None;
    }
    Some(rel)
}

fn default_global_ignore() -> Option<std::path::PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Some(std::path::PathBuf::from(xdg).join("git").join("ignore"));
        }
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    if home.is_empty() {
        return None;
    }
    Some(
        std::path::PathBuf::from(home)
            .join(".config")
            .join("git")
            .join("ignore"),
    )
}

/// 取 HEAD 里所有 `.gitignore` 的规则，转成 `clean` 可用的模式（仓库根相对）。
/// 只会让 clean 少删，不会多删：多留的东西最终由 `leftover` 如实报出来。
/// 子目录里的 `.gitignore` 规则是相对它自己那个目录的，这里补上目录前缀做近似。
/// 列出全部子模块路径（含嵌套），相对仓库根。
fn submodule_paths(repo: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Ok(list) = run(repo, &["submodule", "status", "--recursive"]) else {
        return out;
    };
    for line in list.lines() {
        // 每行形如 ` <sha> <path> (<describe>)`，行首可能带 `-`（未初始化）/`+`/`U`。
        // 路径可能含空格（`my lib`），所以只能在 sha 后面整体切，不能按空白分词。
        let rest = line.trim_start_matches([' ', '-', '+', 'U']);
        let Some((_sha, tail)) = rest.split_once(' ') else {
            continue;
        };
        let path = match tail.rfind(" (") {
            Some(k) if tail.ends_with(')') => &tail[..k],
            _ => tail,
        };
        if !path.trim().is_empty() {
            out.push(path.trim().to_string());
        }
    }
    out
}

fn head_ignore_patterns(repo: &str) -> (Vec<String>, bool) {
    // 规则数量上限只是健全性兜底（写的是临时 excludes 文件，不再受命令行长度限制）。
    // 超出的规则不参与保护，截断了要如实告诉用户。
    const MAX: usize = 400;
    let Ok(list) = run(repo, &["ls-tree", "-r", "--name-only", "-z", "HEAD"]) else {
        return (Vec::new(), false);
    };
    // 先按 (深度, 出现顺序) 收起来再排序：同一个 excludes 文件里「后匹配者胜」，
    // 而 `ls-tree -r` 是字典序 —— `.devcontainer/.gitignore` 会排在根 `.gitignore` 之前，
    // 于是根上的 `*.log` 压过了深层 `!keep.log` 的放行，那个文件永远清不掉。
    // git 的语义是「越深越优先」，所以必须按目录深度升序拼。
    let mut collected: Vec<(usize, String)> = Vec::new();
    for path in list.split('\u{0}') {
        if path.is_empty() {
            continue;
        }
        let file = path.rsplit('/').next().unwrap_or(path);
        if file != ".gitignore" {
            continue;
        }
        let dir = path.strip_suffix(file).unwrap_or("");
        let depth = dir.matches('/').count();
        let Ok(content) = run(repo, &["show", &format!("HEAD:{path}")]) else {
            continue;
        };
        for line in content.lines() {
            let raw = line.trim();
            if raw.is_empty() || raw.starts_with('#') {
                continue;
            }
            // `!keep.log` 是「显式放行」，必须一起带过去：只把 `*.log` 原样交给 clean 的话，
            // 被 `!` 放行的文件会被当成忽略文件保下来，而 `reset --hard` 又把 .gitignore 还原成
            // 带 `!` 的样子 —— 那个文件于是永远清不掉、leftover 恒为 1，用户点多少次都一样。
            let (negated, pat) = match raw.strip_prefix('!') {
                Some(rest) => (true, rest.trim()),
                None => (false, raw),
            };
            if pat.is_empty() {
                continue;
            }
            let joined = if dir.is_empty() {
                pat.to_string()
            } else {
                let anchored = pat.starts_with('/');
                let body = pat.trim_start_matches('/');
                // gitignore 里不含斜杠、也不以 `/` 开头的模式是「任意深度」语义；直接拼目录前缀
                // 会把它变成锚定模式，子目录更深处的同名目录就不受保护了
                //（monorepo 里 frontend/.gitignore 只写一条 node_modules/ 很常见）。
                // 反过来 `/out/` 本来就锚定在子目录根，扩成 `sub/**/out/` 会过度保护：
                // 深层同名目录被跳过、reset 后又还原回只锚定第一层的规则 —— 永远清不干净。
                if !anchored && !body.trim_end_matches('/').contains('/') {
                    format!("{dir}**/{body}")
                } else {
                    format!("{dir}{body}")
                }
            };
            let joined = if negated {
                format!("!{joined}")
            } else {
                joined
            };
            collected.push((depth, joined));
        }
    }
    // 稳定排序：同深度保持文件内原有顺序（规则之间也有先后）
    collected.sort_by_key(|(depth, _)| *depth);
    let mut out: Vec<String> = Vec::new();
    let mut truncated = false;
    for (_, joined) in collected {
        if out.contains(&joined) {
            continue;
        }
        if out.len() >= MAX {
            // 装满之后还有新规则 = 确实被截断了；刚好 400 条不算
            truncated = true;
        } else {
            out.push(joined);
        }
    }
    (out, truncated)
}

/// 数「因为 `-e .gitignore` 被主动保留下来」的未提交 `.gitignore`。
/// 只认 basename 恰为 `.gitignore` 的条目：`ends_with(".gitignore")` 会把被占用而没删掉的
/// `locked.gitignore` 也算成主动保留，真残留就被吞了（`-e` 本身就是按 basename 匹配的）。
fn count_kept_ignores(status: &str) -> u32 {
    status
        .lines()
        .filter(|line| {
            line.strip_prefix("?? ")
                .map(|path| {
                    let path = path.trim().trim_matches('"');
                    path == ".gitignore" || path.ends_with("/.gitignore")
                })
                .unwrap_or(false)
        })
        .count() as u32
}
/// 子模块当前 HEAD 与父仓库记录的 gitlink 是否一致；不一致时返回 (当前, 记录的)。
fn submodule_drift(root: &str, sub: &str) -> Option<(String, String)> {
    let cur = run(root, &["-C", sub, "rev-parse", "HEAD"]).ok()?;
    let tree = run(root, &["ls-tree", "HEAD", "--", sub]).ok()?;
    // 形如 `160000 commit <sha>\tsub`
    let want = tree
        .split_whitespace()
        .nth(2)
        .unwrap_or("")
        .trim()
        .to_string();
    if want.is_empty() || want == cur.trim() {
        return None;
    }
    Some((cur.trim().to_string(), want))
}

/// `git am` 底层复用的也是 rebase 的中间态，但对用户得说清楚是哪一种。
fn display_op(repo: &str, op: &str) -> String {
    if op == "rebase" {
        if let Ok(git_dir) = run(repo, &["rev-parse", "--absolute-git-dir"]) {
            if std::path::Path::new(git_dir.trim())
                .join("rebase-apply")
                .join("applying")
                .exists()
            {
                return "am".to_string();
            }
        }
    }
    op.to_string()
}

/// 数「会被丢弃的已跟踪改动」与「未跟踪条目」数量。
/// `-uall` 下列表一个文件一行，所以都是文件数（与确认框的口径一致）。
fn count_pending(repo: &str, porcelain: &str) -> (u32, u32) {
    let mut discarded = 0u32;
    let mut untracked = 0u32;
    for line in porcelain.lines() {
        if line.starts_with("??") {
            untracked += 1;
        } else if !line.starts_with("!!") {
            let path = line.get(3..).unwrap_or("").trim().trim_matches('"');
            // 子模块里只有未跟踪内容时，父仓库看到的是 ` M sub`，但子模块并没有「已跟踪的改动」
            // 会被丢弃（清掉的只是未跟踪文件）—— 计进 discarded 会让 toast 虚报。
            if is_submodule_clean_but_untracked(repo, path) {
                continue;
            }
            discarded += 1;
        }
    }
    (discarded, untracked)
}

/// 该路径是不是「工作区里没有已跟踪改动、只有未跟踪内容」的子模块。
fn is_submodule_clean_but_untracked(repo: &str, path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    let dir = format!("{}/{}", repo.trim_end_matches('/'), path);
    // 子模块的 .git 可能是文件（gitdir 指针），exists 对两种形态都成立
    if !std::path::Path::new(&dir).join(".git").exists() {
        return false;
    }
    // 父仓库里这条 gitlink 若已被暂存（`M  sub`），那是真改动、reset 会销毁它 —— 不能当
    // 「子模块只是工作区脏」。`--quiet` 有差异时返回非零，正是这里要的判据。
    if run(repo, &["diff", "--cached", "--quiet", "--", path]).is_err() {
        return false;
    }
    match run(&dir, &["status", "--porcelain", "-uno"]) {
        Ok(out) => out.trim().is_empty(),
        Err(_) => false,
    }
}

/// 退出某个多步操作该跑的命令。
fn abort_args(repo: &str, op: &str) -> Result<Vec<&'static str>, String> {
    Ok(match op {
        "merge" => vec!["merge", "--abort"],
        "cherry-pick" => vec!["cherry-pick", "--abort"],
        "revert" => vec!["revert", "--abort"],
        "rebase" => rebase_abort_args(repo)?,
        other => return Err(format!("当前是 {other} 状态，请在终端里处理")),
    })
}

/// 退出变基 / 拣选补丁该用哪条命令。
///
/// `rebase-apply` 这个目录被两套机制共用：`git rebase --apply` 与 `git am`。
/// 前者能 `rebase --abort`，后者只能 `am --abort` —— 实测对 am 跑 `rebase --abort`
/// 会报 `It looks like 'git am' is in progress. Cannot rebase.`。
/// 两者靠 `rebase-apply/applying` 区分（am 写它，rebase 不写）。
fn rebase_abort_args(repo: &str) -> Result<Vec<&'static str>, String> {
    let git_dir = run(repo, &["rev-parse", "--absolute-git-dir"])?;
    let dir = std::path::Path::new(git_dir.trim());
    Ok(if dir.join("rebase-apply").join("applying").exists() {
        vec!["am", "--abort"]
    } else {
        vec!["rebase", "--abort"]
    })
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
        // `rebase --apply` 与 `git am` 都用 rebase-apply，不探它就会漏掉这两种中间态
        ("rebase", "rebase-apply"),
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
    /// 给人看的名字：`git am` 与 rebase --apply 底层同为 rebase-apply，界面上不能混着说
    display: String,
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
                display: String::new(),
                conflicts: vec![],
            });
        }
        let display = display_op(&repo, &operation);
        let conflicts = run(&repo, &["diff", "--name-only", "--diff-filter=U"])?
            .lines()
            .map(String::from)
            .collect();
        Ok(OpState {
            operation,
            display,
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
    fn text_prefix_truncates_on_char_boundary() {
        // 「约定」= 6 字节，limit=4 正好切在第二个字中间
        let s = "约定文档";
        assert_eq!(text_prefix(s.as_bytes(), 4).unwrap(), "约");
        assert_eq!(text_prefix(s.as_bytes(), 6).unwrap(), "约定");
        // 未截断时原样返回
        assert_eq!(text_prefix(s.as_bytes(), 100).unwrap(), s);
        // ASCII 与空输入
        assert_eq!(text_prefix(b"abc", 2).unwrap(), "ab");
        assert_eq!(text_prefix(b"", 10).unwrap(), "");
    }

    #[test]
    fn text_prefix_rejects_binary_and_lossy_falls_back() {
        // 含 NUL → 视为二进制
        assert!(text_prefix(b"a\0b", 10).is_none());
        // 非 UTF-8（GBK 的「约」= 0xD4 0xBC）不 panic，走 lossy
        let out = text_prefix(&[0xD4, 0xBC, b'a'], 10).unwrap();
        assert!(out.ends_with('a'));
    }

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

    // ---------- 重置到干净状态 ----------

    fn reset_clean(repo: &TempRepo) -> Result<ResetCleanReport, String> {
        tauri::async_runtime::block_on(git_reset_clean(repo.path().to_string()))
    }

    /// 已跟踪改动（含暂存）全部丢弃、未跟踪的删掉，但 `.gitignore` 忽略的不动。
    /// 最后一条是这个功能最容易被做错的地方：带 `-x` 会把 node_modules / target 一起删，
    /// 那不是「代码脏」，是让人重装重编。
    #[test]
    fn reset_clean_discards_changes_and_untracked_but_keeps_ignored() {
        let repo = TempRepo::new("resetclean");
        commit_files(
            &repo,
            &[("kept.txt", "base"), (".gitignore", "node_modules/\n")],
            "base",
        );
        write_file(&repo, "kept.txt", "dirty");
        write_file(&repo, "staged.txt", "s");
        run(repo.path(), &["add", "staged.txt"]).unwrap();
        write_file(&repo, "loose.txt", "l");
        write_file(&repo, "sub/inner.txt", "i");
        write_file(&repo, "node_modules/pkg/i.js", "keep");

        let r = reset_clean(&repo).expect("重置应当成功");
        assert_eq!(r.discarded, 2, "kept.txt（工作区）+ staged.txt（暂存）");
        assert_eq!(r.removed, 2, "loose.txt + sub/ 目录各算一条");
        assert!(r.aborted.is_none(), "没有进行中的操作");

        assert_eq!(
            read_file(&repo, "kept.txt").as_deref(),
            Some("base"),
            "已跟踪改动应还原"
        );
        for gone in ["staged.txt", "loose.txt", "sub/inner.txt"] {
            assert!(!repo.0.join(gone).exists(), "{gone} 应被删除");
        }
        assert!(
            repo.0.join("node_modules/pkg/i.js").exists(),
            "被忽略的文件不该被删"
        );
        assert_eq!(porcelain(&repo).trim(), "", "重置后工作区应当干净");
        assert_eq!(r.leftover, 0, "干净就不该报告残留");
    }

    /// 嵌套的 git 仓库 `clean -fd` 删不掉（要 `-ff`，但那会把用户自己的 clone 一起删）。
    /// 这种「删不掉但也不报错」的情况必须如实报告，不能谎报「干净」。
    #[test]
    fn reset_clean_reports_leftover_for_nested_repo() {
        let repo = TempRepo::new("resetnested");
        commit_files(&repo, &[("kept.txt", "base")], "base");
        // 嵌套仓库用裸 run/写文件，不能建 TempRepo（它的 Drop 会删目录）
        let nested = repo.0.join("vendored");
        std::fs::create_dir_all(&nested).unwrap();
        let nested_path = nested.to_str().unwrap();
        run(nested_path, &["init", "-q"]).unwrap();
        run(nested_path, &["config", "user.email", "t@t"]).unwrap();
        run(nested_path, &["config", "user.name", "t"]).unwrap();
        std::fs::write(nested.join("inner.txt"), "i").unwrap();
        run(nested_path, &["add", "-A"]).unwrap();
        run(nested_path, &["commit", "-q", "-m", "nested"]).unwrap();
        write_file(&repo, "kept.txt", "dirty");

        let r = reset_clean(&repo).expect("有嵌套仓库时也应当成功");
        assert_eq!(r.discarded, 1);
        assert_eq!(r.removed, 0, "clean 删不掉嵌套仓库，就不该把它算成「已删除」");
        assert!(r.leftover > 0, "嵌套仓库应当被报成残留，而不是假装清干净了");
        assert!(
            repo.0.join("vendored/inner.txt").exists(),
            "刻意不删嵌套仓库（那可能是用户自己的 clone）"
        );
        assert_eq!(read_file(&repo, "kept.txt").as_deref(), Some("base"));
    }

    /// 子模块：`reset --hard` 与 `clean` 都不进 submodule，不清的话顶层永远显示 ` M sub`，
    /// 再点多少次都清不掉。
    #[test]
    fn reset_clean_resets_submodule_worktree() {
        let lib = TempRepo::new("resetsublib");
        commit_files(&lib, &[("lib.txt", "base")], "base");
        let repo = TempRepo::new("resetsub");
        commit_files(&repo, &[("kept.txt", "base")], "base");
        run(
            repo.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                lib.path(),
                "sub",
            ],
        )
        .unwrap();
        run(repo.path(), &["commit", "-q", "-m", "add sub"]).unwrap();

        // 弄脏子模块：改已跟踪文件 + 加未跟踪文件
        let sub = repo.0.join("sub");
        std::fs::write(sub.join("lib.txt"), "dirty-sub").unwrap();
        std::fs::write(sub.join("new.txt"), "n").unwrap();
        assert!(porcelain(&repo).contains("sub"), "顶层应当看到子模块变脏");

        let r = reset_clean(&repo).expect("有子模块也应当能重置");
        assert_eq!(r.leftover, 0, "子模块内部也要清干净");
        assert_eq!(
            std::fs::read_to_string(sub.join("lib.txt")).unwrap().trim(),
            "base",
            "子模块已跟踪文件应还原"
        );
        assert!(!sub.join("new.txt").exists(), "子模块内未跟踪文件应删除");
        assert_eq!(porcelain(&repo).trim(), "", "顶层不再显示脏");
    }

    /// 用户把 `.gitignore` 删掉（或删掉里面 `node_modules/` 那一行）时，这些目录在 clean 眼里
    /// 就是「未跟踪」—— 但确认框承诺「被 .gitignore 忽略的文件不动」。HEAD 版本的规则必须继续生效。
    #[test]
    fn reset_clean_keeps_libs_when_gitignore_rule_was_removed() {
        let repo = TempRepo::new("resetign2");
        commit_files(
            &repo,
            &[(".gitignore", "node_modules/\ndist/\n"), ("a.txt", "base")],
            "base",
        );
        std::fs::create_dir_all(repo.0.join("node_modules").join("x")).unwrap();
        std::fs::write(repo.0.join("node_modules").join("x").join("i.js"), "1").unwrap();
        std::fs::create_dir_all(repo.0.join("dist")).unwrap();
        std::fs::write(repo.0.join("dist").join("o.js"), "2").unwrap();
        // 把 .gitignore 从工作区删掉：此时两套规则只剩 HEAD 里那一份
        std::fs::remove_file(repo.0.join(".gitignore")).unwrap();
        write_file(&repo, "junk.txt", "j");

        let r = reset_clean(&repo).expect("应当能重置");
        assert!(
            repo.0.join("node_modules").join("x").join("i.js").exists(),
            "node_modules 不能被删（承诺忽略文件不动）"
        );
        assert!(repo.0.join("dist").join("o.js").exists(), "dist 不能被删");
        assert!(!repo.0.join("junk.txt").exists(), "真正未跟踪的仍要删");
        assert_eq!(r.removed, 1, "只应报告删掉 junk.txt");
        assert_eq!(r.leftover, 0, ".gitignore 已还原，规则重新对齐");
    }

    /// 子模块里也可能有本地新增的忽略规则：子模块内的 clean 必须同样排在 reset 之前，
    /// 否则 reset 先把子模块的 .gitignore 还原、clean 随即删掉它本来在保护的目录。
    #[test]
    fn reset_clean_keeps_submodule_dirs_ignored_locally() {
        let lib = TempRepo::new("resetsubign-lib");
        commit_files(&lib, &[("lib.txt", "base")], "base");
        let repo = TempRepo::new("resetsubign");
        commit_files(&repo, &[("kept.txt", "base")], "base");
        run(
            repo.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                lib.path(),
                "sub",
            ],
        )
        .unwrap();
        run(repo.path(), &["commit", "-q", "-m", "add sub"]).unwrap();

        let sub = repo.0.join("sub");
        // 子模块里本地新增忽略规则（未提交），再放一个受它保护的文件
        std::fs::write(sub.join(".gitignore"), "cache/\n").unwrap();
        std::fs::create_dir_all(sub.join("cache")).unwrap();
        std::fs::write(sub.join("cache").join("keep.bin"), "k").unwrap();

        let r = reset_clean(&repo).expect("有子模块也应当能重置");
        assert!(
            sub.join("cache").join("keep.bin").exists(),
            "子模块里被本地规则保护的目录不能被删"
        );
        // 子模块里那个被保留的未提交 .gitignore 让它依旧是脏的，父仓库显示 ` M sub` —— 如实报告
        assert_eq!(r.leftover, 1, "残留要如实报告");
    }

    /// cherry-pick 停在冲突里也要一次退出（`abort_args` 的这条映射此前没有回归保护）。
    #[test]
    fn reset_clean_aborts_pending_cherry_pick() {
        let repo = TempRepo::new("resetcripick");
        commit_files(&repo, &[("c.txt", "base")], "base");
        let base = branch_name(&repo);
        run(repo.path(), &["checkout", "-q", "-b", "side"]).unwrap();
        commit_files(&repo, &[("c.txt", "side")], "side");
        let side_hash = run(repo.path(), &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        run(repo.path(), &["checkout", "-q", &base]).unwrap();
        commit_files(&repo, &[("c.txt", "main")], "main");
        let _ = run(repo.path(), &["cherry-pick", &side_hash]);
        assert!(porcelain(&repo).contains("UU c.txt"), "应当处于拣选冲突态");

        let r = reset_clean(&repo).expect("拣选冲突也应当能重置");
        assert_eq!(r.aborted.as_deref(), Some("cherry-pick"));
        assert_eq!(read_file(&repo, "c.txt").as_deref(), Some("main"), "回到本分支 HEAD");
        assert_eq!(porcelain(&repo).trim(), "");
        let st = tauri::async_runtime::block_on(git_op_state(repo.path().to_string())).unwrap();
        assert_eq!(st.operation, "", "拣选的中间态应被清除");
    }

    /// revert 停在冲突里同样要一次退出。
    #[test]
    fn reset_clean_aborts_pending_revert() {
        let repo = TempRepo::new("resetrevert");
        commit_files(&repo, &[("a.txt", "1")], "one");
        let first = run(repo.path(), &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        commit_files(&repo, &[("a.txt", "2")], "two");
        // 再改一次，让 first 那次的内容被覆盖 —— 只有这样 revert 才会冲突
        commit_files(&repo, &[("a.txt", "3")], "three");
        let _ = run(repo.path(), &["revert", "--no-edit", &first]);
        assert_eq!(
            tauri::async_runtime::block_on(git_op_state(repo.path().to_string()))
                .unwrap()
                .operation,
            "revert",
            "应当停在撤销冲突态"
        );

        let r = reset_clean(&repo).expect("撤销冲突也应当能重置");
        assert_eq!(r.aborted.as_deref(), Some("revert"));
        assert_eq!(read_file(&repo, "a.txt").as_deref(), Some("3"), "回到 HEAD 版本");
        assert_eq!(porcelain(&repo).trim(), "");
        let st = tauri::async_runtime::block_on(git_op_state(repo.path().to_string())).unwrap();
        assert_eq!(st.operation, "");
    }

    /// 未提交的 `.gitignore` 新规则必须继续生效：clean 若排在 reset 之后，
    /// `reset --hard` 会先把 `.gitignore` 还原成 HEAD 版本、新规则当场失效，
    /// 随后 clean 就删掉它本来在保护的目录 —— 而确认框承诺的正是「忽略的不动」。
    #[test]
    fn reset_clean_keeps_dirs_ignored_by_uncommitted_gitignore() {
        let repo = TempRepo::new("resetign");
        commit_files(&repo, &[(".gitignore", "*.log\n"), ("a.txt", "base")], "base");
        std::fs::create_dir_all(repo.0.join("cache")).unwrap();
        std::fs::write(repo.0.join("cache").join("keep.bin"), "k").unwrap();
        // 本地新加规则（未提交），再放一个真正未跟踪的文件
        write_file(&repo, ".gitignore", "*.log\ncache/\n");
        write_file(&repo, "junk.txt", "j");

        let r = reset_clean(&repo).expect("应当能重置");
        assert!(
            repo.0.join("cache").join("keep.bin").exists(),
            "本地忽略规则保护的目录不能被删"
        );
        assert!(!repo.0.join("junk.txt").exists(), "真正未跟踪的文件要删");
        assert_eq!(r.removed, 1, "只应报告删掉 junk.txt");
        assert_eq!(
            read_file(&repo, ".gitignore").as_deref().map(str::trim),
            Some("*.log"),
            "已跟踪的 .gitignore 回到 HEAD 版本"
        );
        // 规则还原后 cache/ 变成未跟踪：如实报告，不谎报干净
        assert_eq!(r.leftover, 1, "残留要如实报告");
    }

    /// 全局 `core.excludesFile` 里的规则必须仍然生效：我们用 `-c core.excludesFile=<tmp>`
    /// 是**整体覆盖**，漏掉它就会把用户全局忽略的文件当未跟踪删掉，而且报告里一字不提。
    #[test]
    fn reset_clean_honors_global_excludes_file() {
        let repo = TempRepo::new("resetglobal");
        let ignore = repo.0.join("global-ignore");
        std::fs::write(&ignore, "*.log\n").unwrap();
        run(
            repo.path(),
            &["config", "core.excludesFile", &ignore.to_string_lossy()],
        )
        .unwrap();
        commit_files(&repo, &[(".gitignore", "dist/\n"), ("a.txt", "base")], "base");
        std::fs::write(repo.0.join("x.log"), "x").unwrap();
        std::fs::write(repo.0.join("junk.txt"), "j").unwrap();
        std::fs::create_dir_all(repo.0.join("dist")).unwrap();
        std::fs::write(repo.0.join("dist").join("d.js"), "d").unwrap();

        let r = reset_clean(&repo).expect("应当能重置");
        assert!(
            repo.0.join("x.log").exists(),
            "全局忽略规则里的 *.log 必须仍然生效"
        );
        assert!(repo.0.join("dist").join("d.js").exists(), "仓库规则要生效");
        assert!(!repo.0.join("junk.txt").exists(), "真未跟踪的仍要删");
        assert_eq!(r.leftover, 0, "一次点干净: {r:?}");
    }

    /// `core.excludesFile` 写成相对路径时，git 相对**仓库根**解析，而 Rust 的
    /// `read_to_string` 相对**应用进程 cwd**：不换算就会静默丢掉用户的全局规则。
    #[test]
    fn reset_clean_honors_relative_global_excludes_file() {
        let repo = TempRepo::new("resetrelglobal");
        commit_files(&repo, &[(".gitignore", "dist/\n"), ("a.txt", "base")], "base");
        std::fs::write(repo.0.join("myignore"), "*.log\n").unwrap();
        run(repo.path(), &["config", "core.excludesFile", "myignore"]).unwrap();
        std::fs::write(repo.0.join("x.log"), "x").unwrap();
        std::fs::write(repo.0.join("junk.txt"), "j").unwrap();

        let r = reset_clean(&repo).expect("应当能重置");
        assert!(
            repo.0.join("x.log").exists(),
            "相对路径的全局忽略规则必须仍然生效"
        );
        assert!(!repo.0.join("junk.txt").exists(), "真未跟踪的仍要删");
        assert_eq!(r.leftover, 0, "一次点干净: {r:?}");
    }

    /// 已跟踪的 `.gitignore` 本地被改「宽」时，重置会把新规则还原掉；必须提前提示，
    /// 否则用户照 leftover 提示再点一次就把它保护的目录删了，与确认框承诺相反。
    #[test]
    fn reset_clean_notes_widened_tracked_gitignore() {
        let repo = TempRepo::new("resetwiden");
        commit_files(&repo, &[(".gitignore", "dist/\n"), ("a.txt", "base")], "base");
        std::fs::write(repo.0.join(".gitignore"), "dist/\nnode_modules/\n").unwrap();
        std::fs::create_dir_all(repo.0.join("node_modules").join("pkg")).unwrap();
        std::fs::write(repo.0.join("node_modules").join("pkg").join("i.js"), "i").unwrap();

        let r = reset_clean(&repo).expect("应当能重置");
        let note = r.note.clone().unwrap_or_default();
        assert!(
            note.contains(".gitignore 有未提交改动"),
            "必须提示忽略规则会随重置丢弃: {note}"
        );
        assert!(
            repo.0.join("node_modules").join("pkg").join("i.js").exists(),
            "这一轮不能删掉它保护的目录"
        );
    }

    /// 深层 `.gitignore` 的 `!放行` 要能压过浅层的忽略规则：`ls-tree -r` 是字典序，
    /// `.devcontainer/` 排在根文件之前，不按深度排序就会永远清不掉、不收敛。
    #[test]
    fn reset_clean_deep_negation_overrides_shallow_rule() {
        let repo = TempRepo::new("resetdeepneg");
        commit_files(
            &repo,
            &[
                (".gitignore", "*.log\n"),
                (".devcontainer/.gitignore", "!keep.log\n"),
                ("a.txt", "base"),
            ],
            "base",
        );
        // 工作区规则删掉，保护只能来自 HEAD
        std::fs::remove_file(repo.0.join(".gitignore")).unwrap();
        std::fs::write(repo.0.join(".devcontainer").join("keep.log"), "k").unwrap();
        std::fs::write(repo.0.join("other.log"), "o").unwrap();

        let r = reset_clean(&repo).expect("应当能重置");
        assert!(
            !repo.0.join(".devcontainer").join("keep.log").exists(),
            "深层 ! 放行的文件不该被浅层 *.log 保护住"
        );
        assert!(
            repo.0.join("other.log").exists(),
            "浅层 *.log 仍要保护其他日志"
        );
        assert_eq!(r.leftover, 0, "必须一次点干净: {r:?}");
    }

    /// 未初始化（deinit）的子模块不能被误报「指针漂移」。
    #[test]
    fn reset_clean_skips_deinitialized_submodule() {
        let lib = TempRepo::new("resetdeinit-lib");
        commit_files(&lib, &[("lib.txt", "base")], "base");
        let repo = TempRepo::new("resetdeinit");
        commit_files(&repo, &[("kept.txt", "base")], "base");
        run(
            repo.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                lib.path(),
                "sub",
            ],
        )
        .unwrap();
        run(repo.path(), &["commit", "-q", "-m", "add sub"]).unwrap();
        run(repo.path(), &["submodule", "deinit", "-f", "--", "sub"]).unwrap();

        let r = reset_clean(&repo).expect("应当能重置");
        let note = r.note.clone().unwrap_or_default();
        assert!(
            !note.contains("不一致"),
            "未初始化的子模块不该报指针漂移: {note}"
        );
        assert_eq!(r.leftover, 0, "deinit 的子模块不该留残留: {r:?}");
    }

    /// `kept_ignores` 只认 basename 恰为 `.gitignore` 的条目：被占用而没删掉的
    /// `locked.gitignore` 是真残留，不能被当成「我们主动保留的」吞掉。
    #[test]
    fn count_kept_ignores_matches_only_real_gitignore() {
        let status = [
            "?? .gitignore",
            "?? sub/.gitignore",
            "?? locked.gitignore",
            "?? notes.gitignore",
            "?? dir/",
            " M a.txt",
        ]
        .join("\n");
        assert_eq!(count_kept_ignores(&status), 2, "只数 basename 恰为 .gitignore 的");
    }

    /// 仓库以子目录身份打开时，clean 的 cwd 会决定它只清子目录 —— 根上的未跟踪文件
    /// 永远清不掉，用户看到的是「怎么点都不干净」。必须一律回到仓库根执行。
    #[test]
    fn reset_clean_from_subdir_cleans_repo_root() {
        let repo = TempRepo::new("resetsubdir");
        commit_files(&repo, &[("dir/a.txt", "base")], "base");
        std::fs::create_dir_all(repo.0.join("dir")).unwrap();
        std::fs::write(repo.0.join("dir").join("inner.txt"), "i").unwrap();
        std::fs::write(repo.0.join("root-junk.txt"), "r").unwrap();

        let sub = repo.0.join("dir").to_string_lossy().to_string();
        let r = tauri::async_runtime::block_on(git_reset_clean(sub)).expect("子目录也应当能重置");
        assert_eq!(r.removed, 2, "子目录与仓库根的未跟踪文件都要删掉");
        assert!(!repo.0.join("root-junk.txt").exists(), "根上的文件也必须删");
        assert!(!repo.0.join("dir").join("inner.txt").exists());
        assert_eq!(r.leftover, 0);
    }

    /// `git am` + `MM`（冲突已 add 后又改文件）：第一次 abort 会被拒绝，
    /// 但 reset 之后索引已等于 HEAD，重试就能退出 —— 用户不该需要点第二次。
    #[test]
    fn reset_clean_retries_abort_after_reset() {
        let repo = TempRepo::new("resetammm");
        commit_files(&repo, &[("c.txt", "base")], "base");
        let base = branch_name(&repo);
        run(repo.path(), &["checkout", "-q", "-b", "side"]).unwrap();
        commit_files(&repo, &[("c.txt", "side")], "side");
        let patches = repo.0.join("patches");
        std::fs::create_dir_all(&patches).unwrap();
        run(
            repo.path(),
            &["format-patch", "-1", "-o", patches.to_str().unwrap()],
        )
        .unwrap();
        run(repo.path(), &["checkout", "-q", &base]).unwrap();
        commit_files(&repo, &[("c.txt", "main")], "main");
        let patch = std::fs::read_dir(&patches)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let _ = run(repo.path(), &["am", patch.to_str().unwrap()]);
        write_file(&repo, "c.txt", "resolved");
        run(repo.path(), &["add", "c.txt"]).unwrap();
        write_file(&repo, "c.txt", "resolved-again");
        assert!(porcelain(&repo).contains("MM c.txt"));

        let r = reset_clean(&repo).expect("am 的 MM 状态也应一次重置成功");
        assert_eq!(
            r.aborted.as_deref(),
            Some("am"),
            "am 不该被报成 rebase"
        );
        assert_eq!(porcelain(&repo).trim(), "");
        let st = tauri::async_runtime::block_on(git_op_state(repo.path().to_string())).unwrap();
        assert_eq!(st.operation, "", "am 中间态应被清除，不该要求点第二次");
    }

    /// 空仓库（没有 HEAD）也要能用：跳过 reset，只做清理，不能报 ambiguous argument。
    #[test]
    fn reset_clean_works_in_repo_without_head() {
        let repo = TempRepo::new("resetempty");
        write_file(&repo, "a.txt", "A1");
        let r = reset_clean(&repo).expect("空仓库也应当能重置");
        assert_eq!(r.discarded, 0);
        assert_eq!(r.removed, 1);
        assert!(!repo.0.join("a.txt").exists(), "未跟踪文件应被清掉");
    }

    /// 空仓库里**已经暂存**的文件：`reset --hard` 会被跳过，索引得单独清空，
    /// 否则文件留在索引里、磁盘上也还在，报告却说「丢弃了 1 个改动」—— 什么都没做还报功。
    #[test]
    fn reset_clean_clears_staged_files_in_repo_without_head() {
        let repo = TempRepo::new("resetempty2");
        write_file(&repo, "a.txt", "A1");
        run(repo.path(), &["add", "a.txt"]).unwrap();
        assert!(porcelain(&repo).contains("a.txt"));

        let r = reset_clean(&repo).expect("空仓库也应当能重置");
        assert_eq!(r.discarded, 0, "空仓库里没有「已跟踪的改动」可言");
        assert_eq!(r.removed, 1, "清空索引后它变成未跟踪条目");
        assert!(!repo.0.join("a.txt").exists(), "文件应被清掉");
        assert_eq!(porcelain(&repo).trim(), "");
    }

    /// abort 被 git 拒绝（冲突已 add 之后又改动该文件 → status MM）不能让整个重置失败：
    /// 紧随其后的 `reset --hard` 照样能清掉 MERGE_HEAD，降级后应当照常成功。
    #[test]
    fn reset_clean_survives_refused_abort() {
        let repo = TempRepo::new("resetrefused");
        commit_files(&repo, &[("c.txt", "base")], "base");
        let base = branch_name(&repo);
        run(repo.path(), &["checkout", "-q", "-b", "side"]).unwrap();
        commit_files(&repo, &[("c.txt", "side")], "side");
        run(repo.path(), &["checkout", "-q", &base]).unwrap();
        commit_files(&repo, &[("c.txt", "main")], "main");
        let _ = run(repo.path(), &["merge", "--no-edit", "side"]);
        // 解决冲突并暂存，再改这笔 —— 此时 merge --abort 会拒绝执行
        write_file(&repo, "c.txt", "resolved");
        run(repo.path(), &["add", "c.txt"]).unwrap();
        write_file(&repo, "c.txt", "resolved-again");
        assert!(porcelain(&repo).contains("MM c.txt"), "应当是 MM 状态");
        assert!(
            run(repo.path(), &["merge", "--abort"]).is_err(),
            "这个状态下 merge --abort 本身就应当被拒绝（否则这条测试没意义）"
        );

        let r = reset_clean(&repo).expect("abort 被拒绝时也应当能重置");
        assert_eq!(r.aborted.as_deref(), Some("merge"), "仍应报告放弃了合并");
        assert_eq!(porcelain(&repo).trim(), "", "工作区应当干净");
        let git_dir = run(repo.path(), &["rev-parse", "--absolute-git-dir"]).unwrap();
        assert!(
            !std::path::Path::new(git_dir.trim()).join("MERGE_HEAD").exists(),
            "MERGE_HEAD 应当被 reset --hard 清掉"
        );
    }

    /// `git am` 停在冲突里：它与 `rebase --apply` 共用 `rebase-apply` 目录，但只能 `am --abort`
    /// （对 am 跑 `rebase --abort` 会报 `It looks like 'git am' is in progress`）。
    #[test]
    fn reset_clean_aborts_pending_am() {
        let repo = TempRepo::new("resetam");
        commit_files(&repo, &[("c.txt", "base")], "base");
        let base = branch_name(&repo);
        run(repo.path(), &["checkout", "-q", "-b", "side"]).unwrap();
        commit_files(&repo, &[("c.txt", "side")], "side");
        let patches = repo.0.join("patches");
        std::fs::create_dir_all(&patches).unwrap();
        run(
            repo.path(),
            &["format-patch", "-1", "-o", patches.to_str().unwrap()],
        )
        .unwrap();
        run(repo.path(), &["checkout", "-q", &base]).unwrap();
        commit_files(&repo, &[("c.txt", "main")], "main");
        let patch = std::fs::read_dir(&patches)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let _ = run(repo.path(), &["am", patch.to_str().unwrap()]);

        let git_dir = run(repo.path(), &["rev-parse", "--absolute-git-dir"]).unwrap();
        assert!(
            std::path::Path::new(git_dir.trim())
                .join("rebase-apply")
                .join("applying")
                .exists(),
            "应当停在 am 中间态"
        );
        assert_eq!(
            tauri::async_runtime::block_on(git_op_state(repo.path().to_string()))
                .unwrap()
                .operation,
            "rebase",
            "am 中间态也要能被识别出来（否则界面显示成「没有进行中的操作」）"
        );

        let r = reset_clean(&repo).expect("am 中间态也应当能重置");
        assert_eq!(
            r.aborted.as_deref(),
            Some("am"),
            "对用户要说清是 am 而不是变基"
        );
        assert_eq!(porcelain(&repo).trim(), "");
        let st = tauri::async_runtime::block_on(git_op_state(repo.path().to_string())).unwrap();
        assert_eq!(st.operation, "", "am 中间态应被清除");
    }

    /// 正在冲突的合并会被先放弃再重置 —— 用户点的是「回到最干净」，不该被拦在半路。
    #[test]
    fn reset_clean_aborts_pending_merge() {
        let repo = TempRepo::new("resetmerge");
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
        assert!(porcelain(&repo).contains("UU c.txt"), "应当处于冲突态");

        let r = reset_clean(&repo).expect("冲突态也应当能重置");
        assert_eq!(r.aborted.as_deref(), Some("merge"), "应报告放弃了合并");
        assert_eq!(read_file(&repo, "c.txt").as_deref(), Some("main"), "回到 HEAD 版本");
        assert_eq!(porcelain(&repo).trim(), "", "冲突状态应被清除");
        let st = tauri::async_runtime::block_on(git_op_state(repo.path().to_string())).unwrap();
        assert_eq!(st.operation, "", "不应再有进行中的操作");
    }

    /// 变基的中间态不会因为 reset --hard 消失，必须显式 --abort。
    #[test]
    fn reset_clean_aborts_pending_rebase() {
        let repo = TempRepo::new("resetrebase");
        commit_files(&repo, &[("c.txt", "base")], "base");
        let base = branch_name(&repo);
        run(repo.path(), &["checkout", "-q", "-b", "side"]).unwrap();
        commit_files(&repo, &[("c.txt", "side")], "side");
        run(repo.path(), &["checkout", "-q", &base]).unwrap();
        commit_files(&repo, &[("c.txt", "main")], "main");
        // 制造一次必然冲突的变基：core.editor=true 防止挂起等编辑器
        let _ = run(
            repo.path(),
            &["-c", "core.editor=true", "rebase", "side"],
        );
        let git_dir = run(repo.path(), &["rev-parse", "--absolute-git-dir"]).unwrap();
        assert!(
            std::path::Path::new(git_dir.trim()).join("rebase-merge").exists()
                || std::path::Path::new(git_dir.trim()).join("rebase-apply").exists(),
            "应当停在变基中间态"
        );

        let r = reset_clean(&repo).expect("变基态也应当能重置");
        assert_eq!(r.aborted.as_deref(), Some("rebase"), "应报告放弃了变基");
        let st = tauri::async_runtime::block_on(git_op_state(repo.path().to_string())).unwrap();
        assert_eq!(st.operation, "", "变基中间态应被清除");
        assert_eq!(porcelain(&repo).trim(), "");
    }
    /// 子目录 `.gitignore` 里不含斜杠的规则是「任意深度」语义：拼上目录前缀后必须补 `**/`，
    /// 否则 `sub/out/` 只护住第一层，`sub/deep/out/` 会被当成未跟踪删掉。
    #[test]
    fn head_ignore_patterns_normalizes_depth_and_skips_noise() {
        let repo = TempRepo::new("ignpat");
        commit_files(
            &repo,
            &[
                (
                    ".gitignore",
                    "# 注释\n\nnode_modules/\n/dist\n**/target\n*.log\n!keep.log\n",
                ),
                ("sub/.gitignore", "out/\nanchored/dir/\n/root-only/\n*.tmp\n"),
            ],
            "base",
        );
        let (pats, _) = head_ignore_patterns(repo.path());
        for want in ["node_modules/", "/dist", "**/target", "*.log"] {
            assert!(pats.iter().any(|p| p == want), "缺失根规则 {want}: {pats:?}");
        }
        // 不含斜杠 → 任意深度；含斜杠或以 `/` 开头 → 保持锚定
        for want in [
            "sub/**/out/",
            "sub/**/*.tmp",
            "sub/anchored/dir/",
            "sub/root-only/",
        ] {
            assert!(pats.iter().any(|p| p == want), "缺失子目录规则 {want}: {pats:?}");
        }
        assert!(
            !pats.iter().any(|p| p.contains("root-only") && p.contains("**")),
            "锚定规则不该被扩成任意深度: {pats:?}"
        );
        // 取反必须保留（否则被 `!` 放行的文件永远清不掉），注释与空行要剔除
        assert!(
            pats.iter().any(|p| p == "!keep.log"),
            "取反规则要保留: {pats:?}"
        );
        assert!(
            !pats.iter().any(|p| p.starts_with('#') || p.trim().is_empty()),
            "注释与空行不该进规则表: {pats:?}"
        );
    }

    /// `!` 取反放行的文件必须真被清掉：只带 `*.log` 不带 `!keep.log` 时，`keep.log` 会被
    /// 当忽略文件保下来，而 `reset --hard` 又把 .gitignore 还原成带 `!` 的样子 ——
    /// 于是它永远留在工作区、leftover 恒为 1，连点多少次都不收敛。
    #[test]
    fn reset_clean_converges_when_gitignore_has_negation() {
        let repo = TempRepo::new("resetneg");
        commit_files(
            &repo,
            &[(".gitignore", "*.log\n!keep.log\n"), ("a.txt", "base")],
            "base",
        );
        // 工作区的 .gitignore 没了，保护只能来自 HEAD 规则
        std::fs::remove_file(repo.0.join(".gitignore")).unwrap();
        std::fs::write(repo.0.join("keep.log"), "k").unwrap();
        std::fs::write(repo.0.join("other.log"), "o").unwrap();

        let r = reset_clean(&repo).expect("应当能重置");
        assert!(
            !repo.0.join("keep.log").exists(),
            "被 ! 放行的文件不是忽略文件，必须清掉"
        );
        assert!(
            repo.0.join("other.log").exists(),
            "*.log 来自 HEAD 规则，仍要保护（宁可少删，多留的由 leftover 报）"
        );
        assert_eq!(r.leftover, 0, "一次点干净: {r:?}");
    }

    /// 父仓库「暂存的 gitlink 改动」（`M  sub`）是真改动，不能被当成「子模块只是工作区脏」跳过。
    #[test]
    fn reset_clean_counts_staged_gitlink_change() {
        let lib = TempRepo::new("resetgl-lib");
        commit_files(&lib, &[("a.txt", "one")], "one");
        std::fs::write(lib.0.join("b.txt"), "two").unwrap();
        run(lib.path(), &["add", "-A"]).unwrap();
        run(lib.path(), &["commit", "-q", "-m", "two"]).unwrap();

        let repo = TempRepo::new("resetgl");
        commit_files(&repo, &[("kept.txt", "base")], "base");
        run(
            repo.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                lib.path(),
                "sub",
            ],
        )
        .unwrap();
        run(repo.path(), &["commit", "-q", "-m", "add sub"]).unwrap();
        // 子模块 HEAD 退回上一个提交 → 父仓库 status 出现 gitlink 差异，再 add 暂存它
        run(&format!("{}/sub", repo.path()), &["checkout", "-q", "HEAD~1"]).unwrap();
        run(repo.path(), &["add", "sub"]).unwrap();
        assert!(
            run(repo.path(), &["status", "--porcelain"])
                .unwrap()
                .contains("M  sub"),
            "前置条件：gitlink 改动已暂存"
        );

        let r = reset_clean(&repo).expect("应当能重置");
        assert_eq!(r.discarded, 1, "暂存的 gitlink 改动应当计入 discarded: {r:?}");
    }

    /// 400 条长规则不能把命令行撑爆（Windows 上限 32767）：clean 必须真的跑起来。
    #[test]
    fn reset_clean_survives_many_long_ignore_rules() {
        let repo = TempRepo::new("resetlong");
        let mut rules = String::new();
        for i in 0..400 {
            rules.push_str(&format!("dir{:03}/{}/\n", i, "x".repeat(70)));
        }
        commit_files(&repo, &[(".gitignore", &rules), ("a.txt", "base")], "base");
        std::fs::write(repo.0.join("junk.txt"), "j").unwrap();

        let r = reset_clean(&repo).expect("长规则不该让 clean 起不来");
        assert!(!repo.0.join("junk.txt").exists(), "clean 必须真的执行");
        assert_eq!(r.leftover, 0, "一次点干净: {r:?}");
    }

    /// 子模块内部的未跟踪文件被删掉时要计入 removed（父仓库 status 看不到它们）。
    #[test]
    fn reset_clean_counts_untracked_files_inside_submodule() {
        let lib = TempRepo::new("resetsubcnt-lib");
        commit_files(&lib, &[("lib.txt", "base")], "base");
        let repo = TempRepo::new("resetsubcnt");
        commit_files(&repo, &[("kept.txt", "base")], "base");
        run(
            repo.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                lib.path(),
                "sub",
            ],
        )
        .unwrap();
        run(repo.path(), &["commit", "-q", "-m", "add sub"]).unwrap();
        std::fs::write(repo.0.join("sub").join("untracked.txt"), "u").unwrap();

        let r = reset_clean(&repo).expect("应当能重置");
        assert!(
            !repo.0.join("sub").join("untracked.txt").exists(),
            "子模块里的未跟踪文件要被清掉"
        );
        assert_eq!(r.removed, 1, "子模块里删掉的文件也要计入 removed: {r:?}");
    }

    /// 子目录 `.gitignore` 被删后，深层目录仍要按 HEAD 里的规则保住。
    #[test]
    fn reset_clean_keeps_deep_dirs_covered_by_subdir_gitignore() {
        let repo = TempRepo::new("resetdeep");
        commit_files(
            &repo,
            &[("sub/.gitignore", "out/\n"), ("sub/a.txt", "base")],
            "base",
        );
        // 删掉子目录规则，再在两层深处建成「应当被忽略」的目录
        std::fs::remove_file(repo.0.join("sub").join(".gitignore")).unwrap();
        let deep = repo.0.join("sub").join("deep").join("out");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("f.js"), "keep").unwrap();
        write_file(&repo, "sub/junk.txt", "j");

        let r = reset_clean(&repo).expect("应当能重置");
        assert!(deep.join("f.js").exists(), "深层 ignored 目录不应被删");
        assert!(!repo.0.join("sub").join("junk.txt").exists(), "未跟踪文件应删除");
        assert_eq!(r.leftover, 0);
    }

    /// 子模块自己的 `.gitignore` 被删时，它的 node_modules 也要保住
    /// （顶层 `-e` 只管顶层，子模块必须单独推一遍规则）。
    #[test]
    fn reset_clean_keeps_submodule_ignored_dirs() {
        let lib = TempRepo::new("resetsublib2");
        commit_files(&lib, &[(".gitignore", "node_modules/\n"), ("lib.txt", "base")], "base");
        let repo = TempRepo::new("resetsub2");
        commit_files(&repo, &[("kept.txt", "base")], "base");
        run(
            repo.path(),
            &["-c", "protocol.file.allow=always", "submodule", "add", lib.path(), "sub"],
        )
        .unwrap();
        run(repo.path(), &["commit", "-q", "-m", "add sub"]).unwrap();

        let sub = repo.0.join("sub");
        std::fs::remove_file(sub.join(".gitignore")).unwrap();
        let nm = sub.join("node_modules").join("x");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(nm.join("i.js"), "keep").unwrap();
        std::fs::write(sub.join("junk.txt"), "j").unwrap();

        let r = reset_clean(&repo).expect("有子模块也应当能重置");
        assert!(nm.join("i.js").exists(), "子模块内的 ignored 目录不应被删");
        assert!(!sub.join("junk.txt").exists(), "子模块内未跟踪文件应删除");
        assert_eq!(r.leftover, 0, "子模块应能自己清干净");
        assert_eq!(porcelain(&repo).trim(), "", "顶层不再显示脏");
    }

    /// 子模块路径里有空格时也要清得掉（`submodule status` 的行必须整段切，不能按空白分词）。
    #[test]
    fn reset_clean_handles_submodule_path_with_space() {
        let lib = TempRepo::new("resetspacelib");
        commit_files(&lib, &[("lib.txt", "base")], "base");
        let repo = TempRepo::new("resetspace");
        commit_files(&repo, &[("kept.txt", "base")], "base");
        run(
            repo.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                lib.path(),
                "my lib",
            ],
        )
        .unwrap();
        run(repo.path(), &["commit", "-q", "-m", "add sub"]).unwrap();

        let sub = repo.0.join("my lib");
        std::fs::write(sub.join("junk.txt"), "j").unwrap();

        let r = reset_clean(&repo).expect("含空格的子模块路径也应当能重置");
        assert!(!sub.join("junk.txt").exists(), "含空格的子模块内未跟踪文件应删除");
        assert_eq!(r.leftover, 0, "含空格的子模块应能自己清干净");
    }

    /// 子目录里以 `/` 开头的规则只锚定该目录根：深层同名目录不属于它，
    /// 该删的删掉、不能因为「过度保护」留下永远清不掉的残留。
    #[test]
    fn reset_clean_anchored_rule_stays_anchored() {
        let repo = TempRepo::new("resetanchor");
        commit_files(
            &repo,
            &[("sub/.gitignore", "/root-only/\n"), ("sub/a.txt", "base")],
            "base",
        );
        // 删掉工作区规则，只剩 HEAD 里那条锚定的 `/root-only/`
        std::fs::remove_file(repo.0.join("sub").join(".gitignore")).unwrap();
        let kept = repo.0.join("sub").join("root-only");
        std::fs::create_dir_all(&kept).unwrap();
        std::fs::write(kept.join("keep.js"), "keep").unwrap();
        let deep = repo.0.join("sub").join("deep").join("root-only");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("drop.js"), "drop").unwrap();

        let r = reset_clean(&repo).expect("应当能重置");
        assert!(kept.join("keep.js").exists(), "一级的 ignored 目录应保住");
        assert!(!deep.join("drop.js").exists(), "深层同名目录不该被过度保护");
        assert_eq!(r.leftover, 0, "锚定规则不应留下残留");

        // 连点第二次必须仍然干净（残留若存在，这里会一直涨）
        let again = reset_clean(&repo).expect("第二次也应成功");
        assert_eq!(again.leftover, 0, "重复重置必须收敛");
        assert_eq!(porcelain(&repo).trim(), "", "重复重置后仍是干净工作区");
    }

    /// **未提交**的 `.gitignore` 不能被 clean 当未跟踪文件删掉：第一轮它还在替 node_modules
    /// 挡着，删掉之后第二轮就只剩 HEAD 规则（为空）—— 用户看到 leftover 提示再点一次，
    /// node_modules / dist 会被连根删掉。这是真实事故路径，必须钉死。
    #[test]
    fn reset_clean_keeps_uncommitted_gitignore_and_its_ignored_dirs() {
        let repo = TempRepo::new("resetungit");
        commit_files(&repo, &[("a.txt", "base")], "base");
        // .gitignore 只存在于工作区，从未提交
        std::fs::write(repo.0.join(".gitignore"), "node_modules/\ndist/\n").unwrap();
        for d in ["node_modules/x", "dist"] {
            let dir = repo.0.join(d);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("1.js"), "1").unwrap();
        }
        std::fs::write(repo.0.join("junk.txt"), "j").unwrap();

        let first = reset_clean(&repo).expect("第一次应当能重置");
        assert!(
            repo.0.join(".gitignore").exists(),
            "未提交的 .gitignore 不该被当成未跟踪文件删掉"
        );
        assert!(repo.0.join("node_modules/x/1.js").exists(), "第一次不能删 ignored 目录");

        let second = reset_clean(&repo).expect("第二次应当能重置");
        assert!(
            repo.0.join("node_modules/x/1.js").exists(),
            "连点第二次仍然不能删 ignored 目录（旧实现在这里删掉）"
        );
        assert!(repo.0.join("dist/1.js").exists(), "dist 同样要保住");
        assert!(!repo.0.join("junk.txt").exists(), "真正未跟踪的文件仍要删");
        let _ = (first, second);
    }

    /// 子模块停在别的提交（指针漂移）时清不掉，但必须在 `note` 里说清楚，
    /// 不能只让 toast 笼统归咎于「嵌套仓库、子模块等」。
    #[test]
    fn reset_clean_notes_submodule_drift() {
        let lib = TempRepo::new("resetdriftlib");
        commit_files(&lib, &[("lib.txt", "v1")], "v1");
        std::fs::write(lib.0.join("lib.txt"), "v2").unwrap();
        run(lib.path(), &["add", "-A"]).unwrap();
        run(lib.path(), &["commit", "-q", "-m", "v2"]).unwrap();
        let repo = TempRepo::new("resetdrift");
        commit_files(&repo, &[("kept.txt", "base")], "base");
        run(
            repo.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                lib.path(),
                "sub",
            ],
        )
        .unwrap();
        run(repo.path(), &["commit", "-q", "-m", "add sub"]).unwrap();
        // 把子模块停到上一个提交：HEAD 与 gitlink 不一致
        run(&format!("{}/sub", repo.path()), &["checkout", "-q", "HEAD~1"]).unwrap();

        let cur = run(&format!("{}/sub", repo.path()), &["rev-parse", "HEAD"]).unwrap();
        let cur = cur.trim()[..7].to_string();
        let r = reset_clean(&repo).expect("指针漂移不该报错");
        assert_eq!(r.leftover, 1, "指针不一致必然留下残留");
        let note = r.note.unwrap_or_default();
        assert!(note.contains("子模块"), "note 应说明是子模块问题: {note}");
        assert!(note.contains("不一致"), "note 应说明与父仓库记录不一致: {note}");
        assert!(note.contains(&cur), "note 要给出子模块当前提交 {cur}: {note}");
    }

    /// 规则数超过上限被截断时必须给 note —— 截断意味着有一部分 ignored 目录失去保护。
    #[test]
    fn reset_clean_notes_truncated_ignore_rules() {
        let repo = TempRepo::new("resetcapped");
        // 前 400 条只是填充，第 401 条才是保护 node_modules 的那条 —— 被截掉的正是它
        let mut rules = String::new();
        for i in 0..400 {
            rules.push_str(&format!("junk{i}/\n"));
        }
        rules.push_str("fill-a/\nfill-b/\nfill-c/\nfill-d/\nnode_modules/\n");
        commit_files(&repo, &[(".gitignore", &rules), ("a.txt", "base")], "base");
        std::fs::create_dir_all(repo.0.join("node_modules")).unwrap();
        std::fs::write(repo.0.join("node_modules").join("x.js"), "x").unwrap();
        // 工作区的 .gitignore 删掉，保护只能来自 HEAD 规则
        std::fs::remove_file(repo.0.join(".gitignore")).unwrap();

        let r = reset_clean(&repo).expect("应当能重置");
        let note = r.note.unwrap_or_default();
        assert!(note.contains("上限"), "截断要说明: {note}");
        assert!(
            !repo.0.join("node_modules").exists(),
            "被截断的规则没有参与保护，node_modules 会被删——这正是要如实提示的原因"
        );
    }

    /// 刚好 400 条不算截断：不能谎报「规则太多」。
    #[test]
    fn reset_clean_no_truncation_note_at_exactly_max_rules() {
        let repo = TempRepo::new("resetexact");
        let mut rules = String::new();
        for i in 0..400 {
            rules.push_str(&format!("junk{i}/\n"));
        }
        commit_files(&repo, &[(".gitignore", &rules), ("a.txt", "base")], "base");
        let r = reset_clean(&repo).expect("应当能重置");
        let note = r.note.unwrap_or_default();
        assert!(!note.contains("上限"), "刚好 400 条不该报截断: {note}");
    }

    /// 子模块里的规则被截断时，顶层一句都不提 —— 用户不知道子模块的 node_modules 已被删。
    #[test]
    fn reset_clean_notes_truncated_rules_inside_submodule() {
        let mut rules = String::new();
        for i in 0..400 {
            rules.push_str(&format!("junk{i}/\n"));
        }
        rules.push_str("fill-a/\nfill-b/\nfill-c/\nfill-d/\nnode_modules/\n");
        let lib = TempRepo::new("resetsubcap-lib");
        commit_files(&lib, &[(".gitignore", &rules), ("lib.txt", "base")], "base");
        let repo = TempRepo::new("resetsubcap");
        commit_files(&repo, &[("kept.txt", "base")], "base");
        run(
            repo.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                lib.path(),
                "sub",
            ],
        )
        .unwrap();
        run(repo.path(), &["commit", "-q", "-m", "add sub"]).unwrap();

        let r = reset_clean(&repo).expect("有子模块也应当能重置");
        let note = r.note.unwrap_or_default();
        assert!(note.contains("子模块"), "子模块里的截断要单独说明: {note}");
        assert!(note.contains("上限"), "子模块里的截断要说明上限: {note}");
    }

}

