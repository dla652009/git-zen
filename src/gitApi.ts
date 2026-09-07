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
export const pushDelete = (repo: string, remote: string, name: string) =>
  invoke<void>("git_push_delete", { repo, remote, name });
export const getUser = (repo: string) =>
  invoke<[string, string]>("git_get_user", { repo });
export const configUser = (repo: string, name: string, email: string) =>
  invoke<void>("git_config_user", { repo, name, email });
export const discard = (repo: string, path: string, untracked: boolean) =>
  invoke<void>("git_discard", { repo, path, untracked });
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
export const writeTextFile = (path: string, content: string) =>
  invoke<void>("git_write_file", { path, content });
