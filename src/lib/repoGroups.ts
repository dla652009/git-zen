// 仓库总览的分组切分（纯函数，无 Vue 依赖，便于 node 自检）。
//
// 规则只有三条，但都容易写错：
// 1. 组顺序照抄选项卡（用户亲手排的），不另排一套
// 2. 组名不在选项卡顺序里的（刚在别处改过分组、数据还没同步）按字母接在后面 ——
//    丢行比顺序不对严重得多
// 3. 未分组的仓库放最后一节，且只在真的存在未分组仓库时才出现这一节

export interface GroupableRow {
  path: string;
  group?: string;
}

export interface RepoSection<T> {
  /** 折叠状态的键：组名本身，未分组用固定哨兵值 */
  key: string;
  label: string;
  rows: T[];
}

/** 未分组那一节的 key。用不可能与真实组名相同的值（组名来自用户输入，这里加前缀兜住） */
export const UNGROUPED_KEY = "\u0000ungrouped";

export function splitByGroup<T extends GroupableRow>(
  rows: T[],
  groupOrder: string[] = [],
): RepoSection<T>[] {
  const byGroup = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const r of rows) {
    const g = r.group?.trim();
    if (!g) {
      ungrouped.push(r);
      continue;
    }
    const list = byGroup.get(g);
    if (list) list.push(r);
    else byGroup.set(g, [r]);
  }

  // 先按选项卡顺序，再补上顺序表里没有的组（按字母）
  const ordered = groupOrder.filter((g) => byGroup.has(g));
  const rest = [...byGroup.keys()].filter((g) => !groupOrder.includes(g)).sort();

  const out: RepoSection<T>[] = [...ordered, ...rest].map((g) => ({
    key: g,
    label: g,
    rows: byGroup.get(g)!,
  }));
  if (ungrouped.length) {
    out.push({ key: UNGROUPED_KEY, label: "未分组", rows: ungrouped });
  }
  return out;
}

/**
 * 一批 path 的勾选状态。三态的边界容易写错：
 * - 空集合：既不是全选也不算部分（否则空的组头会显示成 indeterminate）
 * - all 用「集合是否覆盖全部」判断，而不是「数量相等」—— 集合里可能有已不存在的
 *   path（仓库被关掉了、props.rows 还没来得及过滤），按数量比会误判成全选
 */
export type PickState = "none" | "some" | "all";

export function pickState(paths: string[], picked: Iterable<string>): PickState {
  if (!paths.length) return "none";
  const set = picked instanceof Set ? picked : new Set(picked);
  let hit = 0;
  for (const p of paths) if (set.has(p)) hit += 1;
  if (hit === 0) return "none";
  return hit === paths.length ? "all" : "some";
}

/**
 * 切换一批 path 的勾选，返回新的勾选列表。
 * 只动这一批，其余保持原样；顺序按 `order`（通常是全部行）重排，
 * 让批量执行时的派发顺序与界面看到的一致。
 */
export function togglePaths(
  picked: string[],
  paths: string[],
  order: string[] = [],
): string[] {
  const set = new Set(picked);
  const allIn = paths.length > 0 && paths.every((p) => set.has(p));
  if (allIn) for (const p of paths) set.delete(p);
  else for (const p of paths) set.add(p);
  if (!order.length) return [...set];
  // order 里没有的（理论上不该有）接在后面，免得静默丢勾选
  const inOrder = order.filter((p) => set.has(p));
  const extra = [...set].filter((p) => !order.includes(p));
  return [...inOrder, ...extra];
}
