// 纯像素识别核心：无 DOM、网络或图像库依赖，便于对真实样图做 Node 回归。
// 仅数字2使用小型二值参考；牌框、行列和角标圆环都从图片内容计算。
const CARD_COUNT = 22;
const ANGLES = Array.from({ length: 24 }, (_, i) => [Math.cos(i * Math.PI / 12), Math.sin(i * Math.PI / 12)]);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function checkImageAbort(signal) {
  if (signal?.aborted) throw new DOMException('Image recognition cancelled', 'AbortError');
}

async function checkpoint(options, progress) {
  checkImageAbort(options.signal);
  options.onProgress?.(progress);
  await new Promise((resolve) => setTimeout(resolve, 0));
  checkImageAbort(options.signal);
}

// 用每行连续前景段和并查集标记8邻域连通区域，避免给每个像素分配对象。
export function connectedImageRegions(mask, width, height) {
  const parents = [0];
  const runs = [];
  let previous = [];
  const find = (initial) => {
    let label = initial;
    while (parents[label] !== label) {
      parents[label] = parents[parents[label]];
      label = parents[label];
    }
    return label;
  };
  for (let y = 0; y < height; y++) {
    const current = [];
    let previousIndex = 0;
    for (let x = 0; x < width;) {
      if (!mask[y * width + x]) { x++; continue; }
      const left = x;
      while (x < width && mask[y * width + x]) x++;
      const right = x - 1;
      while (previousIndex < previous.length && previous[previousIndex][1] < left - 1) previousIndex++;
      const roots = [];
      for (let scan = previousIndex; scan < previous.length && previous[scan][0] <= right + 1; scan++) roots.push(find(previous[scan][2]));
      let label;
      if (roots.length) {
        label = Math.min(...roots);
        for (const root of roots) parents[find(root)] = label;
      } else {
        label = parents.length;
        parents.push(label);
      }
      current.push([left, right, label]);
      runs.push([y, left, right, label]);
    }
    previous = current;
  }
  const regions = new Map();
  for (const [y, left, right, initial] of runs) {
    const label = find(initial);
    if (!regions.has(label)) regions.set(label, [left, y, right, y, 0]);
    const box = regions.get(label);
    box[0] = Math.min(box[0], left);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], right);
    box[3] = Math.max(box[3], y);
    box[4] += right - left + 1;
  }
  return [...regions.values()].map(([x, y, right, bottom, area]) => [x, y, right - x + 1, bottom - y + 1, area]);
}

function filterMask(mask, width, height, dilate) {
  const horizontal = new Uint8Array(mask.length);
  const output = new Uint8Array(mask.length);
  const combine = dilate ? Math.max : Math.min;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) horizontal[row + x] = combine(mask[row + Math.max(0, x - 1)], mask[row + x], mask[row + Math.min(width - 1, x + 1)]);
  }
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - 1) * width;
    const row = y * width;
    const bottom = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) output[row + x] = combine(horizontal[top + x], horizontal[row + x], horizontal[bottom + x]);
  }
  return output;
}

const closeMask = (mask, width, height) => filterMask(filterMask(mask, width, height, true), width, height, false);

async function features(pixels, options) {
  const { width, height, data } = pixels;
  const size = width * height;
  const blue = new Uint8Array(size), silver = new Uint8Array(size), gray = new Uint8Array(size), neutral = new Uint8Array(size), mask = new Uint8Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x, offset = index * 4;
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      const difference = Math.max(r, g, b) - Math.min(r, g, b);
      const luminance = Math.floor((r + g + b) / 3);
      blue[index] = Number(b - r > 30 && g - r > 10 && b > 110);
      silver[index] = Number(difference < 45 && luminance > 115);
      gray[index] = luminance;
      neutral[index] = Number(difference < 75);
      mask[index] = blue[index] || silver[index];
    }
    if (y % 256 === 0) await checkpoint(options, 0.1 + 0.2 * y / height);
  }
  await checkpoint(options, 0.31);
  const dilated = filterMask(mask, width, height, true);
  await checkpoint(options, 0.35);
  return { blue, silver, gray, neutral, mask: filterMask(dilated, width, height, false) };
}

function findFrames(mask, width, height) {
  const raw = connectedImageRegions(mask, width, height).filter((box) => box[2] >= 16 && box[3] >= 40 && box[3] / box[2] > 1.6 && box[3] / box[2] < 4.4 && box[4] / (box[2] * box[3]) > 0.06);
  if (!raw.length) return [];
  let group = [], bestArea = 0;
  for (const seed of raw) {
    const candidate = raw.filter((box) => box[3] >= seed[3] * 0.72 && box[3] <= seed[3] * 1.28);
    const area = candidate.reduce((sum, box) => sum + box[2] * box[3], 0);
    if (candidate.length > group.length || (candidate.length === group.length && area > bestArea)) { group = candidate; bestArea = area; }
  }
  const selected = [];
  for (const box of group.sort((a, b) => b[2] * b[3] - a[2] * a[3])) {
    const [x, y, w, h] = box;
    if (!selected.some(([ox, oy, ow, oh]) => Math.max(0, Math.min(x + w, ox + ow) - Math.max(x, ox)) * Math.max(0, Math.min(y + h, oy + oh) - Math.max(y, oy)) / (w * h) > 0.8)) selected.push(box);
  }
  return selected;
}

