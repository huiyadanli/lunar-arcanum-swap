import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBox, decodeBox } from '../src/lib/box-code.js';

const empty = { give: {}, want: [] };
const base = (over = {}) => ({ counts: Array(22).fill(0), keep: 1, wantOff: [], quick: empty, mode: 'full', ...over });

test('往返：完整 Box，无快速块', () => {
  const input = base({ counts: Array.from({ length: 22 }, (_, i) => i % 4), wantOff: [2, 5, 22], keep: 2 });
  const code = encodeBox(input);
  assert.match(code, /^[2-9A-HJ-NP-Z]+$/);
  assert.deepEqual(decodeBox(code), input);
  assert.ok(code.length <= 25, code);
});

test('往返：快速模式含给出与想要', () => {
  const input = base({ mode: 'quick', counts: Array(22).fill(1), quick: { give: { 1: 3, 7: 9 }, want: [2, 22] } });
  assert.deepEqual(decodeBox(encodeBox(input)), input);
});

test('快速块为空时省略，更短', () => {
  const a = encodeBox(base());
  const b = encodeBox(base({ quick: { give: { 1: 1 }, want: [] } }));
  assert.ok(a.length < b.length);
});

test('“不想要”为空时省略，更短', () => {
  const a = encodeBox(base());
  const b = encodeBox(base({ wantOff: [4] }));
  assert.ok(a.length < b.length);
  assert.deepEqual(decodeBox(b).wantOff, [4]);
  assert.deepEqual(decodeBox(a).wantOff, []);
});

test('最大数量 9 可用，10 被拒绝', () => {
  const input = base({ counts: Array(22).fill(9), quick: { give: Object.fromEntries(Array.from({ length: 22 }, (_, i) => [i + 1, 9])), want: [] } });
  assert.deepEqual(decodeBox(encodeBox(input)), input);
  assert.throws(() => encodeBox(base({ counts: [10, ...Array(21).fill(0)] })), /INVALID_BOX_CODE/);
});

test('忽略大小写与空白；损坏或截断的码被拒绝', () => {
  const input = base({ counts: Array(22).fill(2) });
  const code = encodeBox(input);
  assert.deepEqual(decodeBox(` ${code.slice(0, 5).toLowerCase()}\n${code.slice(5)} `), input);
  assert.throws(() => decodeBox(code.slice(0, -1)), /INVALID_BOX_CODE/);
  const flipped = code.slice(0, 3) + (code[3] === '2' ? '3' : '2') + code.slice(4);
  assert.throws(() => decodeBox(flipped), /INVALID_BOX_CODE/);
  assert.throws(() => decodeBox('0O1I'), /INVALID_BOX_CODE/);
  assert.throws(() => decodeBox(''), /INVALID_BOX_CODE/);
});

test('快速给出与想要冲突被拒绝', () => {
  assert.throws(() => encodeBox(base({ quick: { give: { 3: 1 }, want: [3] } })), /INVALID_BOX_CODE/);
});

test('CRC 必然检出任意单字符错误和相邻字符颠倒', () => {
  const samples = [
    base({ counts: Array.from({ length: 22 }, (_, i) => i % 4), wantOff: [2, 5] }),
    base({ mode: 'quick', counts: Array(22).fill(1), quick: { give: { 1: 3, 7: 9 }, want: [2, 22] } }),
    base(),
  ];
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (const input of samples) {
    const code = encodeBox(input);
    for (let i = 0; i < code.length; i++) {
      for (const c of alphabet) {
        if (c === code[i]) continue;
        assert.throws(() => decodeBox(code.slice(0, i) + c + code.slice(i + 1)), /INVALID_BOX_CODE/, `${code} @${i}=${c}`);
      }
      if (i + 1 < code.length && code[i] !== code[i + 1]) {
        const swapped = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
        assert.throws(() => decodeBox(swapped), /INVALID_BOX_CODE/, `${code} swap@${i}`);
      }
    }
  }
});
