// fileTree.ts 文件列表目录树自检：node --experimental-strip-types src/lib/fileTree.test.ts
//
// 守几处「看起来该那样、其实不能那样」的地方：压平不能把「目录 + 唯一子文件」也压掉
// （那样会变成两行说同一件事）、过滤必须强制展开目录（否则命中的文件看不见）、
// 重命名必须按新路径落位（否则它会跑到旧目录底下）。
//
// 还有一条是「共用」本身的守卫：换一种元素类型（diff 弹窗的 section）必须能直接用，
// 不需要在 fileTree 里加任何分支 —— 否则两份实现迟早分叉。
import assert from "node:assert";
import { buildFileRows, displayPath, tailName, type FileRow } from "./fileTree.ts";
import type { StatusFile } from "../gitApi.ts";

const sf = (path: string, x = " ", y = "M"): StatusFile => ({ path, x, y });

function shape<T>(rows: FileRow<T>[]): string[] {
  return rows.map((r) => "  ".repeat(r.depth) + (r.kind === "dir" ? `${r.label}/` : r.label));
}
function dirRows<T>(rows: FileRow<T>[]) {
  return rows.filter((r): r is Extract<FileRow<T>, { kind: "dir" }> => r.kind === "dir");
}
const base = { section: "s", collapsed: new Set<string>() };

// ---- 纯根级文件：一层平铺，没有目录行 ----
{
  const rows = buildFileRows([sf("b.txt"), sf("a.txt")], displayPath, base);
  assert.deepStrictEqual(shape(rows), ["a.txt", "b.txt"]);
  assert.deepStrictEqual(rows.map((r) => r.depth), [0, 0]);
}

// ---- 目录在前、文件在后；同层按名字排 ----
{
  const rows = buildFileRows([sf("z.txt"), sf("src/a.ts")], displayPath, base);
  assert.deepStrictEqual(shape(rows), ["src/", "  a.ts", "z.txt"]);
}

// ---- 压平：只有一个子目录的链连成一行 ----
{
  const rows = buildFileRows([sf("a/b/c/d.txt")], displayPath, base);
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
  const rows = buildFileRows([sf("a/d.txt")], displayPath, base);
  assert.deepStrictEqual(shape(rows), ["a/", "  d.txt"]);
}

// ---- 关掉压平就是完整的每一层 ----
{
  const rows = buildFileRows([sf("a/b/c/d.txt")], displayPath, { ...base, compact: false });
  assert.deepStrictEqual(shape(rows), ["a/", "  b/", "    c/", "      d.txt"]);
}

// ---- 收起只影响自己那棵子树，兄弟目录不动 ----
{
  const files = [sf("src/a.ts"), sf("docs/b.md")];
  const open = buildFileRows(files, displayPath, base);
  assert.deepStrictEqual(shape(open), ["docs/", "  b.md", "src/", "  a.ts"]);
  const folded = buildFileRows(files, displayPath, { ...base, collapsed: new Set(["sd:src"]) });
  assert.deepStrictEqual(shape(folded), ["docs/", "  b.md", "src/"]);
  assert.strictEqual(dirRows(folded)[1]!.collapsed, true);
  assert.strictEqual(dirRows(folded)[0]!.collapsed, false);
}

// ---- 过滤：只留命中文件与它的祖先目录，大小写不敏感，命中目录名也算 ----
{
  const files = [sf("src/components/Button.vue"), sf("src/lib/utils.ts"), sf("README.md")];
  assert.deepStrictEqual(shape(buildFileRows(files, displayPath, { ...base, filter: "BUTTON" })), [
    "src/components/",
    "  Button.vue",
  ]);
  assert.deepStrictEqual(shape(buildFileRows(files, displayPath, { ...base, filter: "lib/" })), [
    "src/lib/",
    "  utils.ts",
  ]);
  assert.deepStrictEqual(buildFileRows(files, displayPath, { ...base, filter: "zzz" }), []);
}

// ---- 过滤时必须强制展开：收起状态下命中会被藏起来 ----
{
  const rows = buildFileRows([sf("src/a.ts")], displayPath, {
    ...base,
    collapsed: new Set(["sd:src"]),
    filter: "a.ts",
  });
  assert.deepStrictEqual(shape(rows), ["src/", "  a.ts"]);
}

// ---- 重命名按**新**路径落位；删除的文件照样出现 ----
{
  const rows = buildFileRows(
    [sf("old/x.txt -> new/x.txt", "R", " "), sf("gone/y.txt", "D", " ")],
    displayPath,
    base,
  );
  assert.deepStrictEqual(shape(rows), ["gone/", "  y.txt", "new/", "  x.txt"]);
  assert.strictEqual(displayPath(sf("a/x.txt -> b/y.txt")), "b/y.txt");
}

// ---- 文件行保留 porcelain 原始串（展示层要靠它渲染 old → new），path 只给新名 ----
{
  const rows = buildFileRows([sf("a/x.txt -> b/y.txt", "R", " ")], displayPath, base);
  assert.deepStrictEqual(shape(rows), ["b/", "  y.txt"]);
  const row = rows[1]!;
  assert.strictEqual(row.kind, "file");
  if (row.kind === "file") {
    assert.strictEqual(row.item.path, "a/x.txt -> b/y.txt");
    assert.strictEqual(row.path, "b/y.txt");
    assert.strictEqual(row.label, "y.txt");
  }
}

