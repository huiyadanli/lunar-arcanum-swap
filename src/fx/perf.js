// 特效分级（设计文档 8.2）：high = 华丽，lite = 流畅，off = 关闭。

export function sampleFps(ms = 1000) {
  return new Promise((resolve) => {
    let frames = 0;
    const t0 = performance.now();
    const tick = (t) => {
      frames++;
      if (t - t0 < ms) requestAnimationFrame(tick);
      else resolve((frames * 1000) / (t - t0));
    };
    requestAnimationFrame(tick);
  });
}

/** 首次进入时的自动判定，结果由调用方缓存。 */
export async function detectTier() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'off';
  const mem = navigator.deviceMemory;
  const cores = navigator.hardwareConcurrency;
  if ((mem && mem <= 2) || (cores && cores <= 4)) return 'lite';
  const fps = await sampleFps(1000);
  return fps < 45 ? 'lite' : 'high';
}

/** 运行中连续 3 秒低于 30fps 时回调（只在页面可见时计数）。返回停止函数。 */
export function watchLowFps(onLow) {
  let frames = 0;
  let last = performance.now();
  let lowSeconds = 0;
  let raf = 0;
  let stopped = false;
  const tick = (t) => {
    frames++;
    if (t - last >= 1000) {
      const fps = (frames * 1000) / (t - last);
      frames = 0;
      last = t;
      if (document.visibilityState === 'visible') {
        lowSeconds = fps < 30 ? lowSeconds + 1 : 0;
        if (lowSeconds >= 3) {
          lowSeconds = 0;
          onLow();
        }
      }
    }
    if (!stopped) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}

export const currentTier = () => document.documentElement.dataset.fx || 'high';
