import digitReference from '../../assets/recognition/miyoushe-flexible/digit-two.json';
import { checkImageAbort, recognizeCardPixels } from './miyoushe-recognition.js';

// 文件、解码图像和Canvas只由此会话持有；关闭抽屉后统一释放，不进入业务快照。
export async function openImageImportSource(file, { signal } = {}) {
  checkImageAbort(signal);
  const url = URL.createObjectURL(file);
  let image = null;
  try {
    if (typeof createImageBitmap === 'function') {
      try { image = await createImageBitmap(file); }
      catch (error) { checkImageAbort(signal); /* 某些WebView不支持此解码接口，继续走原生Image。 */ }
    }
    if (!image) image = await new Promise((resolve, reject) => {
      const fallback = new Image();
      const cleanup = () => { fallback.onload = null; fallback.onerror = null; signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); fallback.src = ''; reject(new DOMException('Image loading cancelled', 'AbortError')); };
      fallback.onload = () => { cleanup(); resolve(fallback); };
      fallback.onerror = () => { cleanup(); reject(new Error('IMAGE_DECODE_FAILED')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else fallback.src = url;
    });
    checkImageAbort(signal);
  } catch (error) {
    image?.close?.();
    URL.revokeObjectURL(url);
    throw error;
  }
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  let disposed = false;
  return {
    url, width: sourceWidth, height: sourceHeight,
    async recognize({ crop, ...options } = {}) {
      if (disposed) throw new DOMException('Image source closed', 'AbortError');
      checkImageAbort(options.signal);
      const region = crop || { x: 0, y: 0, width: 1, height: 1 };
      const sx = Math.max(0, Math.min(sourceWidth - 1, region.x * sourceWidth));
      const sy = Math.max(0, Math.min(sourceHeight - 1, region.y * sourceHeight));
      const sw = Math.max(1, Math.min(sourceWidth - sx, region.width * sourceWidth));
      const sh = Math.max(1, Math.min(sourceHeight - sy, region.height * sourceHeight));
      // 工作尺寸是计算预算，不是输入白名单；极长图片降低工作宽度以控制内存。
      const width = Math.max(1, Math.min(540, Math.floor(Math.sqrt(4_000_000 * sw / sh))));
      const height = Math.max(1, Math.round(sh * width / sw));
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
        if (!ctx) throw new Error('IMAGE_CANVAS_UNAVAILABLE');
        ctx.fillStyle = '#171c31'; ctx.fillRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, width, height);
        const pixels = ctx.getImageData(0, 0, width, height);
        const result = await recognizeCardPixels(pixels, { ...options, digitRows: digitReference.rows });
        const sourceRect = ([x, y, w, h]) => [
          (sx + x * sw / width) / sourceWidth,
          (sy + y * sh / height) / sourceHeight,
          w * sw / width / sourceWidth,
          h * sh / height / sourceHeight,
        ];
        return { ...result, cards: result.cards.map((card) => ({ ...card, sourceRect: sourceRect(card.box) })), frames: result.frames.map(sourceRect) };
      } finally {
        canvas.width = 0; canvas.height = 0;
      }
    },
    thumbnail(rect) {
      if (disposed) return null;
      const [x, y, w, h] = rect;
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = Math.max(1, Math.round(h * sourceHeight * 160 / (w * sourceWidth)));
      try {
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return null;
        ctx.drawImage(image, x * sourceWidth, y * sourceHeight, w * sourceWidth, h * sourceHeight, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.85);
      } finally { canvas.width = 0; canvas.height = 0; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      image.close?.();
      if (image instanceof HTMLImageElement) image.src = '';
      URL.revokeObjectURL(url);
      image = null;
    },
  };
}