// ---- count 是后代文件总数（收起时显示的「里面还有几个」） ----
{
  const rows = buildFileRows([sf("a/b/1.txt"), sf("a/b/2.txt"), sf("a/c/3.txt")], displayPath, base);
  const dirs = dirRows(rows);
  assert.strictEqual(dirs[0]!.label, "a");
  assert.strictEqual(dirs[0]!.count, 3);
  assert.strictEqual(dirs[1]!.label, "b");
  assert.strictEqual(dirs[1]!.count, 2);
}

// ---- 同一个文件在两个列表里各有一行，key 必须分开 ----
{
  const f = [sf("a.txt", "M", " ")];
  const k = (section: string) => buildFileRows(f, displayPath, { ...base, section })[0]!.key;
  assert.strictEqual(k("s"), "sf:a.txt");
  assert.strictEqual(k("u"), "uf:a.txt");
  assert.notStrictEqual(k("s"), k("u"));
}

// ---- 工具函数 ----
assert.strictEqual(tailName("a/b/c.txt"), "c.txt");
assert.strictEqual(tailName("c.txt"), "c.txt");
assert.deepStrictEqual(buildFileRows([], displayPath, base), []);

// 未跟踪的新文件同样进树（x === "?"）
assert.deepStrictEqual(shape(buildFileRows([sf("new/dir/x.txt", "?", "?")], displayPath, base)), [
  "new/dir/",
  "  x.txt",
]);

// ---- 平铺视图：不建目录行，label 是完整路径，顺序与传入一致 ----
{
  const files = [sf("z.txt"), sf("src/a.ts"), sf("src/b.ts")];
  const rows = buildFileRows(files, displayPath, { ...base, flat: true });
  assert.deepStrictEqual(shape(rows), ["z.txt", "src/a.ts", "src/b.ts"]);
  assert.deepStrictEqual(rows.map((r) => r.depth), [0, 0, 0]);
  assert.strictEqual(rows.every((r) => r.kind === "file"), true);
}

// ---- 平铺的 key 必须与树模式一致：来回切视图时选中项不该丢 ----
{
  const files = [sf("src/a.ts")];
  const treeFile = buildFileRows(files, displayPath, base).find((r) => r.kind === "file")!;
  const flat = buildFileRows(files, displayPath, { ...base, flat: true })[0]!;
  assert.strictEqual(flat.key, treeFile.key);
  assert.strictEqual(flat.path, "src/a.ts");
}

// ---- 平铺也过滤；没有目录行，所以收起集合对它毫无影响 ----
{
  const files = [sf("src/a.ts"), sf("docs/b.md")];
  const rows = (o: object) => shape(buildFileRows(files, displayPath, { ...base, ...o }));
  assert.deepStrictEqual(rows({ flat: true, filter: "B.MD" }), ["docs/b.md"]);
  assert.deepStrictEqual(rows({ flat: true, collapsed: new Set(["sd:src"]) }), [
    "src/a.ts",
    "docs/b.md",
  ]);
}

// ---- 平铺里的重命名同样只认新路径 ----
{
  const rows = buildFileRows([sf("old/x.txt -> new/x.txt", "R", " ")], displayPath, {
    ...base,
    flat: true,
  });
  assert.deepStrictEqual(shape(rows), ["new/x.txt"]);
  assert.strictEqual(rows[0]!.kind, "file");
  if (rows[0]!.kind === "file") assert.strictEqual(rows[0]!.item.path, "old/x.txt -> new/x.txt");
}

// ---- 换一种元素类型（diff 弹窗的 section）直接用，不需要在 fileTree 里加分支 ----
{
  const secs = [
    { file: "src/components/Button.vue", lines: 12 },
    { file: "README.md", lines: 3 },
  ];
  const rows = buildFileRows(secs, (s) => s.file, base);
  assert.deepStrictEqual(shape(rows), ["src/components/", "  Button.vue", "README.md"]);
  // 按路径取，不按「第一个 file 行」取 —— 行序是目录在前
  const leaf = rows.find((r) => r.kind === "file" && r.path === "README.md")!;
  if (leaf.kind === "file") assert.strictEqual(leaf.item.lines, 3); // item 带着原对象，不只是路径

  // section 命名空间分开，且平铺 key 与树模式一致 —— 切视图不丢选中
  const flat = buildFileRows(secs, (s) => s.file, { ...base, section: "d", flat: true });
  assert.strictEqual(flat[0]!.key, "df:src/components/Button.vue");
  assert.strictEqual(
    buildFileRows(secs, (s) => s.file, { ...base, section: "d" })
      .find((r) => r.kind === "file")!
      .key,
    flat[0]!.key,
  );
}

// ---- matchOf：过滤用的串可以比「落到树里的路径」更宽 ----
{
  const renamed = [sf("old/x.txt -> new/x.txt", "R", " ")];
  // 变更列表传 porcelain 原始串 —— 用旧名也能搜到，这是它一直以来的行为
  assert.deepStrictEqual(
    shape(buildFileRows(renamed, displayPath, { ...base, filter: "OLD/", matchOf: (f) => f.path })),
    ["new/", "  x.txt"],
  );
  // 不给 matchOf 就按 pathOf（只认新路径）—— 两边的差别是有意的，不是漏写
  assert.deepStrictEqual(
    buildFileRows(renamed, displayPath, { ...base, filter: "OLD/" }),
    [],
  );
}

console.log("file tree tests passed");
