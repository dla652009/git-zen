// patch.ts diff 解析自检：node --experimental-strip-types src/lib/patch.test.ts
import assert from "node:assert";
import { patchLines, patchSections } from "./patch.ts";

// ---- unified diff ----
const unified = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " context",
  "-old",
  "+new",
].join("\n");

let lines = patchLines(unified);
assert.equal(lines[0].cls, "text-muted-foreground"); // 头
assert.equal(lines[1].cls, "text-muted-foreground"); // index
assert.equal(lines[2].cls, "text-muted-foreground"); // ---
assert.ok(lines[4].cls.includes("diff-add-bg")); // @@ 头
assert.equal(lines[5].cls, ""); // 上下文
assert.ok(lines[6].cls.includes("diff-del-text")); // -old
assert.ok(lines[7].cls.includes("diff-add-text")); // +new

let secs = patchSections(unified);
assert.equal(secs.length, 1);
assert.equal(secs[0].file, "src/a.ts");
assert.equal(secs[0].lines.length, 8);

// 行号跟踪：context/- 行记 oldLine，context/+ 行记 newLine（供逐行 blame 归属）
assert.equal(lines[5].oldLine, 1); // context
assert.equal(lines[5].newLine, 1);
assert.equal(lines[6].oldLine, 2); // -old
assert.equal(lines[6].newLine, undefined);
assert.equal(lines[7].oldLine, undefined); // +new
assert.equal(lines[7].newLine, 2);

// ---- combined diff（合并冲突，git diff 实测输出）----
const combined = [
  "diff --cc f.txt",
  "index b9a7e46,f873d5d..0000000",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@@ -1,3 -1,3 +1,7 @@@",
  "  line1",
  "++<<<<<<< HEAD",
  " +line2 master",
  "++=======",
  "+ line2 feature",
  "++>>>>>>> feature",
  "  line3",
].join("\n");

lines = patchLines(combined);
assert.equal(lines[0].cls, "text-muted-foreground"); // diff --cc 头
assert.equal(lines[1].cls, "text-muted-foreground"); // index 元信息
assert.equal(lines[4].cls, "text-muted-foreground"); // @@@ 头不高亮成新增
assert.equal(lines[5].cls, ""); // 上下文
assert.equal(lines[6].cls, "bg-amber-400/15 text-amber-400"); // <<<<<<< 标记
assert.ok(lines[7].cls.includes("diff-add-text")); // + 单列 = 一侧内容
assert.equal(lines[8].cls, "bg-amber-400/15 text-amber-400"); // ======= 标记
assert.ok(lines[9].cls.includes("diff-add-text"));
assert.equal(lines[10].cls, "bg-amber-400/15 text-amber-400"); // >>>>>>> 标记
assert.equal(lines[11].cls, "");

secs = patchSections(combined);
assert.equal(secs.length, 1);
assert.equal(secs[0].file, "f.txt");

// ---- 含空格路径的 unified 头（贪婪匹配取 a/ 到 b/ 之间）----
secs = patchSections("diff --git a/foo bar.txt b/foo bar.txt\n@@ -0,0 +1 @@\n+x");
assert.equal(secs.length, 1);
assert.equal(secs[0].file, "foo bar.txt");

// ---- 未跟踪文件合成 diff 的 @@ 头仍是新增色 ----
lines = patchLines("diff --git a/n.txt b/n.txt\n@@ 新文件 @@\n+hello");
assert.ok(lines[1].cls.includes("diff-add-bg"));

console.log("patch parse tests passed");
