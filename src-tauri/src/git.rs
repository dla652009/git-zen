use serde::Serialize;
use std::process::Command;

fn run(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(repo)
        // 中文等非 ASCII 路径不转成八进制转义，否则展示和回传 pathspec 都会坏
        .args(["-c", "core.quotepath=false"])
        .args(args)
        // fail fast instead of hanging on credential prompt; system credential helper still works
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("无法启动 git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
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
pub fn git_status(repo: String) -> Result<Status, String> {
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
pub fn git_log(repo: String, skip: Option<u32>) -> Result<Vec<LogEntry>, String> {
    let args = [
        "log".to_string(),
        format!("--skip={}", skip.unwrap_or(0)),
        "--max-count=300".to_string(),
        "--date=relative".to_string(),
        "--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%ad%x1f%D".to_string(),
    ];
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run(&repo, &arg_refs);
    let out = match out {
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
pub fn git_branches(repo: String) -> Result<Vec<Branch>, String> {
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
}

// ---------- diff / fetch ----------

#[tauri::command]
pub fn git_diff(repo: String, path: String, cached: bool) -> Result<String, String> {
    let mut args = vec!["diff", "--no-color"];
    if cached {
        args.push("--cached");
    }
    args.push("--");
    args.push(&path);
    run(&repo, &args)
}

#[tauri::command]
pub fn git_fetch(repo: String) -> Result<(), String> {
    run(&repo, &["fetch", "--all"]).map(|_| ())
}

/// 单个 commit 的完整 patch（多文件）
/// -m --first-parent：普通 commit 同默认；merge commit 对比第一父提交，否则合并提交无输出
#[tauri::command]
pub fn git_show(repo: String, hash: String) -> Result<String, String> {
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
}

/// 未跟踪文件的合成 diff：读文件内容，每行当新增行展示（上限 2000 行，二进制文件提示）
#[tauri::command]
pub fn git_diff_untracked(repo: String, path: String) -> Result<String, String> {
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
}

/// 读取/保存当前仓库的提交者信息（仓库级 git config）
#[tauri::command]
pub fn git_get_user(repo: String) -> Result<(String, String), String> {
    let n = run(&repo, &["config", "user.name"]).unwrap_or_default();
    let e = run(&repo, &["config", "user.email"]).unwrap_or_default();
    Ok((n.trim().to_string(), e.trim().to_string()))
}

#[tauri::command]
pub fn git_config_user(repo: String, name: String, email: String) -> Result<(), String> {
    if !name.trim().is_empty() {
        run(&repo, &["config", "user.name", name.trim()])?;
    }
    if !email.trim().is_empty() {
        run(&repo, &["config", "user.email", email.trim()])?;
    }
    Ok(())
}

/// 丢弃更改：已跟踪文件 checkout -- 恢复；未跟踪文件直接删除（目录递归）
#[tauri::command]
pub fn git_discard(repo: String, path: String, untracked: bool) -> Result<(), String> {
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
}

/// revert 指定提交（生成反向提交）
#[tauri::command]
pub fn git_revert(repo: String, hash: String) -> Result<(), String> {
    if !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("非法的 commit hash".into());
    }
    run(
        &repo,
        &["-c", "alias.revert=revert", "revert", "--no-edit", &hash],
    )
    .map(|_| ())
}

// ---------- actions ----------

#[tauri::command]
pub fn git_stage(repo: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    run(&repo, &args).map(|_| ())
}

#[tauri::command]
pub fn git_unstage(repo: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["reset", "-q", "HEAD", "--"];
    args.extend(paths.iter().map(|s| s.as_str()));
    run(&repo, &args).map(|_| ())
}

#[tauri::command]
pub fn git_commit(repo: String, message: String) -> Result<(), String> {
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
}

#[tauri::command]
pub fn git_push(repo: String, branch: String) -> Result<(), String> {
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
}

#[tauri::command]
pub fn git_pull(repo: String) -> Result<(), String> {
    run(&repo, &["pull"]).map(|_| ())
}

#[tauri::command]
pub fn git_checkout(repo: String, name: String) -> Result<(), String> {
    run(&repo, &["checkout", &name]).map(|_| ())
}

#[tauri::command]
pub fn git_branch_create(repo: String, name: String) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("分支名不能为空".into());
    }
    run(&repo, &["checkout", "-b", name.trim()]).map(|_| ())
}

#[tauri::command]
pub fn git_branch_delete(repo: String, name: String, force: bool) -> Result<(), String> {
    // 默认 -d 安全删（未合并会拒绝）；force 用 -D 强删
    let flag = if force { "-D" } else { "-d" };
    run(&repo, &["branch", flag, &name]).map(|_| ())
}

#[tauri::command]
pub fn git_branch_rename(repo: String, old: String, new: String) -> Result<(), String> {
    if new.trim().is_empty() {
        return Err("分支名不能为空".into());
    }
    run(&repo, &["branch", "-m", &old, new.trim()]).map(|_| ())
}

#[tauri::command]
pub fn git_merge(repo: String, name: String) -> Result<(), String> {
    run(&repo, &["merge", "--no-edit", &name]).map(|_| ())
}

/// 删除远程分支：git push <remote> --delete <name>
#[tauri::command]
pub fn git_push_delete(repo: String, remote: String, name: String) -> Result<(), String> {
    if remote.trim().is_empty() || name.trim().is_empty() {
        return Err("远程名和分支名不能为空".into());
    }
    run(&repo, &["push", &remote, "--delete", &name]).map(|_| ())
}
