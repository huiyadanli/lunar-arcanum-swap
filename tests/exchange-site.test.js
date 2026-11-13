import test from 'node:test';
import assert from 'node:assert/strict';
import { standaloneSiteUrl, biliToyPageUrl, isBiliToyUrl } from '../src/platform/exchange-site.js';

test('自部署保留目录并清理调试参数和当前路由', () => {
  assert.equal(standaloneSiteUrl('https://swap.example/collection/index.html?mock=bili&token=private#/trade/123'), 'https://swap.example/collection/#/welcome');
  assert.equal(standaloneSiteUrl('https://swap.example/collection/?env=toy-app#/box'), 'https://swap.example/collection/#/welcome');
});

test('自部署可独立配置正式域名，不受当前预览地址影响', () => {
  assert.equal(standaloneSiteUrl('http://localhost:5174/?mock=anon', 'https://cards.example/swap/'), 'https://cards.example/swap/#/welcome');
  assert.throws(() => standaloneSiteUrl('https://swap.example/', 'javascript:alert(1)'));
  assert.throws(() => standaloneSiteUrl('https://swap.example/', 'https://user:password@swap.example/'));
});

test('Toy 页面始终解析到当前 Toy 根目录，与自部署链接不同', () => {
  assert.equal(biliToyPageUrl('https://www.bilibili.com/toy/my-real-toy/pages/result.html?mock=anon'), 'https://www.bilibili.com/toy/my-real-toy/index.html#/welcome');
  assert.equal(biliToyPageUrl('https://www.bilibili.com/toy/my-real-toy'), 'https://www.bilibili.com/toy/my-real-toy/index.html#/welcome');
});

test('拒绝占位或跨平台链接，不把独立站或普通 B站页面当作 Toy', () => {
  for (const value of [undefined, '', 'https://swap.example/toy/name/', 'https://www.bilibili.com/video/123', 'https://www.bilibili.com.evil.example/toy/name/', 'http://www.bilibili.com/toy/name/', 'https://user:pass@www.bilibili.com/toy/name/']) {
    assert.equal(biliToyPageUrl(value), null);
    assert.equal(isBiliToyUrl(value), false);
  }
});

test('Toy 相对页面不能逃逸到其他 Toy 或外域', () => {
  for (const path of ['https://other.example/', '//other.example/', '../other-toy/index.html', '/toy/other/index.html']) {
    assert.equal(biliToyPageUrl('https://www.bilibili.com/toy/current/', path), null);
  }
});
