// 全局星空背景（设计文档 8.1 #1）：Canvas 2D，≤120 颗星，限 30fps，页面不可见时暂停。
// high：闪烁 + 缓慢上漂 + 指针视差；lite：只画一帧静态星空；off：不画（纯渐变）。

import { currentTier } from './perf.js';

export function startStars(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let stars = [];
  let raf = 0;
  let last = 0;
  let px = 0;
  let py = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(120, Math.round((w * h) / 5200));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.1 + 0.25,
      phase: Math.random() * Math.PI * 2,
      speed: 0.4 + Math.random() * 1.4,
      depth: 0.2 + Math.random() * 0.8,
      gold: Math.random() < 0.14,
    }));
    draw(performance.now(), false);
  }

  function draw(t, animate) {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const tw = animate ? 0.5 + 0.5 * Math.sin((t / 1000) * s.speed + s.phase) : 0.6;
      const alpha = 0.25 + 0.75 * tw * s.depth;
      let y = s.y;
      let x = s.x;
      if (animate) {
        y = (s.y - (t * 0.004 * s.depth)) % h;
        if (y < 0) y += h;
        x += px * s.depth * 10;
        y += py * s.depth * 10;
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = s.gold ? '#F3D9A0' : '#E6ECFF';
      ctx.beginPath();
      ctx.arc(x, y, s.r, 0, Math.PI * 2);
      ctx.fill();
      if (s.r > 1.1 && tw > 0.85 && animate) {
        // 亮星的十字闪光
        ctx.globalAlpha = alpha * 0.35;
        ctx.fillRect(x - s.r * 3, y - 0.3, s.r * 6, 0.6);
        ctx.fillRect(x - 0.3, y - s.r * 3, 0.6, s.r * 6);
      }
    }
    ctx.globalAlpha = 1;
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - last < 33) return; // 30fps 上限
    last = t;
    draw(t, true);
  }

  function apply() {
    cancelAnimationFrame(raf);
    const tier = currentTier();
    canvas.hidden = tier === 'off';
    if (tier === 'high' && document.visibilityState === 'visible') raf = requestAnimationFrame(loop);
    else if (tier === 'lite') draw(0, false);
  }

  window.addEventListener('resize', () => {
    resize();
    apply();
  });
  document.addEventListener('visibilitychange', apply);
  window.addEventListener('pointermove', (e) => {
    px = e.clientX / w - 0.5;
    py = e.clientY / h - 0.5;
  }, { passive: true });

  resize();
  apply();
  return { refresh: apply };
}
