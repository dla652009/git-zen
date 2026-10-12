// localStorage 里存的是 JSON，读的时候不能假设它一定是好的。
//
// 原来有多处直接 `JSON.parse(localStorage.getItem(...))`，其中几处在 App.vue 的
// setup 期间同步执行 —— 一旦存的内容被手改坏、或旧版本写过不同形状的数据，
// parse 抛错就直接白屏，用户连设置入口都点不到。这里统一退回默认值。
//
// 形状也做一层最小校验：`gz.repos` 若被存成对象而不是数组，
// 后面 `repos.value.map(...)` 一样会炸。

/** 解析失败、空串、null/undefined 一律返回 fallback */
export function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === "") return fallback;
  try {
    const v = JSON.parse(raw) as T | null | undefined;
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 必须是数组，否则退回 fallback（空数组合法，照收） */
export function parseJsonArray<T>(raw: string | null, fallback: T[] = []): T[] {
  const v = parseJson<unknown>(raw, null);
  return Array.isArray(v) ? (v as T[]) : fallback;
}

/** 必须是普通对象（非 null、非数组），否则退回 fallback */
export function parseJsonObject<T extends object>(raw: string | null, fallback: T): T {
  const v = parseJson<unknown>(raw, null);
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as T) : fallback;
}

function store(): Storage | null {
  try {
    // 隐私模式 / 禁用存储时，访问 localStorage 本身就可能抛
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readJson<T>(key: string, fallback: T): T {
  return parseJson(store()?.getItem(key) ?? null, fallback);
}

export function readJsonArray<T>(key: string, fallback: T[] = []): T[] {
  return parseJsonArray(store()?.getItem(key) ?? null, fallback);
}

export function readJsonObject<T extends object>(key: string, fallback: T): T {
  return parseJsonObject(store()?.getItem(key) ?? null, fallback);
}
