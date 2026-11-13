import test from 'node:test';
import assert from 'node:assert/strict';
import { exportShareImage } from '../src/lib/image-export.js';

test('压缩导出保留尺寸，格式、后缀和二进制体积一致', () => {
  const canvas = { width: 1080, height: 2467, toDataURL: () => 'data:image/jpeg;base64,AQIDBA==' };
  const image = exportShareImage(canvas);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal(image.extension, 'jpg');
  assert.equal(image.bytes, 4);
  assert.deepEqual([canvas.width, canvas.height], [1080, 2467]);
});

test('较大图片会降低编码质量，同时保持原始画布尺寸', () => {
  const qualities = [];
  const canvas = { width: 1080, height: 2467, toDataURL: (type, quality) => {
    qualities.push(quality);
    return `data:${type};base64,${Buffer.alloc(quality > .78 ? 900000 : 400000).toString('base64')}`;
  } };
  const image = exportShareImage(canvas);
  assert.ok(qualities.length > 1);
  assert.ok(qualities.at(-1) < qualities[0]);
  assert.equal(image.bytes, 400000);
  assert.equal(canvas.width, 1080);
});

test('浏览器回退 PNG 时使用正确后缀，避免格式与文件名不匹配', () => {
  const image = exportShareImage({ toDataURL: () => 'data:image/png;base64,AQID' });
  assert.equal(image.extension, 'png');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.bytes, 3);
});
