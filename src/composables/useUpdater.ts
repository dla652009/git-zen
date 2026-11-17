// 自动更新：启动时静默检查 → 之后定时复查 → 有新版本弹窗 → 下载安装 → 重启。
//
// 边界与取舍：
// - **定时复查间隔 6 小时**。GitHub API 匿名限 60 次/小时，轮询太密会被限流；
//   而 6 小时内发两个版本的情况极少，这个间隔已经能覆盖「挂着不动一整天」的场景。
//   定时器用 setTimeout 递归而不是 setInterval：一次检查卡住（慢网）时不会堆出多次并发。
// - **检查失败静默**。断网、GitHub 挂了、被墙，都不该糊用户一脸 —— 更新是锦上添花，
//   不是必需能力。只有用户主动点「检查更新」时才报错。
// - **有未处理的新版本就不再查**。用户已经看到提示了，重复查只会刷日志。
// - **下载进度要能看见**。安装包 4MB 左右，慢网下几秒到几十秒，没反馈会被当成卡死。
// - 只在打包产物里跑：dev 模式下没有签名配置，check() 会直接报错，白刷一次错误。

import { computed, ref } from "vue";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

export type UpdaterPhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes: string; date?: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  /** 手动检查后确认没有新版本 */
  | { kind: "latest"; version: string }
  | { kind: "error"; message: string };

export function useUpdater() {
  const phase = ref<UpdaterPhase>({ kind: "idle" });
  // 用户延后过的版本号：本次运行不再打扰（重启后会再问一次，那是新机会）
  const dismissed = ref("");
  /**
   * 待安装的版本号（'' = 没有）。设置页据此显示徽标与「安装」按钮。
   * 下载中也算「待安装」——那时按钮该显示进度而不是重新查一次。
   */
  const availableVersion = computed(() => {
    const p = phase.value;
    if (p.kind === "available" || p.kind === "downloading") return p.version;
    return "";
  });

  let pendingUpdate: Update | null = null;

  /** dev 模式下没有签名配置，check() 必然失败，直接跳过 */
  function isPackaged(): boolean {
    return !(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  }

  /**
   * 检查更新。
   * @param silent true = 自动检查（失败不打扰）；false = 用户主动点（失败要报出来）
   */
  async function checkForUpdate(silent = true): Promise<void> {
    if (!isPackaged()) {
      // 手动检查时要解释为什么查不了，否则按钮看起来是坏的
      if (!silent) {
        phase.value = { kind: "error", message: "开发模式下不检查更新（请在打包后的版本中使用）" };
      }
      return;
    }
    // 已经在下载/等待就不要再开一次：重复 check 会覆盖 pendingUpdate，install 时对不上
    if (phase.value.kind === "downloading" || phase.value.kind === "available") return;
    phase.value = { kind: "checking" };
    try {
      const found = await check();
      if (!found) {
        // 手动检查要给明确回执，否则点了没反应；静默检查就当无事发生
        phase.value = silent ? { kind: "idle" } : { kind: "latest", version: await getVersion() };
        return;
      }
      pendingUpdate = found;
      phase.value = {
        kind: "available",
        version: found.version,
        notes: (found.body ?? "").trim(),
        date: found.date,
      };
    } catch (e) {
      pendingUpdate = null;
      // 静默检查失败就当没发生过：断网/被墙不该在启动时弹错误框
      phase.value = silent ? { kind: "idle" } : { kind: "error", message: String(e) };
    }
  }

  /** 下载并安装，装完重启。进度按已下载字节 / 总字节算 */
  async function installUpdate(): Promise<void> {
    const upd = pendingUpdate;
    if (!upd) return;
    const version = upd.version;
    phase.value = { kind: "downloading", version, percent: 0 };
    try {
      let total = 0;
      let got = 0;
      await upd.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
        } else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          // 总长度未知时给个「不确定进度」的形态（percent = -1），别显示一个假的 0%
          phase.value = {
            kind: "downloading",
            version,
            percent: total > 0 ? Math.min(99, Math.round((got / total) * 100)) : -1,
          };
        }
      });
      phase.value = { kind: "ready", version };
      await relaunch();
    } catch (e) {
      phase.value = { kind: "error", message: String(e) };
    }
  }

  /** 本次运行不再提示这个版本 */
  function later() {
    if (phase.value.kind === "available") dismissed.value = phase.value.version;
    phase.value = { kind: "idle" };
  }

  function reset() {
    phase.value = { kind: "idle" };
  }

  // ---- 定时复查 ----
  /** 6 小时。GitHub 匿名 API 限 60 次/小时，这个间隔连限流的边都摸不到 */
  const RECHECK_MS = 6 * 60 * 60 * 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      // 已经有待处理的新版本 / 正在下载：不打扰，跳过这一轮
      const busy =
        phase.value.kind === "available" ||
        phase.value.kind === "downloading" ||
        phase.value.kind === "ready";
      if (!busy) await checkForUpdate(true);
      scheduleNext();
    }, RECHECK_MS);
  }

  /** 启动时调一次：先查，再挂上定时器 */
  function start() {
    if (!isPackaged()) return;
    void checkForUpdate(true);
    scheduleNext();
  }

  /** 组件卸载时停掉，避免定时器在已销毁的实例上继续跑 */
  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { phase, availableVersion, checkForUpdate, installUpdate, later, reset, start, stop };
}
