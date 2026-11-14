import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let platform;
const dataUrl = 'data:image/png;base64,AQID';

function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
}

before(async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '' } });
  try {
    ({ platform } = await import('../src/platform/index.js'));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
    else delete globalThis.location;
  }
});

async function sdkEnvironment(t, { app = true, supported = true, sharePicture = async () => {}, saveImageToAlbum = async () => {} } = {}) {
  const downloads = [];
  globals(t, {
    location: { hostname: 'www.bilibili.com', search: '' },
    window: { location: { hostname: 'www.bilibili.com' }, toy: {
      isSupport: async ability => ability === 'closeBrowser' ? app : supported,
      sharePicture, saveImageToAlbum,
    } },
    document: { createElement: tag => { downloads.push(tag); throw new Error('SDK 场景禁止创建下载链接'); } },
  });
  t.mock.method(URL, 'createObjectURL', () => { downloads.push('blob'); throw new Error('SDK 场景禁止生成下载 URL'); });
  await platform.init();
  t.after(() => assert.deepEqual(downloads, []));
}

test('SDK 激活后将预览原图交给 sharePicture，能力探测不依赖 closeBrowser', async t => {
  for (const app of [true, false]) {
    await t.test(app ? 'toy-app' : 'toy-web', async t => {
      const calls = [];
      await sdkEnvironment(t, { app, sharePicture: async req => calls.push(req) });
      assert.equal(platform.env, app ? 'toy-app' : 'toy-web');
      assert.equal(platform.can('shareImage'), true);
      assert.equal(await platform.shareImage({ dataUrl }), 'shared');
      assert.deepEqual(calls, [{ base64Data: dataUrl }]);
    });
  }
});

test('SDK 图片分享失败或拒绝时保留错误，不回退下载', async t => {
  await sdkEnvironment(t);
  for (const type of ['user_denied', 'unknown', 'unsupported']) {
    const cause = Object.assign(new Error('分享未完成'), { type });
    window.toy.sharePicture = async () => { throw cause; };
    await assert.rejects(platform.shareImage({ dataUrl }), error => {
      assert.equal(error.kind, type === 'user_denied' ? 'denied' : type);
      assert.equal(error.cause, cause);
      return true;
    });
  }
});

test('不支持图片分享或 SDK 版本缺少方法时明确报错，不回退下载', async t => {
  await sdkEnvironment(t, { app: false, supported: false });
  assert.equal(platform.can('shareImage'), false);
  assert.equal(platform.can('saveImage'), false);
  await assert.rejects(platform.shareImage({ dataUrl }), { kind: 'unsupported' });
  await assert.rejects(platform.saveImage({ dataUrl }), { kind: 'unsupported' });
  platform.features.shareImage = true;
  delete window.toy.sharePicture;
  await assert.rejects(platform.shareImage({ dataUrl }), { kind: 'unsupported' });
});

test('SDK 相册保存失败也不会落到下载；模拟 SDK 走相同接口', async t => {
  const cause = new Error('相册保存失败');
  await sdkEnvironment(t, { saveImageToAlbum: async () => { throw cause; } });
  await assert.rejects(platform.saveImage({ dataUrl }), error => error.cause === cause);
  const calls = [];
  window.toy.__mock = true;
  window.toy.saveImageToAlbum = async req => calls.push(req);
  assert.equal(await platform.saveImage({ dataUrl }), 'album');
  assert.deepEqual(calls, [{ base64Data: dataUrl }]);
});

test('独立站仍使用 Blob 下载图片，不使用 Toy 图片分享', async t => {
  const calls = [];
  const link = { style: {}, click: () => calls.push('click'), remove: () => calls.push('remove') };
  globals(t, {
    location: { hostname: 'swap.example', search: '' }, window: { location: { hostname: 'swap.example' } },
    document: {
      createElement: tag => { assert.equal(tag, 'a'); return link; },
      body: { appendChild: element => assert.equal(element, link) },
    },
  });
  t.mock.method(URL, 'createObjectURL', blob => {
    assert.equal(blob.type, 'image/png');
    assert.equal(blob.size, 3);
    return 'blob:card';
  });
  t.mock.method(URL, 'revokeObjectURL', href => calls.push(href));
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { assert.equal(delay, 30000); callback(); });
  await platform.init();
  assert.equal(platform.env, 'standalone');
  assert.equal(platform.can('shareImage'), false);
  assert.equal(await platform.saveImage({ dataUrl, name: 'card.png' }), 'download');
  assert.equal(link.href, 'blob:card');
  assert.equal(link.download, 'card.png');
  assert.deepEqual(calls, ['click', 'remove', 'blob:card']);
  await assert.rejects(platform.shareImage({ dataUrl }), { kind: 'unsupported' });
});
