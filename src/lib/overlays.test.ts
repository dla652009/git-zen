// overlays.ts 浮层优先级自检：node --experimental-strip-types src/lib/overlays.test.ts
import assert from "node:assert";
import { closeTop, overlayOrder, type OverlayLayer, type OverlayName } from "./overlays.ts";

/** 造一张全关的浮层表，open 里标 true 的层算打开 */
function makeLayers(open: Partial<Record<OverlayName, boolean>> = {}, locked: OverlayName[] = []) {
  const closed: OverlayName[] = [];
  const layers = {} as Record<OverlayName, OverlayLayer>;
  for (const name of overlayOrder) {
    layers[name] = {
      open: () => open[name] === true,
      close: () => {
        closed.push(name);
        open[name] = false;
      },
      locked: locked.includes(name) ? () => true : undefined,
    };
  }
  return { layers, closed };
}

// ---- 一层都没开：什么也不做 ----
let t = makeLayers();
assert.equal(closeTop(t.layers), null);
assert.deepEqual(t.closed, []);

// ---- 每层单独打开：关掉的必须是它自己（遍历全部层，防止优先级表漏项）----
for (const name of overlayOrder) {
  t = makeLayers({ [name]: true });
  assert.equal(closeTop(t.layers), name, `单独打开 ${name} 时应关掉它自己`);
  assert.deepEqual(t.closed, [name]);
}

// ---- 多层同开：关优先级最高的那个（overlayOrder 里更靠前）----
t = makeLayers({ settings: true, folderDd: true, diff: true });
assert.equal(closeTop(t.layers), "folderDd"); // 最靠前
assert.deepEqual(t.closed, ["folderDd"]);

t = makeLayers({ settings: true, diff: true });
assert.equal(closeTop(t.layers), "settings"); // settings 在 diff 之前
assert.deepEqual(t.closed, ["settings"]);

// 相邻两层也要按表走：确认框优先于仓库切换器
t = makeLayers({ repoSwitcher: true, confirm: true });
assert.equal(closeTop(t.layers), "confirm");
assert.deepEqual(t.closed, ["confirm"]);

// ---- 优先级表本身：不能有重名（重名会让 Record 少一个键却编译通过）----
assert.equal(new Set(overlayOrder).size, overlayOrder.length, "overlayOrder 里有重复的浮层名");

// ---- locked：开着但不能关，且不穿透到下层 ----
t = makeLayers({ openRepo: true }, ["openRepo"]);
assert.equal(closeTop(t.layers), "openRepo"); // 命中它
assert.deepEqual(t.closed, []); // 但没关

// 下层也开着时仍然不穿透（克隆进行中按 Esc 不该把设置页关掉）
t = makeLayers({ openRepo: true, settings: true, diff: true }, ["openRepo"]);
assert.equal(closeTop(t.layers), "openRepo");
assert.deepEqual(t.closed, []);

// locked 只在「它是最上层」时才起作用：上层没开时照样关下层
t = makeLayers({ settings: true }, ["openRepo"]);
assert.equal(closeTop(t.layers), "settings");
assert.deepEqual(t.closed, ["settings"]);

// ---- 连按 Esc：逐层关掉，最后返回 null ----
t = makeLayers({ folderDd: true, confirm: true, settings: true });
assert.equal(closeTop(t.layers), "folderDd");
assert.equal(closeTop(t.layers), "confirm");
assert.equal(closeTop(t.layers), "settings");
assert.equal(closeTop(t.layers), null);
assert.deepEqual(t.closed, ["folderDd", "confirm", "settings"]);

console.log("overlay stack tests passed");
