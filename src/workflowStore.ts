// 工作流配置的共享 store（settings 同款模式）：App 负责执行，设置页负责管理，
// 两边读写同一份 reactive 数据，持久化在这里统一做
import { reactive, watch } from "vue";
import { parseJson } from "./lib/safeJson";
import { seedWorkflows, type Workflow } from "./workflow";

const KEY = "gz.workflows";

/** 取原始字符串：隐私模式/禁用存储时 getItem 本身会抛，一律当作「没有数据」 */
function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// 没有数据（首次运行）或数据坏了 → 重新种子；
// 注意用户主动删光工作流时存的是 "[]"，必须原样保持空数组，不能又长回来。
// 另外形状也要真的是数组：存成对象时 reactive<Workflow[]>(obj) 后面到处读 .length 会炸。
function load(): Workflow[] {
  const raw = readRaw();
  if (raw === null || raw === "") return seedWorkflows();
  const list = parseJson<unknown>(raw, null);
  return Array.isArray(list) ? (list as Workflow[]) : seedWorkflows();
}

export const workflows = reactive<Workflow[]>(load());

watch(
  workflows,
  () => localStorage.setItem(KEY, JSON.stringify(workflows)),
  { deep: true },
);
