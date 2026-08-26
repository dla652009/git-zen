// 泳道布局：两遍扫描。
// pass1: 按顺序给每个 commit 分配列（lane）；pass2: 收集 child->parent 连线。
// ponytail: 简化版布局，交叉线可能不最优；要完美可换 dagre。

import type { LogEntry } from "./gitApi";

export interface Point {
  row: number;
  col: number;
}

export interface Edge {
  from: Point;
  to: Point;
}

export interface Layout {
  cols: number;
  colOf: Map<string, number>;
  edges: Edge[];
}

export function layout(commits: LogEntry[]): Layout {
  const lanes: (string | null)[] = []; // 每格是「下一个期待出现的 hash」或 null(空槽)
  const rowOf = new Map<string, number>();
  const colOf = new Map<string, number>();

  commits.forEach((c, i) => {
    rowOf.set(c.hash, i);
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      const free = lanes.indexOf(null);
      col = free === -1 ? lanes.length : free;
    }
    if (col < lanes.length && lanes[col] === c.hash) lanes[col] = null;
    colOf.set(c.hash, col);

    for (const p of c.parents) {
      if (rowOf.has(p)) continue; // 已出现的父提交（合并），不动
      if (lanes.includes(p)) continue;
      const free = lanes.indexOf(null);
      if (free === -1) lanes.push(p);
      else lanes[free] = p;
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  });

  const edges: Edge[] = [];
  commits.forEach((c, i) => {
    const from = { row: i, col: colOf.get(c.hash)! };
    for (const p of c.parents) {
      if (!colOf.has(p)) continue;
      edges.push({ from, to: { row: rowOf.get(p)!, col: colOf.get(p)! } });
    }
  });

  return {
    cols: Math.max(1, ...commits.map((c) => colOf.get(c.hash)! + 1)),
    colOf,
    edges,
  };
}

export const LANE_COLORS = [
  "#8b7ff5",
  "#4a9ec2",
  "#c2884a",
  "#b04ac2",
  "#c24a5b",
  "#8a9aa8",
  "#d6c14a",
];
