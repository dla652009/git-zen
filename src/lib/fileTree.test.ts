// fileTree.ts 变更列表目录树自检：node --experimental-strip-types src/lib/fileTree.test.ts
//
// 守几处「看起来该那样、其实不能那样」的地方：压平不能把「目录 + 唯一子文件」也压掉
// （那样会变成两行说同一件事）、过滤必须强制展开目录（否则命中的文件看不见）、
// 重命名必须按新路径落位（否则它会跑到旧目录底下）。
import assert from "node:assert";
import { buildFileRows, displayPath, tailName, type FileRow } from "./fileTree.ts";
import type { StatusFile } from "../gitApi.ts";

const sf = (path: string, x = " ", y = "M"): StatusFile => ({ path, x, y });

function shape(rows: FileRow[]): string[] {
  return rows.map((r) => "  ".repeat(r.depth) + (r.kind === "dir" ? `${r.label}/` : r.label));
}
function dirRows(rows: FileRow[]) {
  return rows.filter((r): r is Extract<FileRow, { kind: "dir" }> => r.kind === "dir");
}
const base = { section: "s", collapsed: new Set<string>() };

// ---- 纯根级文件：一层平铺，没有目录行 ----
{
  const rows = buildFileRows([sf("b.txt"), sf("a.txt")], base);
  assert.deepStrictEqual(shape(rows), ["a.txt", "b.txt"]);
  assert.deepStrictEqual(rows.map((r) => r.depth), [0, 0]);
}

// ---- 目录在前、文件在后；同层按名字排 ----
{
  const rows = buildFileRows([sf("z.txt"), sf("src/a.ts")], base);
  assert.deepStrictEqual(shape(rows), ["src/", "  a.ts", "z.txt"]);
}

// ---- 压平：只有一个子目录的链连成一行 ----
{
  const rows = buildFileRows([sf("a/b/c/d.txt")], base);
  assert.deepStrictEqual(shape(rows), ["a/b/c/", "  d.txt"]);
  const dir = dirRows(rows)[0]!;
  // 传给 git 的必须是压平后的完整路径：用户看到什么就操作什么
  assert.strictEqual(dir.path, "a/b/c");
  assert.strictEqual(dir.key, "sd:a");
  assert.strictEqual(dir.count, 1);
  assert.strictEqual(rows[1]!.depth, 1);
}

// ---- 压平不能吃掉「目录 + 唯一子文件」那一层 ----
{
  const rows = buildFileRows([sf("a/d.txt")], base);
  assert.deepStrictEqual(shape(rows), ["a/", "  d.txt"]);
}

// ---- 关掉压平就是完整的每一层 ----
{
  const rows = buildFileRows([sf("a/b/c/d.txt")], { ...base, compact: false });
  assert.deepStrictEqual(shape(rows), ["a/", "  b/", "    c/", "      d.txt"]);
}

// ---- 收起只影响自己那棵子树，兄弟目录不动 ----
{
  const files = [sf("src/a.ts"), sf("docs/b.md")];
  const open = buildFileRows(files, base);
  assert.deepStrictEqual(shape(open), ["docs/", "  b.md", "src/", "  a.ts"]);
  const folded = buildFileRows(files, { ...base, collapsed: new Set(["sd:src"]) });
  assert.deepStrictEqual(shape(folded), ["docs/", "  b.md", "src/"]);
  assert.strictEqual(dirRows(folded)[1]!.collapsed, true);
  assert.strictEqual(dirRows(folded)[0]!.collapsed, false);
}

// ---- 过滤：只留命中文件与它的祖先目录，大小写不敏感，命中目录名也算 ----
{
  const files = [sf("src/components/Button.vue"), sf("src/lib/utils.ts"), sf("README.md")];
  assert.deepStrictEqual(shape(buildFileRows(files, { ...base, filter: "BUTTON" })), [
    "src/components/",
    "  Button.vue",
  ]);
  assert.deepStrictEqual(shape(buildFileRows(files, { ...base, filter: "lib/" })), [
    "src/lib/",
    "  utils.ts",
  ]);
  assert.deepStrictEqual(buildFileRows(files, { ...base, filter: "zzz" }), []);
}

// ---- 过滤时必须强制展开：收起状态下命中会被藏起来 ----
{
  const rows = buildFileRows([sf("src/a.ts")], {
    ...base,
    collapsed: new Set(["sd:src"]),
    filter: "a.ts",
  });
  assert.deepStrictEqual(shape(rows), ["src/", "  a.ts"]);
}

// ---- 重命名按**新**路径落位；删除的文件照样出现 ----
{
  const rows = buildFileRows([sf("old/x.txt -> new/x.txt", "R", " "), sf("gone/y.txt", "D", " ")], base);
  assert.deepStrictEqual(shape(rows), ["gone/", "  y.txt", "new/", "  x.txt"]);
  assert.strictEqual(displayPath(sf("a/x.txt -> b/y.txt")), "b/y.txt");
}

// ---- 文件行保留 porcelain 原始串（展示层要靠它渲染 old → new），path 只给新名 ----
{
  const rows = buildFileRows([sf("a/x.txt -> b/y.txt", "R", " ")], base);
  assert.deepStrictEqual(shape(rows), ["b/", "  y.txt"]);
  const row = rows[1]!;
  assert.strictEqual(row.kind, "file");
  if (row.kind === "file") {
    assert.strictEqual(row.file.path, "a/x.txt -> b/y.txt");
    assert.strictEqual(row.path, "b/y.txt");
    assert.strictEqual(row.label, "y.txt");
  }
}

// ---- count 是后代文件总数（收起时显示的「里面还有几个」） ----
{
  const rows = buildFileRows([sf("a/b/1.txt"), sf("a/b/2.txt"), sf("a/c/3.txt")], base);
  const dirs = dirRows(rows);
  assert.strictEqual(dirs[0]!.label, "a");
  assert.strictEqual(dirs[0]!.count, 3);
  assert.strictEqual(dirs[1]!.label, "b");
  assert.strictEqual(dirs[1]!.count, 2);
}

// ---- 同一个文件在两个列表里各有一行，key 必须分开 ----
{
  const f = [sf("a.txt", "M", " ")];
  assert.strictEqual(buildFileRows(f, { ...base, section: "s" })[0]!.key, "sf:a.txt");
  assert.strictEqual(buildFileRows(f, { ...base, section: "u" })[0]!.key, "uf:a.txt");
  assert.notStrictEqual(
    buildFileRows(f, { ...base, section: "s" })[0]!.key,
    buildFileRows(f, { ...base, section: "u" })[0]!.key,
  );
}

// ---- 工具函数 ----
assert.strictEqual(tailName("a/b/c.txt"), "c.txt");
assert.strictEqual(tailName("c.txt"), "c.txt");
assert.deepStrictEqual(buildFileRows([], base), []);

// 未跟踪的新文件同样进树（x === "?"）
assert.deepStrictEqual(shape(buildFileRows([sf("new/dir/x.txt", "?", "?")], base)), [
  "new/dir/",
  "  x.txt",
]);

console.log("file tree tests passed");
