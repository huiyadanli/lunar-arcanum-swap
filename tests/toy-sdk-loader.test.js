import test from 'node:test';
import assert from 'node:assert/strict';
import { isBilibiliHost, loadToySdk } from '../src/platform/toy-sdk-loader.js';

test('仅 bilibili.com 与 bilibilitoy.com 及其子域名视为 Toy 域名', () => {
  for (const host of ['bilibili.com', 'www.bilibili.com', 'bilibilitoy.com', 'www.bilibilitoy.com', 'WWW.BilibiliToy.com']) {
    assert.equal(isBilibiliHost(host), true, host);
  }
  for (const host of ['', 'localhost', 'swap.example', 'bilibili.com.evil.example', 'bilibilitoy.com.evil.example', 'evilbilibilitoy.com', 'notbilibili.com']) {
    assert.equal(isBilibiliHost(host), false, host);
  }
});

test('非 Toy 域名不加载 SDK', async () => {
  const win = { location: { hostname: 'swap.example' } };
  assert.equal(await loadToySdk({ win, doc: {} }), null);
});
