// 工作流配置的共享 store（settings 同款模式）：App 负责执行，设置页负责管理，
// 两边读写同一份 reactive 数据，持久化在这里统一做
import { reactive, watch } from "vue";
import { seedWorkflows, type Workflow } from "./workflow";

function load(): Workflow[] {
  try {
    const raw = localStorage.getItem("gz.workflows");
    if (raw) return JSON.parse(raw) as Workflow[];
  } catch {
    /* 存储损坏则重新种子 */
  }
  return seedWorkflows();
}

export const workflows = reactive<Workflow[]>(load());

watch(
  workflows,
  () => localStorage.setItem("gz.workflows", JSON.stringify(workflows)),
  { deep: true },
);
