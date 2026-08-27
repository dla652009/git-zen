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

import { invoke } from "@tauri-apps/api/core";

export const status = (repo: string) => invoke<Status>("git_status", { repo });
export const log = (repo: string, skip?: number) =>
  invoke<LogEntry[]>("git_log", { repo, skip: skip ?? null });
export const branches = (repo: string) =>
  invoke<Branch[]>("git_branches", { repo });
export const diff = (repo: string, paths: string[], cached: boolean) =>
  invoke<string>("git_diff", { repo, paths, cached });
export const diffUnpushed = (repo: string) =>
  invoke<string>("git_diff_unpushed", { repo });
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
export const writeTextFile = (path: string, content: string) =>
  invoke<void>("git_write_file", { path, content });
