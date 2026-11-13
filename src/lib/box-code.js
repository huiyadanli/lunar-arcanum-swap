// Box 交换格式 v1：无前缀；按位打包（含 2 位版本号）+ CRC-10，转为 32 字符的无歧义字母表。
// 牌序固定为 ID 1–22；按实际最大数量选择位宽；快速交换块、“不想要”位图为空时整块省略。
const CARD_COUNT = 22;
const MAX_COUNT = 9;
const VERSION = 0;
// 去掉易混淆的 0/O、1/I，共 32 个字符，每个字符 5 位。
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
// CRC-10（ATM，多项式 x^10+x^9+x^5+x^4+x+1）：能检出长度不超过 10 位的突发错误，
// 即任意单个字符写错、任意相邻两个字符颠倒（各 5 位，共 10 位）都必然被发现。
const CRC_BITS = 10;
const CRC_POLY = 0x233;
const CRC_MASK = (1 << CRC_BITS) - 1;
const MIN_BITS = 20;
const MAX_BITS = 243;
const MAX_CODE_LENGTH = Math.ceil((MAX_BITS + 1) / 5);

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

// 对有效数据的每一位计算 CRC-10（初值 3FF，不反转、无末尾异或）。
function checksum(bits) {
  let crc = CRC_MASK;
  for (const bit of bits) {
    const carry = (crc >>> (CRC_BITS - 1)) ^ Number(bit);
    crc = (crc << 1) & CRC_MASK;
    if (carry) crc ^= CRC_POLY;
  }
  return crc;
}

export function encodeBox({ counts, keep = 1, wantOff = [], quick = { give: {}, want: [] }, mode = 'full' }) {
  if (!Array.isArray(counts) || counts.length !== CARD_COUNT) invalid();
  for (const n of counts) integer(n, MAX_COUNT);
  integer(keep, 2);
  if (mode !== 'full' && mode !== 'quick') invalid();
  const excluded = cardIds(wantOff);
  if (!quick || !quick.give || typeof quick.give !== 'object' || Array.isArray(quick.give)) invalid();
  const wanted = cardIds(quick.want);
  const give = Array(CARD_COUNT).fill(0);
  for (const [key, quantity] of Object.entries(quick.give)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 1 || id > CARD_COUNT || String(id) !== key) invalid();
    give[id - 1] = integer(quantity, MAX_COUNT);
    if (quantity && wanted.has(id)) invalid();
  }
  const hasQuick = wanted.size > 0 || give.some(Boolean);
  const hasWantOff = excluded.size > 0;

  const countWidth = bitWidth(counts);
  let bits = '';
  const write = (value, width) => { if (width) bits += value.toString(2).padStart(width, '0'); };
  write(VERSION, 2);
  write(hasQuick ? 1 : 0, 1);
  write(hasWantOff ? 1 : 0, 1);
  write(mode === 'quick' ? 1 : 0, 1);
  write(keep, 2);
  write(countWidth, 3);
  counts.forEach((n) => write(n, countWidth));
  if (hasWantOff) counts.forEach((_, i) => write(excluded.has(i + 1) ? 1 : 0, 1));
  if (hasQuick) {
    const giveWidth = bitWidth(give);
    write(giveWidth, 3);
    give.forEach((n) => write(n, giveWidth));
    give.forEach((_, i) => write(wanted.has(i + 1) ? 1 : 0, 1));
  }
  write(checksum(bits), CRC_BITS);

  // 高位哨兵保留原始前导零；使用 BigInt 避免位图被 32 位运算截断。
  let value = BigInt('0b1' + bits);
  let code = '';
  while (value > 0n) {
    code = ALPHABET[Number(value & 31n)] + code;
    value >>= 5n;
  }
  return code;
}

export function decodeBox(input) {
  if (typeof input !== 'string' || input.length > 512) invalid();
  const code = input.replace(/\s+/g, '').toUpperCase();
  if (code.length > MAX_CODE_LENGTH || code[0] === ALPHABET[0]) invalid();
  let value = 0n;
  for (const char of code) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) invalid();
    value = (value << 5n) | BigInt(digit);
  }
  const packed = value.toString(2).slice(1);
  if (packed.length < MIN_BITS || packed.length > MAX_BITS) invalid();
  const bits = packed.slice(0, -CRC_BITS);
  if (checksum(bits) !== parseInt(packed.slice(-CRC_BITS), 2)) invalid();
  let offset = 0;
  const read = (width) => {
    if (!width) return 0;
    if (offset + width > bits.length) invalid();
    const n = parseInt(bits.slice(offset, offset + width), 2);
    offset += width;
    return n;
  };
  if (read(2) !== VERSION) invalid();
  const hasQuick = read(1) === 1;
  const hasWantOff = read(1) === 1;
  const mode = read(1) ? 'quick' : 'full';
  const keep = integer(read(2), 2);
  const countWidth = integer(read(3), 4);
  const counts = Array.from({ length: CARD_COUNT }, () => integer(read(countWidth), MAX_COUNT));
  const wantOff = [];
  if (hasWantOff) {
    for (let id = 1; id <= CARD_COUNT; id++) if (read(1)) wantOff.push(id);
    if (!wantOff.length) invalid();
  }
  const give = {};
  const want = [];
  let giveWidth = 0;
  if (hasQuick) {
    giveWidth = integer(read(3), 4);
    for (let id = 1; id <= CARD_COUNT; id++) {
      const n = integer(read(giveWidth), MAX_COUNT);
      if (n) give[id] = n;
    }
    for (let id = 1; id <= CARD_COUNT; id++) {
      if (!read(1)) continue;
      if (give[id]) invalid();
      want.push(id);
    }
    if (!want.length && !Object.keys(give).length) invalid();
  }
  if (offset !== bits.length || countWidth !== bitWidth(counts) || giveWidth !== bitWidth(Object.values(give))) invalid();
  return { counts, keep, wantOff, quick: { give, want }, mode };
}
