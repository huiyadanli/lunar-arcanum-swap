import test from 'node:test';
import assert from 'node:assert/strict';
import { getNamecardSelection, hasNamecardSelection } from '../src/lib/namecard-selection.js';

test('快速交换的名片保留已选择且正在交换的给出和想要卡牌', () => {
  const selection = getNamecardSelection({
    mode: 'quick', quick: { give: { 17: 2 }, want: [18] },
    matches: [{ status: 'matched', pairs: [{ give: 17, get: 18 }] }],
  });
  assert.deepEqual(selection, { give: { 17: 2 }, want: [18] });
  assert.equal(hasNamecardSelection(selection), true);
});

test('给出和想要必须都有选择，单侧或全空都不能生成', () => {
  for (const quick of [{ give: { 17: 1 }, want: [] }, { give: {}, want: [18] }, { give: {}, want: [] }, { give: { 17: 0 }, want: [18] }]) {
    assert.equal(hasNamecardSelection(getNamecardSelection({ mode: 'quick', quick })), false);
  }
  assert.equal(hasNamecardSelection(null), false);
});

test('名片使用选牌快照，后续编辑不会修改已生成的需求', () => {
  const quick = { give: { 17: 2 }, want: [18] };
  const selection = getNamecardSelection({ mode: 'quick', quick });
  quick.give[17] = 3;
  quick.want.push(21);
  assert.deepEqual(selection, { give: { 17: 2 }, want: [18] });
});

test('完整 Box 按保留张数计算，名片不扣除交换中的卡牌，并尊重想要开关', () => {
  const counts = Array(22).fill(1);
  counts[16] = 3;
  counts[17] = 0;
  counts[20] = 0;
  const selection = getNamecardSelection({
    mode: 'full', counts, keep: 1, wantOff: [21],
    quick: { give: { 1: 9 }, want: [2] },
    matches: [{ status: 'confirming', pairs: [{ give: 17, get: 18 }] }],
  });
  assert.deepEqual(selection, { give: { 17: 2 }, want: [18] });
  assert.equal(hasNamecardSelection(selection), true);
});
