// 浮层优先级表：Esc 关闭「最上面」那个浮层。
//
// 这里原来在 App.vue 里是一条 18 行的手写 if 链，新增浮层时很容易漏加一行，
// 漏了的后果是 Esc 关不掉它、或者关错了层。改成数据驱动后：
// OverlayName 是所有浮层名的联合类型，App.vue 那边用 Record<OverlayName, OverlayLayer>
// 建表 —— 只要往 overlayOrder 里加一个名字，vue-tsc 就会要求同步补上对应的层，
// 漏了直接编译不过。优先级只有一个地方定义，不再散在 if 链的顺序里。

/** 优先级从上到下：越靠前越「上层」，Esc 先关它 */
export const overlayOrder = [
  "folderDd",
  "error",
  "confirm",
  "repoSwitcher",
  "branchSwitcher",
  "createBranch",
  "createTag",
  "openRepo",
  "releaseNotes",
  "aiReview",
  "groupManager",
  "groupModal",
  "tabRename",
  "branchRename",
  "flowConfirm",
  "flowRun",
  "settings",
  "fileHistory",
  "reflog",
  "repos",
  "diff",
] as const;

export type OverlayName = (typeof overlayOrder)[number];

export interface OverlayLayer {
  /** 当前是否打开 */
  open: () => boolean;
  /** 关闭它 */
  close: () => void;
  /** 返回 true 表示「开着但现在不能关」（例如克隆进行中的表单）；此时它挡住下层 */
  locked?: () => boolean;
}

/**
 * 关闭优先级最高的那个浮层。
 *
 * 返回被命中的浮层名（即使是「开着但不能关」的那个也返回它），一层都没开则返回 null。
 * 注意被 locked 挡下时**不会**继续往下层找 —— 开着的层就是最上层。
 */
export function closeTop(layers: Record<OverlayName, OverlayLayer>): OverlayName | null {
  for (const name of overlayOrder) {
    const layer = layers[name];
    if (!layer.open()) continue;
    if (layer.locked?.()) return name;
    layer.close();
    return name;
  }
  return null;
}
