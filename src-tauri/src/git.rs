use serde::Serialize;
use std::process::Command;

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

    let out = cmd
        .output()
        .map_err(|e| format!("无法启动 git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
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
                let rest = rest.split("...").next().unwrap_or("").trim();
                st.branch = rest.to_string();
                for tok in line.split_whitespace() {
                    match tok.parse::<u32>() {
                        Ok(n)
                            if Some(tok)
                                == line
                                    .split("ahead")
                                    .nth(1)
                                    .and_then(|s| s.split_whitespace().next()) =>
                        {
                            st.ahead = n
                        }
                        _ => {}
                    }
                }
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
        if !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("非法的 commit hash".into());
        }
        run(
            &repo,
            &[
                "show",
                "--no-color",
                "--format=",
                "-m",
                "--first-parent",
                &hash,
            ],
        )
    })
    .await
}

/// 未跟踪文件的合成 diff：读文件内容，每行当新增行展示（上限 2000 行，二进制文件提示）
#[tauri::command]
pub async fn git_diff_untracked(repo: String, path: String) -> Result<String, String> {
    offload(move || {
        use std::path::Path;
        let p = Path::new(&repo).join(&path);
        let bytes = std::fs::read(&p).map_err(|e| format!("读取文件失败: {e}"))?;
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

/// 读取/保存当前仓库的提交者信息（仓库级 git config）
#[tauri::command]
pub async fn git_get_user(repo: String) -> Result<(String, String), String> {
    offload(move || {
        let n = run(&repo, &["config", "user.name"]).unwrap_or_default();
        let e = run(&repo, &["config", "user.email"]).unwrap_or_default();
        Ok((n.trim().to_string(), e.trim().to_string()))
    })
    .await
}

#[tauri::command]
pub async fn git_config_user(repo: String, name: String, email: String) -> Result<(), String> {
    offload(move || {
        if !name.trim().is_empty() {
            run(&repo, &["config", "user.name", name.trim()])?;
        }
        if !email.trim().is_empty() {
            run(&repo, &["config", "user.email", email.trim()])?;
        }
        Ok(())
    })
    .await
}

/// 丢弃更改：已跟踪文件 checkout -- 恢复；未跟踪文件直接删除（目录递归）
#[tauri::command]
pub async fn git_discard(repo: String, path: String, untracked: bool) -> Result<(), String> {
    offload(move || {
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

/// revert 指定提交（生成反向提交）
#[tauri::command]
pub async fn git_revert(repo: String, hash: String) -> Result<(), String> {
    offload(move || {
        if !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("非法的 commit hash".into());
        }
        run(
            &repo,
            &["-c", "alias.revert=revert", "revert", "--no-edit", &hash],
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
                if branch.trim().is_empty() {
                    return Err(e);
                }
                run(&repo, &["push", "-u", "origin", &branch]).map(|_| ())
            }
            Err(e) => Err(e),
        }
    })
    .await
}

#[tauri::command]
pub async fn git_pull(repo: String) -> Result<(), String> {
    offload(move || run(&repo, &["pull"]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_checkout(repo: String, name: String) -> Result<(), String> {
    offload(move || run(&repo, &["checkout", &name]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_branch_create(repo: String, name: String) -> Result<(), String> {
    offload(move || {
        if name.trim().is_empty() {
            return Err("分支名不能为空".into());
        }
        run(&repo, &["checkout", "-b", name.trim()]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_branch_delete(repo: String, name: String, force: bool) -> Result<(), String> {
    offload(move || {
        // 默认 -d 安全删（未合并会拒绝）；force 用 -D 强删
        let flag = if force { "-D" } else { "-d" };
        run(&repo, &["branch", flag, &name]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_branch_rename(repo: String, old: String, new: String) -> Result<(), String> {
    offload(move || {
        if new.trim().is_empty() {
            return Err("分支名不能为空".into());
        }
        run(&repo, &["branch", "-m", &old, new.trim()]).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn git_merge(repo: String, name: String) -> Result<(), String> {
    offload(move || run(&repo, &["merge", "--no-edit", &name]).map(|_| ())).await
}

/// 删除远程分支：git push <remote> --delete <name>
#[tauri::command]
pub async fn git_push_delete(repo: String, remote: String, name: String) -> Result<(), String> {
    offload(move || {
        if remote.trim().is_empty() || name.trim().is_empty() {
            return Err("远程名和分支名不能为空".into());
        }
        run(&repo, &["push", &remote, "--delete", &name]).map(|_| ())
    })
    .await
}

/// 单个 commit 中单个文件的 patch（文件历史弹窗右侧用）
#[tauri::command]
pub async fn git_show_file(repo: String, hash: String, path: String) -> Result<String, String> {
    offload(move || {
        if !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("非法的 commit hash".into());
        }
        run(&repo, &["show", "--no-color", "--format=", &hash, "--", &path])
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
        if let Some(r) = rev.as_deref() {
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
