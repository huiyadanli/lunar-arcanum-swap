// 首页卡牌展台：拖动只在确认横向手势后捕获指针，保留手机纵向滚动。
// 卡牌选择与动效档位无关；悬浮视差合并到一帧内，并在离开和销毁时清理。
import { currentTier } from './perf.js';

export function cardShowcase() {
  let gesture = null;
  let frame = 0;
  let suppressClickUntil = 0;
  let surface = null;

  return {
    activeIndex: 2,
    dragging: false,

    offset(index) {
      const count = this.fanCards.length;
      return ((index - this.activeIndex + count + Math.floor(count / 2)) % count) - Math.floor(count / 2);
    },
    select(index) {
      if (performance.now() < suppressClickUntil) return;
      this.activeIndex = index;
      this.resetLight();
    },
    step(direction) {
      this.activeIndex = (this.activeIndex + direction + this.fanCards.length) % this.fanCards.length;
      this.resetLight();
    },
    down(event) {
      if (!event.isPrimary || event.button !== 0) return;
      surface = event.currentTarget;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0 };
    },
    move(event) {
      surface = event.currentTarget;
      if (gesture && gesture.id !== event.pointerId) return;
      if (gesture) {
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        if (!this.dragging && Math.abs(dy) > Math.max(8, Math.abs(dx))) {
          gesture = null;
          this.resetLight();
          return;
        }
        if (!this.dragging && Math.abs(dx) > 8) {
          this.dragging = true;
          surface.setPointerCapture(event.pointerId);
        }
        gesture.dx = dx;
        if (this.dragging) {
          surface.style.setProperty('--drag', `${Math.max(-40, Math.min(40, dx * 0.22))}px`);
          return;
        }
      }
      if (event.pointerType === 'touch' || currentTier() !== 'high' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      cancelAnimationFrame(frame);
      const { clientX, clientY } = event;
      frame = requestAnimationFrame(() => {
        const rect = surface.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        surface.style.setProperty('--rx', `${(0.5 - y) * 12}deg`);
        surface.style.setProperty('--ry', `${(x - 0.5) * 16}deg`);
        surface.style.setProperty('--mx', `${x * 100}%`);
        surface.style.setProperty('--my', `${y * 100}%`);
      });
    },
    up(event) {
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.clientX - gesture.x;
      const moved = this.dragging;
      gesture = null;
      this.dragging = false;
      if (moved) {
        suppressClickUntil = performance.now() + 350;
        if (Math.abs(dx) >= 36) this.step(dx < 0 ? 1 : -1);
      }
      if (surface?.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      this.resetLight();
    },
    cancel() {
      const pointerId = gesture?.id;
      gesture = null;
      this.dragging = false;
      if (pointerId !== undefined && surface?.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
      this.resetLight();
    },
    leave() {
      if (!this.dragging) {
        gesture = null;
        this.resetLight();
      }
    },
    resetLight() {
      cancelAnimationFrame(frame);
      if (!surface) return;
      for (const [key, value] of Object.entries({ '--rx': '0deg', '--ry': '0deg', '--mx': '50%', '--my': '35%', '--drag': '0px' })) {
        surface.style.setProperty(key, value);
      }
    },
    destroy() {
      this.cancel();
      cancelAnimationFrame(frame);
      surface = null;
    },
  };
}
