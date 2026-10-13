// diff 内搜索自检：node --experimental-strip-types src/lib/diffSearch.test.ts
import assert from "node:assert/strict";
import { searchSections } from "./diffSearch.ts";

const sec = (file: string, ...lines: string[]) => ({ file, lines: lines.map((text) => ({ text })) });

// ---- 空查询：count 0、rows 为空（组件据此走纯文本渲染）----
// 注意「只有空白」也算空查询（query.trim()），这是有意的：空格当搜索词只会命中每一行
{
  for (const q of ["", "   ", "\t"]) {
    const r = searchSections([sec("a", "foo")], q);
    assert.equal(r.count, 0, `空白查询不该有命中：${JSON.stringify(q)}`);
    assert.equal(r.hits.length, 0);
    assert.equal(r.sections.length, 1, "段数要跟输入对齐，否则按下标取会越界");
    assert.deepEqual(r.sections[0]!.rows, []);
  }
}

// ---- 同行多次命中 + 全局序号 + 不重叠 ----
{
  const r = searchSections([sec("a", "a foo b foo")], "foo");
  assert.equal(r.count, 2);
  assert.deepEqual(r.sections[0]!.hits, [
    { row: 0, start: 2, end: 5 },
    { row: 0, start: 8, end: 11 },
  ]);
  assert.deepEqual(r.hits, [
    { section: 0, row: 0, at: 0 },
    { section: 0, row: 0, at: 1 },
  ]);
  // 'aa' 在 'aaaa' 里是两处，不是三处（不重叠）
  assert.equal(searchSections([sec("a", "aaaa")], "aa").count, 2);
}

// ---- 大小写不敏感 ----
{
  const r = searchSections([sec("a", "Foo BAR")], "foo bar");
  assert.equal(r.count, 1);
  assert.deepEqual(r.sections[0]!.hits, [{ row: 0, start: 0, end: 7 }]);
}

// ---- 跨段顺序：at 按「段 → 行 → 列」连续编号 ----
{
  const r = searchSections([sec("a", "x", "hit"), sec("b", "hit hit")], "hit");
  assert.equal(r.count, 3);
  assert.deepEqual(r.hits, [
    { section: 0, row: 1, at: 0 },
    { section: 1, row: 0, at: 1 },
    { section: 1, row: 0, at: 2 },
  ]);
}

// ---- 关键不变量：每行的片段拼回来必须等于原文（拼不回就是下标算错了）----
{
  const lines = ["a foo b foo", "", "  spaces  ", "尾部命中 foo", "foo"];
  for (const q of ["o", "foo", "zzz", "space"]) {
    const r = searchSections([sec("a", ...lines)], q);
    const rows = r.sections[0]!.rows;
    assert.equal(rows.length, lines.length);
    lines.forEach((t, i) => {
      assert.equal(rows[i]!.map((g) => g.t).join(""), t || " ", `拼接失败 q=${JSON.stringify(q)} line=${i}`);
    });
  }
}

// ---- 空行给一个空格片段（保证行高不塌）----
{
  const r = searchSections([sec("a", "", "foo")], "foo");
  assert.deepEqual(r.sections[0]!.rows[0], [{ t: " ", hit: false, at: -1 }]);
}

// ---- 命中贴到行尾时不留空尾巴，也不多一段 ----
{
  const r = searchSections([sec("a", "end foo")], "foo");
  assert.deepEqual(r.sections[0]!.rows[0], [
    { t: "end ", hit: false, at: -1 },
    { t: "foo", hit: true, at: 0 },
  ]);
}

// ---- 大小写折叠会改变长度时（'İ' 折成两个码元）退回大小写敏感，索引仍必须正确 ----
{
  const text = "İİ foo";
  const r = searchSections([sec("a", text)], "İ");
  assert.equal(r.count, 2, "每个 İ 各算一次命中");
  assert.deepEqual(r.sections[0]!.hits, [
    { row: 0, start: 0, end: 1 },
    { row: 0, start: 1, end: 2 },
  ]);
  assert.equal(r.sections[0]!.rows[0]!.map((g) => g.t).join(""), text);
}

// ---- 命中片段带正确的 at，非命中片段恒为 -1 ----
{
  const r = searchSections([sec("a", "x foo y foo z")], "foo");
  const segs = r.sections[0]!.rows[0]!;
  assert.deepEqual(segs.map((g) => [g.t, g.at]), [
    ["x ", -1],
    ["foo", 0],
    [" y ", -1],
    ["foo", 1],
    [" z", -1],
  ]);
}

console.log("diff search tests passed");
