// 工作树列表的行模型（纯函数，无 Vue 依赖，便于 node 自检）。
//
// 后端返回的是 git 的原始形态：路径是正斜杠、head 是 40 位全串、分支可能为空、
// detached / locked / prunable 是几个独立布尔。界面要的却是「一行能读的信息」。
// 所有推导都放这里，是为了让「同一个工作树在弹窗和 tab 上的名字必须一致」这件事
// 只在一个地方定义 —— 两处各算一次，迟早出现列表叫 A、标签页叫 B。
import type { WorktreeEntry } from "../gitApi";

export interface WorktreeRow extends WorktreeEntry {
  /** 目录末段名，列表里当标题显示 */
  name: string;
  /** 前 7 位 hash；空仓库（全 0）显示为 "—" */
  shortHead: string;
  /** 占用中的分支名；detached / 无提交时为 null */
  occupiedBranch: string | null;
  /** 给人看的状态标签（当前 / 主 / 已锁定 / 目录已丢失 / 可清理） */
  flags: WorktreeFlag[];
  /** 目录是否已失效（git 说 prunable，或目录本身不在了） */
  broken: boolean;
}

export type WorktreeFlag = "main" | "detached" | "locked" | "missing" | "prunable";

/** 空仓库的 HEAD 全是 0（后端也可能给空串），直接截前 7 位会显示成 "0000000"，没有意义 */
export const ZERO_HASH = /^0*$/;

/** 路径末段。同时吃正斜杠与反斜杠 —— git 输出正斜杠，用户手填的可能是反斜杠 */
export function tailName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : p;
}

/**
 * 路径归一化后比较用：Windows 上 git 给的是 `C:/work/x`，localStorage 里存的
 * 可能是 `C:\work\x`，两者是同一个目录。不归一化就会把同一个工作树当成两个。
 * 只在「判等」时用，展示一律用原始路径（用户认得的写法）。
 */
export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

export function normPath(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows 盘符大小写不敏感；统一小写只为比较，不用于展示
  return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
}

export function toRows(entries: WorktreeEntry[]): WorktreeRow[] {
  return entries.map((e) => {
    const broken = e.prunable || e.missing;
    const flags: WorktreeFlag[] = [];
    if (e.is_main) flags.push("main");
    if (e.detached) flags.push("detached");
    if (e.locked) flags.push("locked");
    if (e.missing) flags.push("missing");
    // prunable 与 missing 常常同时成立（目录被删）；只在 git 说 prunable 而目录还在时单独标，
    // 否则同一行会重复表达「这个目录没了」
    if (e.prunable && !e.missing) flags.push("prunable");
    return {
      ...e,
      name: tailName(e.path),
      shortHead: ZERO_HASH.test(e.head) ? "—" : e.head.slice(0, 7),
      occupiedBranch: e.branch && !e.detached ? e.branch : null,
      flags,
      broken,
    };
  });
}

/**
 * 分支名 → 占用它的工作树路径。
 *
 * 这是本期最有价值的一块：在拿到这份表之前，前端根本不知道某个分支已经在别的目录里
 * 检出，只能等 checkout 抛 `fatal: ... is already used by worktree at ...`。
 * git 本身不允许两个工作树检出同一分支，所以正常情况下不会撞键；
 * 真撞了（手工改过 .git/worktrees）保留第一条，别让解析崩。
 */
export function branchOwners(entries: WorktreeEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    if (!e.branch || e.detached) continue;
    if (!map.has(e.branch)) map.set(e.branch, e.path);
  }
  return map;
}

/** 当前正在浏览的仓库在这个列表里是哪一条（按归一化路径判等） */
export function findSelf(
  entries: WorktreeEntry[],
  repoPath: string,
): WorktreeEntry | undefined {
  const t = normPath(repoPath);
  return entries.find((e) => normPath(e.path) === t);
}

/**
 * 状态标签的展示文案。只给 status 用的短词，长句在组件里拼。
 * detached 不说「游离 HEAD」——标签栏那么窄，用户也未必知道这个词。
 */
export const FLAG_LABEL: Record<WorktreeFlag, string> = {
  main: "主",
  detached: "无分支",
  locked: "已锁定",
  missing: "目录已丢失",
  prunable: "可清理",
};
