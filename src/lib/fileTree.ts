// 变更列表的目录树：建树 → 压平单子链 → 拍平成渲染行。
//
// 为什么是「拍平成行」而不是像 BranchTree.vue 那样做递归组件：拍平之后
// ChangesPanel 的模板仍然是「一个 <ul> + 一个 v-for」，现成的滚动容器、max-h、
// hover 组、右键菜单、Tooltip 全都不用动。
//
// 树必须从 porcelain 的路径建，**不能去遍历文件系统**：删除的文件已经不在磁盘上，
// 但照样要出现在它原来的位置。
import type { StatusFile } from "../gitApi";

interface RowBase {
  /** 折叠与选中用的 id，形如 `sd:src/components`。带 section 命名空间是必需的 ——
   *  同一个文件（MM：暂存了一部分、工作区又改了）在已暂存与未暂存两个列表里各有一行。 */
  key: string;
  /** 本行显示的名字：目录可能是压平后的 "a/b/c"，文件是文件名 */
  label: string;
  /** 全路径，交给 git 用的是它。目录取**压平后**的完整路径 —— 用户看到什么就操作什么 */
  path: string;
  /** 缩进层级，从 0 起。压平正是靠减少层级来省横向空间 */
  depth: number;
}

export interface DirRow extends RowBase {
  kind: "dir";
  /** 后代文件数 */
  count: number;
  /** 当前是否收起 */
  collapsed: boolean;
}

export interface FileItemRow extends RowBase {
  kind: "file";
  /** 重命名行的 `file.path` 仍是 "old -> new" 整串，展示交给调用方 */
  file: StatusFile;
}

/** 判别联合：模板里 `v-if="row.kind === 'dir'"` 之后 `row.count` 才存在、
 *  `row.kind === 'file'` 之后 `row.file` 一定在 —— 不用到处写 `!` */
export type FileRow = DirRow | FileItemRow;

/** git 认的路径：porcelain 的重命名行是 "old -> new" 整串，只有新名才是有效 pathspec */
export function displayPath(f: StatusFile): string {
  return f.path.split(" -> ").pop()!;
}

/** 路径的最后一段 */
export function tailName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

interface Node {
  seg: string;
  path: string;
  children: Map<string, Node>;
  file?: StatusFile;
  count: number;
}

function bySeg(a: Node, b: Node): number {
  return a.seg < b.seg ? -1 : a.seg > b.seg ? 1 : 0;
}

/** 后序累计后代文件数 */
function countUp(n: Node): number {
  let c = n.file ? 1 : 0;
  for (const ch of n.children.values()) c += countUp(ch);
  n.count = c;
  return c;
}

export interface BuildOptions {
  /** "s"（已暂存）/ "u"（未暂存）：折叠与选中的 key 必须分开，两边可能同时有同一个文件 */
  section: string;
  /** 已收起的目录 key 集合（`${section}d:${顶层目录路径}`） */
  collapsed: ReadonlySet<string>;
  /** 过滤词：匹配完整路径、大小写不敏感。非空时目录一律展开（否则命中的文件看不见） */
  filter?: string;
  /** 压平只含一个子目录的链，默认开 */
  compact?: boolean;
}

export function buildFileRows(files: StatusFile[], opts: BuildOptions): FileRow[] {
  const q = (opts.filter ?? "").trim().toLowerCase();
  const forceOpen = q.length > 0;
  const compact = opts.compact ?? true;

  // 过滤在建树之前做：只留下命中文件的祖先目录，不会出现空目录
  const root: Node = { seg: "", path: "", children: new Map(), count: 0 };
  for (const f of files) {
    if (q && !f.path.toLowerCase().includes(q)) continue;
    const p = displayPath(f);
    const parts = p.split("/").filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      const path = cur.path ? `${cur.path}/${seg}` : seg;
      let next = cur.children.get(seg);
      if (!next) {
        next = { seg, path, children: new Map(), count: 0 };
        cur.children.set(seg, next);
      }
      cur = next;
    }
    const seg = parts[parts.length - 1] ?? p;
    // 同一路径不会出现两行；重命名的两边若撞进同一格，后写入的胜出即可
    const leaf: Node = cur.children.get(seg) ?? { seg, path: p, children: new Map(), count: 0 };
    leaf.file = f;
    leaf.path = p;
    cur.children.set(seg, leaf);
  }
  countUp(root);

  const rows: FileRow[] = [];

  function emitFile(n: Node, depth: number) {
    rows.push({
      kind: "file",
      key: `${opts.section}f:${n.path}`,
      label: n.seg,
      path: n.path,
      depth,
      file: n.file!,
    });
  }

  function emitDir(n: Node, depth: number) {
    // 压平：只含一个子目录时把它接上来。唯一的孩子是文件就不压 ——
    // 那样会变成「目录行 + 文件名」两行说同一件事，反而多一行
    let label = n.seg;
    let tail = n;
    if (compact) {
      while (!tail.file && tail.children.size === 1) {
        const only = [...tail.children.values()][0]!;
        if (only.file) break;
        label = `${label}/${only.seg}`;
        tail = only;
      }
    }
    const key = `${opts.section}d:${n.path}`;
    const collapsed = !forceOpen && opts.collapsed.has(key);
    rows.push({
      kind: "dir",
      key,
      label,
      path: tail.path,
      depth,
      count: tail.count,
      collapsed,
    });
    if (collapsed) return;
    const kids = [...tail.children.values()];
    // 目录在前、文件在后，各自按名字排 —— 树里这是最不容易找错的分组方式
    for (const d of kids.filter((c) => c.children.size > 0).sort(bySeg)) emitDir(d, depth + 1);
    for (const f of kids.filter((c) => c.children.size === 0).sort(bySeg)) emitFile(f, depth + 1);
  }

  const top = [...root.children.values()];
  for (const d of top.filter((c) => c.children.size > 0).sort(bySeg)) emitDir(d, 0);
  for (const f of top.filter((c) => c.children.size === 0).sort(bySeg)) emitFile(f, 0);
  return rows;
}
