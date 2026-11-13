// useDiffSearch 自检：node --experimental-strip-types src/lib/useDiffSearch.test.ts
import assert from "node:assert/strict";
import { computed, nextTick, ref } from "vue";
import { useDiffSearch } from "../composables/useDiffSearch.ts";

const root = ref<HTMLElement | null>(null);
const sections = ref([
  { file: "a", lines: [{ text: "foo" }, { text: "bar foo" }] },
  { file: "b", lines: [{ text: "foo" }] },
]);
const active = ref(0);
let switched = -1;
const s = useDiffSearch({
  sections: computed(() => sections.value),
  activeSection: computed(() => active.value),
  root,
  onHitInOtherSection: (i) => {
    switched = i;
    active.value = i;
  },
  focusBackSelector: "[data-search-toggle]",
});

// ---- 初值：未打开、无命中、游标 -1（两侧统一的语义）----
assert.equal(s.searchOpen.value, false);
assert.equal(s.cur.value, -1);
assert.equal(s.count.value, 0);
assert.equal(s.hitRow.value, -1);

// ---- 开搜索：空查询没有命中，游标仍是 -1 ----
s.toggleSearch();
assert.equal(s.searchOpen.value, true);
assert.equal(s.cur.value, -1);
await nextTick();

// ---- 输入：命中跨段连续编号，游标复位到第一个 ----
s.q.value = "foo";
await nextTick();
assert.equal(s.count.value, 3);
assert.equal(s.cur.value, 0);
assert.equal(s.hitRow.value, 0);

// ---- 同段内前进 ----
s.goTo(1);
await nextTick();
assert.equal(s.cur.value, 1);
assert.equal(s.hitRow.value, 1);

// ---- 命中在别的段：先回调切段，hitRow 换成该段内的行号 ----
s.goTo(1);
await nextTick();
assert.equal(s.cur.value, 2);
assert.equal(switched, 1);
assert.equal(active.value, 1);
assert.equal(s.hitRow.value, 0);

// ---- 环形：走完回到第一个命中 ----
s.goTo(1);
await nextTick();
assert.equal(s.cur.value, 0);
assert.equal(active.value, 0);
assert.equal(s.hitRow.value, 0);

// ---- 游标停在别的段时 hitRow 为 -1（不画高亮）----
s.cur.value = 2;
active.value = 0;
assert.equal(s.hitRow.value, -1);

// ---- 换查询：游标复位到第一个命中 ----
s.q.value = "bar";
await nextTick();
assert.equal(s.count.value, 1);
assert.equal(s.cur.value, 0);
assert.equal(s.hitRow.value, 1);

// ---- 关搜索：清空查询、游标归 -1 ----
s.closeSearch();
assert.equal(s.searchOpen.value, false);
assert.equal(s.q.value, "");
assert.equal(s.cur.value, -1);
await nextTick();

// ---- 无匹配：游标与 hitRow 都是 -1 ----
s.toggleSearch();
await nextTick();
s.q.value = "zzz";
await nextTick();
assert.equal(s.count.value, 0);
assert.equal(s.cur.value, -1);
assert.equal(s.hitRow.value, -1);

console.log("diff search composable tests passed");
