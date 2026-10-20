// 后端返回结构的镜像（与 src-tauri/src/git.rs 的 serde struct 一一对应）

export interface StatusFile {
  path: string;
  x: string; // 暂存区状态码 M/A/D/R/U/...
  y: string; // 工作区状态码，"?" = 未跟踪
}

export interface Status {
  branch: string;
  ahead: number;
  behind: number;
  files: StatusFile[];
}

export interface LogEntry {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  refs: string[];
}

export interface Branch {
  name: string;
  current: boolean;
  remote: boolean;
  ahead: number; // 领先上游的提交数（本地分支才有意义）
  behind: number; // 落后上游的提交数
  upstream: string; // 上游短名，空 = 远程还没有这个分支
}

// git blame 单行归属（rev 为空 = 工作区内容）
export interface BlameLine {
  line: number; // 该版本文件中的行号（1-based）
  hash: string; // 最后修改该行的提交（40 位）
  author: string;
  time: number; // author-time（epoch 秒）
}

// 提交热力图：单日提交计数（git_commit_stats 已按天聚合，只含有提交的日期）
export interface CommitDay {
  date: string; // YYYY-MM-DD
  count: number;
}
export const commitStats = (repo: string, since: string, author?: string) =>
  invoke<CommitDay[]>("git_commit_stats", { repo, since, author: author ?? null });

import { invoke } from "@tauri-apps/api/core";

export const status = (repo: string) => invoke<Status>("git_status", { repo });
export const log = (
  repo: string,
  skip?: number,
  all?: boolean,
  filePath?: string,
) =>
  invoke<LogEntry[]>("git_log", {
    repo,
    skip: skip ?? null,
    all: all ?? null,
    filePath: filePath ?? null,
  });
export const remoteUrl = (repo: string) =>
  invoke<string>("git_remote_url", { repo });
export const branches = (repo: string) =>
  invoke<Branch[]>("git_branches", { repo });
export const diff = (repo: string, paths: string[], cached: boolean) =>
  invoke<string>("git_diff", { repo, paths, cached });
export const diffUnpushed = (repo: string) =>
  invoke<string>("git_diff_unpushed", { repo });
export const showFile = (repo: string, hash: string, path: string) =>
  invoke<string>("git_show_file", { repo, hash, path });
/** 读仓库内文本文件（工作区内容）。文件不存在 / 是二进制时返回 null，不算错误 */
export const readRepoFile = (repo: string, path: string, maxBytes?: number) =>
  invoke<string | null>("git_read_repo_file", {
    repo,
    path,
    maxBytes: maxBytes ?? null,
  });
export const blame = (repo: string, rev: string | null, path: string) =>
  invoke<BlameLine[]>("git_blame", { repo, rev: rev ?? null, path });
export const fetchAll = (repo: string) => invoke<void>("git_fetch", { repo });
export const show = (repo: string, hash: string) =>
  invoke<string>("git_show", { repo, hash });
export const diffUntracked = (repo: string, path: string) =>
  invoke<string>("git_diff_untracked", { repo, path });
export const stage = (repo: string, paths: string[]) =>
  invoke<void>("git_stage", { repo, paths });
export const unstage = (repo: string, paths: string[]) =>
  invoke<void>("git_unstage", { repo, paths });
export const commit = (repo: string, message: string) =>
  invoke<void>("git_commit", { repo, message });
export const push = (repo: string, branch: string) =>
  invoke<void>("git_push", { repo, branch });
// 强制推送：后端用 --force-with-lease（远程被别人更新过会拒绝），不是裸 --force。
// branch 为空 = 推当前分支到它的上游
export const pushForce = (repo: string, branch: string) =>
  invoke<void>("git_push_force", { repo, branch });
export const pull = (repo: string) => invoke<void>("git_pull", { repo });
export const checkout = (repo: string, name: string) =>
  invoke<void>("git_checkout", { repo, name });
export const branchCreate = (repo: string, name: string) =>
  invoke<void>("git_branch_create", { repo, name });
export const branchDelete = (repo: string, name: string, force: boolean) =>
  invoke<void>("git_branch_delete", { repo, name, force });
export const branchRename = (repo: string, oldName: string, newName: string) =>
  invoke<void>("git_branch_rename", { repo, old: oldName, new: newName });
export const merge = (repo: string, name: string) =>
  invoke<void>("git_merge", { repo, name });
// 放弃进行中的合并（冲突卡住时的退路，等价 git merge --abort）
export const mergeAbort = (repo: string) =>
  invoke<void>("git_merge_abort", { repo });
export const pushDelete = (repo: string, remote: string, name: string) =>
  invoke<void>("git_push_delete", { repo, remote, name });
export const getUser = (repo: string) =>
  invoke<[string, string]>("git_get_user", { repo });
export const configUser = (repo: string, name: string, email: string) =>
  invoke<void>("git_config_user", { repo, name, email });
export const discard = (repo: string, path: string, untracked: boolean) =>
  invoke<void>("git_discard", { repo, path, untracked });
