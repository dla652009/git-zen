// 仓库数据的 LRU 缓存：切回最近访问的仓库时先用缓存秒开，再后台刷新。
// 容量是设置项（设置 → 性能），调小时立即淘汰最旧的，不用等下次写入。

import { watch } from "vue";
import { settings } from "../settings";
import type { Branch, LogEntry, Status, TagEntry } from "../gitApi";

export interface RepoCache {
  status: Status;
  commits: LogEntry[];
  branchList: Branch[];
  tags: TagEntry[];
}

export function useRepoCache() {
  const repoCache = new Map<string, RepoCache>();

  // 容量下限 1，兜底脏数据（localStorage 里被手改成非数字等）
  function cacheCapacity(): number {
    return Math.max(1, Math.floor(settings.repoCacheSize) || 5);
  }

  function cacheGet(path: string): RepoCache | null {
    const c = repoCache.get(path);
    if (!c) return null;
    // 触摸保 LRU 顺序
    repoCache.delete(path);
    repoCache.set(path, c);
    return c;
  }

  function cachePut(path: string, data: RepoCache) {
    repoCache.delete(path);
    repoCache.set(path, data);
    while (repoCache.size > cacheCapacity()) {
      repoCache.delete(repoCache.keys().next().value!);
    }
  }

  // 不触碰 LRU 顺序的读：刷新流程里只是顺手看一眼有没有缓存，不该因此改变淘汰次序
  function cachePeek(path: string): RepoCache | undefined {
    return repoCache.get(path);
  }

  function cacheDrop(path: string) {
    repoCache.delete(path);
  }

  // 调小容量时立即淘汰最旧的，不用等下次写入
  watch(
    () => settings.repoCacheSize,
    () => {
      while (repoCache.size > cacheCapacity()) {
        repoCache.delete(repoCache.keys().next().value!);
      }
    },
  );

  return { cacheGet, cachePeek, cachePut, cacheDrop };
}
