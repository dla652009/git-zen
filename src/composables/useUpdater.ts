// 自动更新：启动后静默检查 → 有新版本弹窗 → 下载安装 → 重启。
//
// 边界与取舍：
// - **只在启动时查一次**。定时轮询会让长时间开着的实例频繁打 GitHub API（无 token 时限 60 次/小时），
//   而桌面工具重启频率本来就低，启动时查一次够用。
// - **检查失败静默**。断网、GitHub 挂了、被墙，都不该在启动时糊用户一脸 —— 更新是锦上添花，
//   不是必需能力。只有用户主动点「检查更新」时才报错。
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
  /** 检查到更新但用户还没处理 —— 用来在设置页显示一个小圆点 */
  const pending = computed(
    () => (phase.value.kind === "available" && phase.value.version !== dismissed.value) || phase.value.kind === "downloading",
  );

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
    if (!isPackaged()) return;
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

  return { phase, pending, checkForUpdate, installUpdate, later, reset };
}
