// 图片只包含数量；不覆盖保留数、想要标记或身份信息，但会按新盒子重建快速交换内容。
export function parseImageCount(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 99 ? count : null;
}

export function createImageBoxPatch(counts, activeMatches = [], { keep = 1, wantOff = [] } = {}) {
  if (activeMatches.length) throw new Error('IMAGE_IMPORT_LOCKED');
  if (!Array.isArray(counts) || counts.length !== 22 || Array.from(counts).some((value) => typeof value !== 'number' || parseImageCount(value) === null)) throw new Error('IMAGE_IMPORT_UNCONFIRMED');
  // 盒子决定交换内容：快速交换的送出/想要整体由新盒子推导并替换（送出上限 9）。
  const give = {};
  const want = [];
  counts.forEach((n, i) => {
    const id = i + 1;
    if (n - keep > 0) give[id] = Math.min(9, n - keep);
    else if (n === 0 && !wantOff.includes(id)) want.push(id);
  });
  return { counts: [...counts], quick: { give, want }, mode: 'full', batch: false, filter: 'all', onboardHint: null };
}
