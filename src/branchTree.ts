// 分支前缀树：把分支名按 / 切开，相同前缀自动合并成可折叠节点
import type { Branch } from "./gitApi";

export interface BNode {
  seg: string; // 本段名字
  path: string; // 全路径，作折叠 key
  children: BNode[];
  count: number; // 后代叶子数
  branch?: Branch; // 有值即叶子
}

export function buildNodes(branches: Branch[]): BNode[] {
  const root: BNode = { seg: "", path: "", children: [], count: 0 };
  for (const b of branches) {
    const parts = b.name.split("/");
    let cur = root;
    parts.forEach((seg, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let child = cur.children.find((c) => c.seg === seg);
      if (!child) {
        child = { seg, path, children: [], count: 0 };
        cur.children.push(child);
      }
      child.count++;
      cur = child;
    });
    cur.branch = b;
  }
  return root.children;
}
