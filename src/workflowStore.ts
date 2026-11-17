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
  return Array.isArray(list) ? dropLegacyFields(list as Workflow[]) : seedWorkflows();
}

/**
 * 剥掉已经不在数据模型里的字段。
 * `skipIfMissing` 曾经是删除步骤的配置项，现在语义写死成「不存在就跳过」；
 * 老配置里留着它不影响执行（执行器不再读），但会跟着「导出」跑到别人的文件里，
 * 让人以为那是个还能配的东西。
 */
function dropLegacyFields(list: Workflow[]): Workflow[] {
  for (const wf of list) {
    for (const s of wf.steps) {
      if (s.kind === "deleteBranch" || s.kind === "deleteRemoteBranch") {
        delete (s as { skipIfMissing?: boolean }).skipIfMissing;
      }
    }
  }
  return list;
}

export const workflows = reactive<Workflow[]>(load());

watch(
  workflows,
  () => localStorage.setItem(KEY, JSON.stringify(workflows)),
  { deep: true },
);
