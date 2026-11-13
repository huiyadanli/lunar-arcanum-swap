// Box 交换格式：固定魔数与版本 + 按位打包的数据 + CRC-16，转为纯大写字母。
// 牌序固定为 ID 1–22；按实际最大数量选择位宽，只有 0/1 时每张牌只占一位。
export const BOX_CODE_PREFIX = 'LASB1-';
const CARD_COUNT = 22;
const MAX_PAYLOAD_LENGTH = 67;

function invalid() {
  throw new Error('INVALID_BOX_CODE');
}

function integer(value, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) invalid();
  return value;
}

function cardIds(ids) {
  if (!Array.isArray(ids)) invalid();
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 1 || id > CARD_COUNT) invalid();
  }
  return new Set(ids);
}

function bitWidth(values) {
  const max = Math.max(0, ...values);
  return max ? max.toString(2).length : 0;
}

// 对有效数据的每一位计算 CRC-16/CCITT（初值 FFFF，多项式 1021）。
function checksum(bits) {
  let crc = 0xffff;
  for (const bit of bits) {
    const carry = (crc >>> 15) ^ Number(bit);
    crc = (crc << 1) & 0xffff;
    if (carry) crc ^= 0x1021;
  }
  return crc;
}

export function encodeBox({ counts, keep = 1, wantOff = [], quick = { give: {}, want: [] }, mode = 'full' }) {
  if (!Array.isArray(counts) || counts.length !== CARD_COUNT) invalid();
  for (const n of counts) integer(n, 99);
  integer(keep, 2);
  if (mode !== 'full' && mode !== 'quick') invalid();
  const excluded = cardIds(wantOff);
  if (!quick || !quick.give || typeof quick.give !== 'object' || Array.isArray(quick.give)) invalid();
  const wanted = cardIds(quick.want);
  const give = Array(CARD_COUNT).fill(0);
  for (const [key, quantity] of Object.entries(quick.give)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 1 || id > CARD_COUNT || String(id) !== key) invalid();
    give[id - 1] = integer(quantity, 9);
    if (quantity && wanted.has(id)) invalid();
  }

  const countWidth = bitWidth(counts);
  const giveWidth = bitWidth(give);
  let bits = '';
  const write = (value, width) => { if (width) bits += value.toString(2).padStart(width, '0'); };
  write(countWidth, 3);
  write(keep, 2);
  write(mode === 'quick' ? 1 : 0, 1);
  counts.forEach((n) => write(n, countWidth));
  counts.forEach((_, i) => write(excluded.has(i + 1) ? 1 : 0, 1));
  write(giveWidth, 3);
  give.forEach((n) => write(n, giveWidth));
  give.forEach((_, i) => write(wanted.has(i + 1) ? 1 : 0, 1));
  write(checksum(bits), 16);

  // 高位哨兵保留原始前导零；使用 BigInt 避免 22 张牌的位图被 32 位运算截断。
  let value = BigInt('0b1' + bits);
  let letters = '';
  while (value > 0n) {
    letters = String.fromCharCode(65 + Number(value % 26n)) + letters;
    value /= 26n;
  }
  return BOX_CODE_PREFIX + letters;
}

export function decodeBox(input) {
  if (typeof input !== 'string' || input.length > 512) invalid();
  const code = input.replace(/\s+/g, '').toUpperCase();
  if (!code.startsWith(BOX_CODE_PREFIX)) invalid();
  const letters = code.slice(BOX_CODE_PREFIX.length);
  if (!/^[B-Z][A-Z]*$/.test(letters) || letters.length > MAX_PAYLOAD_LENGTH) invalid();
  let value = 0n;
  for (const letter of letters) value = value * 26n + BigInt(letter.charCodeAt(0) - 65);
  const packed = value.toString(2).slice(1);
  if (packed.length < 69 || packed.length > 311) invalid();
  const bits = packed.slice(0, -16);
  if (checksum(bits) !== parseInt(packed.slice(-16), 2)) invalid();
  let offset = 0;
  const read = (width) => {
    if (!width) return 0;
    if (offset + width > bits.length) invalid();
    const n = parseInt(bits.slice(offset, offset + width), 2);
    offset += width;
    return n;
  };
  const countWidth = read(3);
  const keep = integer(read(2), 2);
  const mode = read(1) ? 'quick' : 'full';
  const counts = Array.from({ length: CARD_COUNT }, () => integer(read(countWidth), 99));
  const wantOff = [];
  for (let id = 1; id <= CARD_COUNT; id++) if (read(1)) wantOff.push(id);
  const giveWidth = integer(read(3), 4);
  const give = {};
  for (let id = 1; id <= CARD_COUNT; id++) {
    const n = integer(read(giveWidth), 9);
    if (n) give[id] = n;
  }
  const want = [];
  for (let id = 1; id <= CARD_COUNT; id++) {
    if (!read(1)) continue;
    if (give[id]) invalid();
    want.push(id);
  }
  if (offset !== bits.length || countWidth !== bitWidth(counts) || giveWidth !== bitWidth(Object.values(give))) invalid();
  return { counts, keep, wantOff, quick: { give, want }, mode };
}
