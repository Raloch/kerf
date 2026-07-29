/**
 * 首页卡片的封面帧：第一个视频片段的首帧（D37）。
 *
 * **会话内内存缓存，不落盘**：持久缓存需要一套失效判据（素材换了、第一个片段挪了
 * 怎么办），等真在移动端多项目卡了再说。缓存键除了项目 id 还带着"抽的是哪个素材的
 * 哪一帧"——项目被编辑后第一个片段变了，回到首页自然重抽，不会挂着旧画面。
 *
 * 抽帧优先吃**已有的代理缓存**（720p 足够、解得快），没有代理才读原片——封面只抽
 * 一帧，原片慢也只慢这一张卡，而且是卡片各自异步填，不挡首屏（D37）。
 *
 * "抽不出来"**不构成离线的证据**：还可能是解码失败。离线由 `isReadable`（真读一个
 * 字节）判，两个读数分开填在卡片上，见 `Home.tsx`。
 */

import type { PosterTarget } from "../state/project-snapshot";
import { readSourceFile } from "../state/project-store";
import { proxyKey, readProxy } from "./proxy";

interface PosterEntry {
  /** 抽的是哪个素材的哪一帧。目标变了（换了首片段/裁了入点）就重抽。 */
  readonly key: string;
  readonly bitmap: ImageBitmap | null;
}

const cache = new Map<string, PosterEntry>();
const inflight = new Map<string, Promise<ImageBitmap | null>>();

function targetKey(target: PosterTarget): string {
  return `${target.source.id}:${target.sourceIn}`;
}

/**
 * 取（或抽）一个项目的封面。返回 null = 抽不出来（没有文件 / 解码失败），
 * 卡片退回类型图标。并发调用共享同一次抽帧。
 */
export async function loadPoster(
  projectId: string,
  target: PosterTarget,
): Promise<ImageBitmap | null> {
  const key = targetKey(target);
  const hit = cache.get(projectId);
  if (hit && hit.key === key) return hit.bitmap;
  const pending = inflight.get(projectId);
  if (pending) return pending;

  const task = extract(target)
    .then((bitmap) => {
      cache.set(projectId, { key, bitmap });
      return bitmap;
    })
    .finally(() => {
      inflight.delete(projectId);
    });
  inflight.set(projectId, task);
  return task;
}

async function extract(target: PosterTarget): Promise<ImageBitmap | null> {
  const meta = target.source;
  const proxy = await readProxy(proxyKey(meta.name, meta.width, meta.height, meta.durationFrames));
  const file = proxy ?? (await readSourceFile(meta.id));
  if (!file) return null;
  const { extractPoster } = await import("./thumbnail-extract");
  // 浮点秒只出现在喂 mediabunny 的这一行；取帧中点，同"预览 seek 要落在帧中点"
  const seconds = ((target.sourceIn + 0.5) * meta.fps.den) / meta.fps.num;
  return extractPoster(file, seconds);
}

/**
 * 开发期挂全局。模块级单例都要这么做（CLAUDE.md：`import('/src/xxx.ts')` 在控制台
 * 会因 HMR URL 带参数拿到另一个实例，这个坑已经踩过三次）。
 */
if (import.meta.env.DEV) {
  (globalThis as typeof globalThis & { __kerfPosters?: typeof cache }).__kerfPosters = cache;
}
