import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { recognizeCardPixels, mapImageFrames } from '../src/lib/miyoushe-recognition.js';
import { parseImageCount, createImageBoxPatch } from '../src/lib/image-box-draft.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const digitRows = JSON.parse(readFileSync(join(root, 'assets/recognition/miyoushe-flexible/digit-two.json'), 'utf8')).rows;

test('图片草稿保留空白和非法数量，不能静默变为0', () => {
  for (const value of [null, undefined, '', ' ', -1, 100, 1.5, 'abc', NaN, Infinity]) assert.equal(parseImageCount(value), null);
  for (const value of [0, 1, 2, 99]) assert.equal(parseImageCount(String(value)), value);
  assert.throws(() => createImageBoxPatch([null, ...Array(21).fill(1)]), /UNCONFIRMED/);
  assert.throws(() => createImageBoxPatch(Array(21).fill(1)), /UNCONFIRMED/);
  assert.throws(() => createImageBoxPatch(Array(22)), /UNCONFIRMED/);
  assert.throws(() => createImageBoxPatch(Array(22).fill('1')), /UNCONFIRMED/);
});

test('图片提交替换数量并进入完整模式，保留偏好和身份并按新Box重建快速选牌', () => {
  const values = [0, 0, 0, 1, 1, 99, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 3, 0, 0, 1, 1, 1];
  const old = { counts: Array(22).fill(9), mode: 'quick', keep: 2, wantOff: [1, 3], uid: '101524591', quick: { give: { 17: 2 }, want: [18] }, batch: true, filter: 'missing' };
  const patch = createImageBoxPatch(values, [], old);
  const result = { ...old, ...patch };
  assert.deepEqual(result.counts, values);
  assert.equal(result.mode, 'full');
  for (const key of ['keep', 'wantOff', 'uid']) assert.deepEqual(result[key], old[key]);
  assert.deepEqual(result.quick, { give: { 6: 9, 17: 1 }, want: [2, 7, 8, 12, 14, 16, 18, 19] });
  values[0] = 99;
  assert.equal(result.counts[0], 0, '提交的是数量快照，不跟随后续草稿变化');
  assert.deepEqual(createImageBoxPatch(result.counts).counts, result.counts, '重复导入不相加');
  assert.deepEqual(createImageBoxPatch(result.counts, [], result).quick, result.quick, '相同偏好下重复导入保持快速选牌一致');
});

test('提交时已有进行中的交换会阻止覆盖', () => {
  const counts = Array(22).fill(1);
  assert.throws(() => createImageBoxPatch(counts, [{ status: 'matched' }]), /LOCKED/);
  assert.deepEqual(counts, Array(22).fill(1));
});

const frames = Array.from({ length: 22 }, (_, index) => [25 + index % 3 * 170, 180 + Math.floor(index / 3) * 430, 150, 370, 20000]);
test('自动行列允许漏掉单张牌，保留其余21张的正确ID', () => {
  const result = mapImageFrames(frames.filter((_, index) => index !== 4));
  assert.equal(result.grid.identityReliable, true);
  assert.equal(result.cards.length, 21);
  assert.equal(result.cards.some((card) => card.id === 5), false);
  assert.equal(result.cards.at(-1).id, 22);
});

test('整行缺失时不猜测ID；用户指定首张牌后可继续校准', () => {
  assert.equal(mapImageFrames(frames.slice(3)).grid.identityReliable, false);
  const result = mapImageFrames(frames.slice(3), { columns: 3, firstId: 4, calibrated: true });
  assert.equal(result.cards[0].id, 4);
  assert.equal(result.cards.at(-1).id, 22);
});

test('空白图返回待确认，取消识别后不产生完成结果', async () => {
  const pixels = { width: 20, height: 40, data: new Uint8Array(20 * 40 * 4) };
  const blank = await recognizeCardPixels(pixels, { digitRows });
  assert.deepEqual(blank.counts, Array(22).fill(null));
  const controller = new AbortController();
  const progress = [];
  await assert.rejects(recognizeCardPixels(pixels, {
    digitRows, signal: controller.signal,
    onProgress(value) { progress.push(value); controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(progress.includes(1), false);
});

const hasSources = ['mine.jpeg', '2.jpg', '3.png'].every((name) => existsSync(join(root, 'docs/assets', name)));
test('实际JavaScript核心通过三张样图及全部36个缩放、裁边和异常用例', { skip: !hasSources && '本机未提供docs/assets样图，跳过开发期图片回归' }, async (t) => {
  const probe = spawnSync('python', ['-c', 'from PIL import Image'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('图片解码回归需要开发期Python + Pillow；网页不依赖它们'); return; }
  const outputRoot = join(root, 'output');
  mkdirSync(outputRoot, { recursive: true });
  const output = mkdtempSync(join(outputRoot, 'image-import-test-'));
  t.after(() => {
    // 只递归清理本次创建、且解析后仍位于项目output中的临时目录。
    const target = realpathSync(output);
    assert.equal(dirname(target), realpathSync(outputRoot));
    assert.ok(basename(target).startsWith('image-import-test-'));
    rmSync(target, { recursive: true });
  });
  const prepared = spawnSync('python', [join(root, 'scripts/prepare-image-import-tests.py'), '--out', output], { encoding: 'utf8', timeout: 60000 });
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.length, 36);
  for (const fixture of manifest) {
    await t.test(fixture.name, async () => {
      const data = readFileSync(join(output, fixture.file));
      const actual = await recognizeCardPixels({ width: fixture.width, height: fixture.height, data }, { digitRows });
      assert.deepEqual(actual.counts, fixture.expected);
    });
  }
});