// 丢弃暂存区的全部改动：暂存内容与工作区一起还原到 HEAD，未跟踪文件不受影响。
// paths 由前端从 status 算出（含重命名文件的旧名与新名），未跟踪文件不传。
// deleteNew=false 时新增文件只取消暂存、留在磁盘上（删掉不可恢复，交给用户选）
export const discardStaged = (repo: string, paths: string[], deleteNew: boolean) =>
  invoke<void>("git_discard_staged", { repo, paths, deleteNew });
export const revert = (repo: string, hash: string) =>
  invoke<void>("git_revert", { repo, hash });
export const resetUnpushed = (repo: string) =>
  invoke<void>("git_reset_unpushed", { repo });

// amend 上次提交：message 为空 = 保留原提交信息（--no-edit）
export const amend = (repo: string, message?: string) =>
  invoke<void>("git_amend", { repo, message: message ?? null });
// 撤销最近一次提交（reset --soft HEAD~1，改动回到暂存区）
export const undoCommit = (repo: string) =>
  invoke<void>("git_undo_commit", { repo });

// stash 记录（index 对应 stash@{N}）
export interface StashEntry {
  index: number;
  hash: string;
  date: string; // 相对日期
  subject: string; // WIP on <分支>: … / On <分支>: 备注
}
export const stashList = (repo: string) =>
  invoke<StashEntry[]>("git_stash_list", { repo });
export const stashPush = (
  repo: string,
  message?: string,
  includeUntracked?: boolean,
) =>
  invoke<void>("git_stash_push", {
    repo,
    message: message ?? null,
    includeUntracked: includeUntracked ?? false,
  });
export const stashApply = (repo: string, index: number, pop: boolean) =>
  invoke<void>("git_stash_apply", { repo, index, pop });
export const stashDrop = (repo: string, index: number) =>
  invoke<void>("git_stash_drop", { repo, index });

// 标签（annotated = 附注标签，message 为附注信息；轻量标签 message 为空）
export interface TagEntry {
  name: string;
  annotated: boolean;
  target: string; // 指向的 commit 全 hash
  date: string;
  message: string;
}
export const tagList = (repo: string) =>
  invoke<TagEntry[]>("git_tag_list", { repo });
export const tagCreate = (
  repo: string,
  name: string,
  message?: string,
  target?: string,
) =>
  invoke<void>("git_tag_create", {
    repo,
    name,
    message: message ?? null,
    target: target ?? null,
  });
export const tagDelete = (repo: string, name: string) =>
  invoke<void>("git_tag_delete", { repo, name });
export const tagPush = (repo: string, name: string) =>
  invoke<void>("git_tag_push", { repo, name });
// 克隆远程仓库到本地（dest 为完整目标路径，完成后前端 addRepo + 切换打开）
export const clone = (url: string, dest: string) =>
  invoke<void>("git_clone", { url, dest });

// ---- M10 ----

// 路径追加进仓库根 .gitignore（已存在该行则跳过）
export const ignoreAdd = (repo: string, path: string) =>
  invoke<void>("git_ignore_add", { repo, path });
export const cherryPick = (repo: string, hash: string) =>
  invoke<void>("git_cherry_pick", { repo, hash });
// Release Notes 数据：from..to 区间提交清单（from 空 = 全部可达；to 空 = HEAD；from 可为 tag 名）
export interface CommitBrief {
  hash: string;
  author: string;
  date: string;
  subject: string;
}
export const commitsRange = (repo: string, from: string, to?: string) =>
  invoke<CommitBrief[]>("git_commits_range", { repo, from, to: to ?? null });
// HEAD 可达的最近 tag（无 tag 返回空串）
export const latestTag = (repo: string) =>
  invoke<string>("git_latest_tag", { repo });
// 判断路径是否是 git 仓库（拖拽文件夹进窗口打开时校验）
export const checkRepo = (path: string) =>
  invoke<boolean>("git_check_repo", { path });
// 在指定目录 git init（目录还不是仓库，所以只吃 path 不吃 repo）
export const initRepo = (path: string) => invoke<void>("git_init", { path });
export const writeTextFile = (path: string, content: string) =>
  invoke<void>("git_write_file", { path, content });

// ---- M19 ----

// reflog 时间线：selector 是按位置编号的（列表一变就指向别处），回到某一步请用 hash
export interface ReflogEntry {
  hash: string;
  selector: string;
  action: string;
  date: string;
}
export const reflog = (repo: string) =>
  invoke<ReflogEntry[]>("git_reflog", { repo });
// 回到某一步：hard = 工作区一起回去（丢未提交改动），soft = 只挪 HEAD、改动留在暂存区
export const resetTo = (repo: string, hash: string, mode?: "hard" | "soft") =>
  invoke<void>("git_reset_to", { repo, hash, mode: mode ?? null });

// 进行中的多步操作：operation 为空串表示没有；conflicts 是仍未解决的冲突文件
export interface OpState {
  operation: string;
  conflicts: string[];
}
export const opState = (repo: string) =>
  invoke<OpState>("git_op_state", { repo });
// 继续完成 merge / cherry-pick / revert（冲突全部标记为已解决之后才有意义）
export const opContinue = (repo: string) =>
  invoke<void>("git_op_continue", { repo });
// 把最近 count 个提交压成一条（soft reset + commit；interactive rebase 的有界替代品）
export const squashRecent = (repo: string, count: number, message: string) =>
  invoke<void>("git_squash_recent", { repo, count, message });
