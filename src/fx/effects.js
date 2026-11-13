// 小型特效集合：倾斜光泽、UID 解码、粒子迸发、月相路径、匹配揭晓动画。
// 都只动 transform / opacity（设计文档 8.1 约束），并按 data-fx 档位降级。

import { currentTier } from './perf.js';

/** Alpine 指令 x-tilt：3D 倾斜 + 全息光泽（high 倾斜 + 光泽；lite 只有光泽；off 无）。 */
export function tiltDirective(el, _dir, { cleanup }) {
  const reset = () => {
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--mx', '50%');
    el.style.setProperty('--my', '30%');
  };
  const move = (e) => {
    const tier = currentTier();
    if (tier === 'off') return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
    if (tier === 'high') {
      el.style.setProperty('--ry', `${((x - 0.5) * 18).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${((0.5 - y) * 18).toFixed(2)}deg`);
    }
  };
  reset();
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerleave', reset);
  cleanup(() => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerleave', reset);
  });
}

/** UID 解码：每一位随机滚动后依次定格（设计文档 8.1 #5）。 */
export function decodeText(el, finalText, { duration } = {}) {
  const tier = currentTier();
  if (tier === 'off') {
    el.textContent = finalText;
    return Promise.resolve();
  }
  const total = duration ?? (tier === 'high' ? 800 : 300);
  const chars = [...finalText];
  const t0 = performance.now();
  return new Promise((resolve) => {
    const tick = (t) => {
      const p = (t - t0) / total;
      el.textContent = chars
        .map((c, i) => (c === ' ' || p >= (i + 1) / chars.length ? c : String(Math.floor(Math.random() * 10))))
        .join('');
      if (p < 1) requestAnimationFrame(tick);
      else {
        el.textContent = finalText;
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
}

/** 粒子迸发（≤12 个 DOM 粒子，仅 high 档）。 */
export function burst(x, y, color = '#E9C77B', n = 12) {
  if (currentTier() !== 'high') return;
  const layer = document.getElementById('fx-layer');
  if (!layer) return;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.className = 'fx-dot';
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.background = color;
    layer.appendChild(s);
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const d = 26 + Math.random() * 30;
    s.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(.3)`, opacity: 0 },
      ],
      { duration: 520 + Math.random() * 200, easing: 'cubic-bezier(.2,.7,.3,1)' },
    ).onfinish = () => s.remove();
  }
}

/**
 * 月相路径（亮面在右，渐盈）：f ∈ [0,1] 为亮面比例。
 * 外弧：右半圆；明暗交界线：椭圆弧，rx = r·|1−2f|，f<0.5 经右侧，f>0.5 经左侧。
 */
export function moonPath(f, cx = 50, cy = 50, r = 40) {
  const k = Math.max(0, Math.min(1, f));
  if (k <= 0.001) return '';
  const rx = Math.abs(1 - 2 * k) * r;
  const sweep = k > 0.5 ? 1 : 0;
  return `M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} A ${rx.toFixed(2)} ${r} 0 0 ${sweep} ${cx} ${cy - r} Z`;
}

/**
 * 匹配揭晓（设计文档 6.5.2，约 2.2 秒，可点击或按 Escape 跳过）。
 * 双星门升起卡牌，以光桥连接；跳过时取消整段时序，不再生成后续动画。
 * root 内需包含 .rv-left .rv-right .rv-ring .rv-title .rv-connection。
 */
export function playReveal(root) {
  const tier = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : currentTier();
  if (!root || tier === 'off') return Promise.resolve();
  const left = root.querySelector('.rv-left');
  const right = root.querySelector('.rv-right');
  const ring = root.querySelector('.rv-ring');
  const title = root.querySelector('.rv-title');
  const connection = root.querySelector('.rv-connection');
  const skipButton = root.querySelector('.rv-skip');
  const previousFocus = document.activeElement;
  const anims = [];
  let cancelled = false;
  let timer = 0;
  let finishPause = () => {};
  let resolveSkip;
  const skipped = new Promise((resolve) => (resolveSkip = resolve));
  const skip = () => {
    cancelled = true;
    clearTimeout(timer);
    finishPause();
    anims.forEach((animation) => animation.cancel());
    resolveSkip();
  };
  const onKey = (event) => {
    if (['Escape', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      skip();
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      skipButton?.focus({ preventScroll: true });
    }
  };
  const onVisibility = () => { if (document.hidden) skip(); };
  const run = (el, frames, opts) => {
    if (cancelled || !el) return Promise.resolve();
    const a = el.animate(frames, { fill: 'forwards', ...opts });
    anims.push(a);
    return a.finished.catch(() => {});
  };
  const pause = (duration) => new Promise((resolve) => {
    finishPause = resolve;
    if (cancelled) resolve();
    else timer = setTimeout(resolve, duration);
  });
  root.addEventListener('click', skip);
  root.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVisibility);
  skipButton?.focus({ preventScroll: true });

  const seq = (async () => {
    run(root, [{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
    if (tier === 'lite') {
      run(left, [{ opacity: 0, transform: 'translateX(-65%) scale(.96)' }, { opacity: 1, transform: 'translateX(-65%) scale(1)' }], { duration: 250 });
      await run(right, [{ opacity: 0, transform: 'translateX(65%) scale(.96)' }, { opacity: 1, transform: 'translateX(65%) scale(1)' }], { duration: 250 });
      if (cancelled) return;
      await run(title, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
      await pause(450);
      return;
    }
    // high
    await Promise.all([left, right].map((el, i) => {
      const direction = i === 0 ? -1 : 1;
      return run(el, [
        { opacity: 0, transform: `translate(${direction * 72}%, 75%) rotateY(${direction * 45}deg) scale(.25)` },
        { opacity: .7, transform: `translate(${direction * 72}%, 8%) rotateY(${direction * 20}deg) scale(.85)`, offset: .5 },
        { opacity: 1, transform: `translate(${direction * 65}%, 0) rotate(${direction * 7}deg) scale(1)` },
      ], { duration: 850, delay: i * 100, easing: 'cubic-bezier(.16,1,.3,1)' });
    }));
    if (cancelled) return;
    run(connection, [{ opacity: 0, transform: 'translate(-50%,-50%) scaleX(0)' }, { opacity: 1, transform: 'translate(-50%,-50%) scaleX(1)' }], { duration: 440, easing: 'cubic-bezier(.2,.8,.2,1)' });
    run(ring, [{ opacity: .8, transform: 'translate(-50%,-50%) scale(.4)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(2.4)' }], { duration: 850, easing: 'ease-out' });
    await run(title, [{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 450, delay: 120, easing: 'ease-out' });
    if (cancelled) return;
    await pause(650);
  })();

  return Promise.race([seq, skipped]).finally(() => {
    cancelled = true;
    clearTimeout(timer);
    anims.forEach((animation) => animation.cancel());
    root.removeEventListener('click', skip);
    root.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  });
}