function cluster(values, tolerance) {
  const groups = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = groups.at(-1);
    if (last && Math.abs(value - last.sum / last.count) <= tolerance) { last.sum += value; last.count++; }
    else groups.push({ sum: value, count: 1 });
  }
  return groups.map((group) => group.sum / group.count);
}

const nearest = (values, target) => values.reduce((best, value, i) => Math.abs(value - target) < Math.abs(values[best] - target) ? i : best, 0);

export function mapImageFrames(frames, { columns: manualColumns = null, firstId = 1, calibrated = false } = {}) {
  if (frames.length < (calibrated ? 1 : 4)) return { cards: [], grid: { identityReliable: false, detectedFrames: frames.length } };
  let columns = cluster(frames.map(([x, , w]) => x + w / 2), median(frames.map((box) => box[2])) * 0.45);
  const rows = cluster(frames.map(([, y, , h]) => y + h / 2), median(frames.map((box) => box[3])) * 0.42);
  if (Number.isInteger(manualColumns) && manualColumns >= 1 && manualColumns <= CARD_COUNT && manualColumns !== columns.length) {
    const left = columns[0], right = columns.at(-1);
    const step = manualColumns > 1 ? (right - left) / (manualColumns - 1) || median(frames.map((box) => box[2])) * 1.15 : 0;
    columns = Array.from({ length: manualColumns }, (_, i) => left + step * i);
  }
  const identityReliable = calibrated || rows.length === Math.ceil(CARD_COUNT / columns.length);
  const assigned = new Map();
  if (identityReliable) for (const box of frames) {
    const [x, y, w, h] = box;
    const id = firstId + nearest(rows, y + h / 2) * columns.length + nearest(columns, x + w / 2);
    if (id >= 1 && id <= CARD_COUNT && !assigned.has(id)) assigned.set(id, box);
  }
  return { cards: [...assigned].sort((a, b) => a[0] - b[0]).map(([id, box]) => ({ id, box })), grid: { identityReliable, columns: columns.length, rows: rows.length, detectedFrames: frames.length } };
}

function frameState(box, width, blue, silver) {
  const [x, y, w, h] = box;
  const sides = [];
  for (const [start, stop] of [[0.01, 0.14], [0.86, 0.99]]) {
    const blues = [], silvers = [];
    const top = y + Math.floor(h * 0.25), bottom = y + Math.floor(h * 0.75);
    for (let xx = x + Math.floor(w * start); xx < x + Math.floor(w * stop); xx++) {
      let b = 0, s = 0;
      for (let yy = top; yy < bottom; yy++) { b += blue[yy * width + xx]; s += silver[yy * width + xx]; }
      blues.push(b / (bottom - top)); silvers.push(s / (bottom - top));
    }
    const strongest = (values) => values.sort((a, b) => b - a).slice(0, 3).reduce((sum, n) => sum + n, 0) / Math.min(3, values.length);
    sides.push({ blue: strongest(blues), silver: strongest(silvers) });
  }
  if (sides.every((side) => side.silver >= 0.6)) return 'owned';
  if (sides.every((side) => side.blue >= 0.6 && side.silver <= 0.3)) return 'missing';
  return 'review';
}

function circleSupport(box, pixels, gray, neutral) {
  const [x, y, w, h] = box, { width, height } = pixels;
  let best = 0;
  for (let cy = y; cy < y + Math.floor(h * 0.12); cy += 3) for (let cx = x + Math.floor(w * 0.76); cx < x + Math.floor(w * 0.98); cx += 3) {
    for (let radius = Math.round(w * 0.085); radius <= Math.round(w * 0.15); radius += 2) {
      let hits = 0;
      for (const [cosine, sine] of ANGLES) {
        const ix = Math.round(cx + radius * 0.78 * cosine), iy = Math.round(cy + radius * 0.78 * sine);
        const ox = Math.round(cx + radius * 1.2 * cosine), oy = Math.round(cy + radius * 1.2 * sine);
        if (ix < 0 || ix >= width || ox < 0 || ox >= width || iy < 0 || iy >= height || oy < 0 || oy >= height) continue;
        const base = (gray[iy * width + ix] + gray[oy * width + ox]) / 2;
        for (const delta of [-0.7, 0, 0.7]) {
          const xx = Math.round(cx + (radius + delta) * cosine), yy = Math.round(cy + (radius + delta) * sine);
          if (xx >= 0 && xx < width && yy >= 0 && yy < height) {
            const index = yy * width + xx;
            if (neutral[index] && gray[index] > 90 && gray[index] - base > 18) { hits++; break; }
          }
        }
      }
      best = Math.max(best, hits / ANGLES.length);
      if (best >= 0.9) return best;
    }
  }
  return best;
}

