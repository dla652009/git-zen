// safeJson.ts 安全解析自检：node --experimental-strip-types src/lib/safeJson.test.ts
import assert from "node:assert";
import { parseJson, parseJsonArray, parseJsonObject } from "./safeJson.ts";

// ---- parseJson：坏数据一律退回 fallback，绝不抛错 ----
assert.deepEqual(parseJson(null, { a: 1 }), { a: 1 }); // 没存过
assert.deepEqual(parseJson("", { a: 1 }), { a: 1 }); // 存了空串
assert.deepEqual(parseJson("not json", { a: 1 }), { a: 1 }); // 被手改坏
assert.deepEqual(parseJson("{", { a: 1 }), { a: 1 }); // 截断的 JSON
assert.deepEqual(parseJson("null", { a: 1 }), { a: 1 }); // JSON 字面量 null
assert.deepEqual(parseJson("undefined", { a: 1 }), { a: 1 }); // 字符串 "undefined" 不是合法 JSON
assert.deepEqual(parseJson("123", 0), 123); // 正常值原样返回
assert.deepEqual(parseJson('{"b":2}', { a: 1 }), { b: 2 });
assert.deepEqual(parseJson("[]", [1]), []); // 空数组合法

// 关键回归：JSON.parse("undefined") 会抛，这里必须不抛
assert.doesNotThrow(() => parseJson("undefined", null));
assert.equal(parseJson<unknown>("undefined", null), null);

// ---- parseJsonArray：形状不对退回 fallback ----
assert.deepEqual(parseJsonArray<string>('["a","b"]'), ["a", "b"]);
assert.deepEqual(parseJsonArray<string>("[]"), []);
assert.deepEqual(parseJsonArray<string>("{}"), []); // 存成对象 → 退回空数组
assert.deepEqual(parseJsonArray<string>("null"), []);
assert.deepEqual(parseJsonArray<string>("123"), []);
assert.deepEqual(parseJsonArray<string>("bad"), []);
assert.deepEqual(parseJsonArray<string>("bad", ["keep"]), ["keep"]);
// 这条是真正要防的：切成对象后 repos.value.map 会炸
assert.equal(Array.isArray(parseJsonArray<unknown>('{"path":"x"}')), true);

// ---- parseJsonObject：形状不对退回 fallback ----
const obj = { "a/b": "https://x" };
assert.deepEqual(parseJsonObject<Record<string, string>>('{"a/b":"https://x"}', {}), obj);
assert.deepEqual(parseJsonObject<Record<string, string>>("[]", {}), {}); // 数组不是对象
assert.deepEqual(parseJsonObject<Record<string, string>>("null", {}), {});
assert.deepEqual(parseJsonObject<Record<string, string>>('"str"', {}), {});
assert.deepEqual(parseJsonObject<Record<string, string>>("5", {}), {});
assert.deepEqual(parseJsonObject<Record<string, string>>("bad", { keep: "1" }), { keep: "1" });

console.log("safe json tests passed");
