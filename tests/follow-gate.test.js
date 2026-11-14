import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

let platform;
let createApp;

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
  // 直接运行实际 app 工厂；不启动依赖 DOM、Vite 资源导入和动画的 boot。
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const start = source.indexOf('function app()');
  const end = source.indexOf('\nasync function boot()');
  assert.ok(start >= 0 && end > start);
  createApp = runInNewContext(`(${source.slice(start, end)})`, {
    storage: { get: (_key, fallback) => fallback }, platform,
    CARDS: [], CARD_COUNT: 22, LANGS: [], SERVERS: {}, QUICK_NOTE_PRESETS: [], TRADE_TIME_PRESETS: [], REASONS: [],
    dev: {}, ONLINE_BACKEND: false, imageImportIcons: '', rid4: () => 'TEST', detectLang: () => 'zh-CN',
    matchMedia: () => ({ matches: false }), moonPath: () => {}, canStartTrade: () => {}, matchStatus: () => {},
    maskUid: value => value,
  }, { filename: 'src/main.js' });
});

function setup(t, response = { status: 'ok', data: { isFollowing: false, isAuthor: false } }) {
  globals(t, { window: { toy: {
    getAuthorRelation: async () => response,
    navigate: async () => {},
  } } });
  platform.env = 'toy-app';
  platform.features = { follow: true };
  platform.author.isAuthor = false;
  platform.authorMid = '12345';
  const app = createApp();
  const notices = [];
  const reveals = [];
  app.accountType = 'bili';
  app.t = key => key;
  app.toast = (message, options) => notices.push({ message, options });
  app.revealUid = async id => { reveals.push(id); };
  return { app, notices, reveals };
}

test('作者本人未关注自己时，开始交换直接放行，不弹关注抽屉', async t => {
  const { app, notices, reveals } = setup(t, { status: 'ok', data: { isAuthor: true, isFollowing: false } });
  await app.startTrade({ id: 'match-self' });
  assert.deepEqual(reveals, ['match-self']);
  assert.equal(app.sheet, null);
  assert.equal(app.followCache, true);
  assert.equal(platform.author.isAuthor, true);
  assert.equal(app.busy, false);
  await app.followFromMe();
  assert.equal(notices.at(-1).message, 'follow.authorSelf');
});

test('普通未关注用户仍弹关注提示，已关注用户直接放行', async t => {
  const { app, reveals } = setup(t);
  app.authorInfo = {};
  await app.startTrade({ id: 'match-other' });
  assert.equal(app.sheet, 'follow');
  assert.deepEqual(reveals, []);
  window.toy.getAuthorRelation = async () => ({ status: 'ok', data: { isAuthor: false, isFollowing: true } });
  await app.recheckFollow();
  assert.equal(app.sheet, null);
  assert.deepEqual(reveals, ['match-other']);
});

test('关注状态缺失、异常或 SDK 报错均放行并提示，且不缓存为已关注', async t => {
  const { app, notices, reveals } = setup(t);
  for (const response of [undefined, { status: 'unavailable' }, { status: 'ok' }, { status: 'ok', data: { isFollowing: 'false' } }]) {
    window.toy.getAuthorRelation = async () => response;
    await app.startTrade({ id: 'match-unknown' });
    assert.equal(app.followCache, null);
    assert.equal(app.sheet, null);
    assert.equal(notices.at(-1).message, 'follow.checkSkipped');
  }
  window.toy.getAuthorRelation = async () => { throw new Error('network unavailable'); };
  app.sheetData = { matchId: 'match-recheck' };
  app.sheet = 'follow';
  await app.recheckFollow();
  assert.equal(app.followCache, null);
  assert.equal(app.sheet, null);
  assert.equal(reveals.at(-1), 'match-recheck');
  await app.followFromMe();
  assert.equal(notices.at(-1).message, 'follow.checkFailed');
  assert.equal(app.followCache, null);
});

test('交换关注按钮及个人页关注入口都会提示 SDK 跳转错误，不误放行交换', async t => {
  const { app, notices, reveals } = setup(t);
  app.sheet = 'follow';
  app.sheetData = { matchId: 'pending' };
  for (const type of ['unsupported', 'unknown', 'user_denied']) {
    window.toy.navigate = async () => { throw Object.assign(new Error('跳转失败'), { type }); };
    for (const action of ['goFollow', 'followFromMe']) {
      await app[action]();
      assert.equal(notices.at(-1).message, type === 'unsupported' ? 'follow.openUnsupported' : 'follow.openFailed');
      assert.equal(notices.at(-1).options.error, true);
      assert.equal(app.sheet, 'follow');
      assert.equal(app.followCache, null);
    }
  }
  assert.deepEqual(reveals, []);
});

test('UP主 ID 未配置或无效时提示具体原因，SDK 缺失导航方法也有反馈', async t => {
  const { app, notices } = setup(t);
  for (const id of ['', '0', null, 'not-a-mid']) {
    platform.authorMid = id;
    await app.goFollow();
    assert.equal(notices.at(-1).message, 'follow.notConfigured');
    await app.followFromMe();
    assert.equal(notices.at(-1).message, 'follow.notConfigured');
  }
  platform.authorMid = '12345';
  delete window.toy.navigate;
  await app.goFollow();
  assert.equal(notices.at(-1).message, 'follow.openUnsupported');
});

test('关注跳转在用户点击后直接调用 SDK，作者本人复查则无需打开空间', async t => {
  const { app, reveals } = setup(t);
  const requests = [];
  window.toy.navigate = async req => requests.push(req);
  const opening = platform.author.openSpace();
  assert.deepEqual(requests, [{ type: 'space', id: '12345' }]);
  await opening;
  window.toy.getAuthorRelation = async () => ({ status: 'ok', data: { isAuthor: true, isFollowing: false } });
  platform.author.isAuthor = true;
  app.sheetData = { matchId: 'self-recheck' };
  await app.goFollow();
  assert.equal(requests.length, 1);
  assert.deepEqual(reveals, ['self-recheck']);
});

test('独立站弹窗被拦截时可见提示，成功打开时隔离 opener 并使用正确空间地址', async t => {
  const { app, notices } = setup(t);
  platform.env = 'standalone';
  window.open = () => null;
  await app.followFromMe();
  assert.equal(notices.at(-1).message, 'follow.popupBlocked');
  const target = { opener: {}, location: {} };
  window.open = (url, name) => {
    assert.equal(url, 'about:blank');
    assert.equal(name, '_blank');
    return target;
  };
  await platform.author.openSpace();
  assert.equal(target.opener, null);
  assert.equal(target.location.href, 'https://space.bilibili.com/12345');
});