function digitSimilarity(mask, width, box, target) {
  const [left, top, w, h] = box;
  // 与 Pillow 的实际字形裁边一致：闭运算只用于连接，形状比较仍读取原笔画。
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[(top + y) * width + left + x]) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < 0) return 0;
  const normalized = new Uint8Array(384);
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  for (let y = 0; y < 24; y++) for (let x = 0; x < 16; x++) {
    const xx = Math.min(bw - 1, Math.floor((x + 0.5) * bw / 16));
    const yy = Math.min(bh - 1, Math.floor((y + 0.5) * bh / 24));
    normalized[y * 16 + x] = mask[(top + minY + yy) * width + left + minX + xx];
  }
  let best = 0;
  const targetInk = target.reduce((sum, value) => sum + value, 0);
  for (let sy = -1; sy <= 1; sy++) for (let sx = -1; sx <= 1; sx++) {
    let ink = 0, overlap = 0;
    for (let y = 0; y < 24; y++) for (let x = 0; x < 16; x++) {
      const xx = x - sx, yy = y - sy;
      const value = xx >= 0 && xx < 16 && yy >= 0 && yy < 24 ? normalized[yy * 16 + xx] : 0;
      ink += value;
      overlap += Number(Boolean(value && target[y * 16 + x]));
    }
    best = Math.max(best, targetInk + ink ? 2 * overlap / (targetInk + ink) : 0);
  }
  return best;
}

function readQuantity(pixels, box, target, gray, neutral) {
  const [x, y, w, h] = box;
  const left = Math.max(0, x + Math.floor(w * 0.67)), top = Math.max(0, y - Math.floor(h * 0.025));
  const right = Math.min(pixels.width, x + Math.floor(w * 1.1)), bottom = Math.min(pixels.height, y + Math.floor(h * 0.15));
  const width = right - left, height = bottom - top;
  let dice = 0;
  for (const level of [170, 190, 205, 220]) {
    const mask = new Uint8Array(width * height);
    for (let yy = 0; yy < height; yy++) for (let xx = 0; xx < width; xx++) {
      const offset = ((top + yy) * pixels.width + left + xx) * 4;
      const r = pixels.data[offset], g = pixels.data[offset + 1], b = pixels.data[offset + 2];
      mask[yy * width + xx] = Number(Math.min(r, g, b) > level && Math.max(r, g, b) - Math.min(r, g, b) < 50);
    }
    for (const digit of connectedImageRegions(closeMask(mask, width, height), width, height)) {
      if (digit[3] > h * 0.025 && digit[3] < h * 0.1 && digit[2] / digit[3] > 0.35 && digit[2] / digit[3] < 1.15 && digit[4] > 8) dice = Math.max(dice, digitSimilarity(mask, width, digit, target));
    }
  }
  const ring = circleSupport(box, pixels, gray, neutral);
  // 实测：真实“2”角标 ring≥0.71、dice≥0.83；无角标牌的插画亮线可使 ring 达 0.50、dice 至 0.59。
  // “无角标”的 ring 上限取 0.6，处于两组之间，避免 0.50 的边界值被误判为待确认。
  return ring >= 0.65 && dice >= 0.78 ? 2 : ring < 0.6 && dice < 0.65 ? 1 : null;
}

export async function recognizeCardPixels(pixels, options = {}) {
  const { width, height, data } = pixels;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height * 4) throw new Error('INVALID_IMAGE_PIXELS');
  checkImageAbort(options.signal);
  const target = new Uint8Array(384);
  if (!Array.isArray(options.digitRows) || options.digitRows.length !== 24) throw new Error('INVALID_DIGIT_REFERENCE');
  for (let y = 0; y < 24; y++) {
    const bits = parseInt(options.digitRows[y], 16);
    for (let x = 0; x < 16; x++) target[y * 16 + x] = (bits >>> (15 - x)) & 1;
  }
  const maps = await features(pixels, options);
  await checkpoint(options, 0.42);
  const frames = findFrames(maps.mask, width, height);
  const mapped = mapImageFrames(frames, options);
  const counts = Array(CARD_COUNT).fill(null);
  const cards = [];
  for (let i = 0; i < mapped.cards.length; i++) {
    await checkpoint(options, 0.5 + 0.48 * i / Math.max(1, mapped.cards.length));
    const { id, box } = mapped.cards[i];
    const state = frameState(box, width, maps.blue, maps.silver);
    const count = state === 'missing' ? 0 : state === 'owned' ? readQuantity(pixels, box, target, maps.gray, maps.neutral) : null;
    counts[id - 1] = count;
    cards.push({ id, box: box.slice(0, 4), count, state, reason: count === null ? state === 'owned' ? 'unknown-badge' : 'uncertain-frame' : null });
  }
  await checkpoint(options, 1);
  return { counts, cards, frames: frames.map((box) => box.slice(0, 4)), grid: mapped.grid, workingSize: [width, height] };
}
