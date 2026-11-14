import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecretTap } from '../src/admin/entry.js';
import { createAdminController } from '../src/admin/controller.js';
import { createMockAdminQuery } from '../src/admin/mock.js';
import { createOnlineApi } from '../src/api/online.js';

test('隐藏入口在三秒内五次才触发，超时重置且可重新触发', () => {
  let at = 0;
  const tap = createSecretTap(() => at);
  for (let n = 0; n < 4; n++) assert.equal(tap(), false);
  at = 3001; assert.equal(tap(), false);
  for (let n = 0; n < 3; n++) assert.equal(tap(), false);
  assert.equal(tap(), true);
  assert.equal(tap(), false);
});

test('管理密码不出现在状态快照；关闭后丢弃数据并忽略未完成响应', async () => {
  const calls = [];
  let resolve;
  const panel = createAdminController({ query: body => { calls.push(body); return new Promise(done => { resolve = done; }); } });
  const pending = panel.unlock('private-password');
  assert.equal(calls[0].password, 'private-password');
  assert.doesNotMatch(JSON.stringify(panel.state), /private-password/);
  panel.close(); resolve({ total: 1, items: [{ uid: '812345678' }] }); await pending;
  assert.equal(panel.state.data, null); assert.equal(panel.state.authorized, false);
  await panel.load(); assert.equal(calls.length, 1);
});

test('快速切换视图不被旧响应覆盖；名单失效时清除数据并重新鉴权', async () => {
  const pending = [];
  const panel = createAdminController({ query: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  const first = panel.unlock('password');
  const second = panel.select('users');
  pending[1].resolve({ items: [{ id: 'new' }], total: 1 }); await second;
  pending[0].resolve({ poolUsers: 99 }); await first;
  assert.equal(panel.state.data.items[0].id, 'new');
  const denied = panel.load(); pending[2].reject({ code: 'ADMIN_FORBIDDEN', status: 403 }); await denied;
  assert.equal(panel.state.data, null); assert.equal(panel.state.authorized, false);
});

test('本地模拟独立查询、筛选与分页，不把返回记录作为可变共享状态', async () => {
  const query = createMockAdminQuery('anon');
  await assert.rejects(query({ view: 'overview' }), /ADMIN_FORBIDDEN/);
  const first = await query({ view: 'users', password: 'dev-admin', pageSize: 1 });
  assert.equal(first.total, 3); assert.equal(first.items.length, 1); first.items[0].uid = 'changed';
  assert.notEqual((await query({ view: 'users', password: 'dev-admin', pageSize: 1 })).items[0].uid, 'changed');
  assert.equal((await query({ view: 'overview', password: 'dev-admin', server: 'irminsul' })).poolUsers, 1);
});

test('线上管理请求复用真实会话，独立加载，不改变个人缓存和全站 pending', async () => {
  const requests = [], pending = [], local = new Map();
  const api = createOnlineApi({ apiBase: 'https://test/api/v1', storage: { get: key => local.get(key), set: (key, value) => local.set(key, value) }, uuid: () => 'device-test-123',
    createAuth: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'real-token' } } }), onAuthStateChange() {} } }),
    fetcher: async (url, request) => {
      requests.push({ url, request });
      return Response.json(url.endsWith('/config') ? { cloudbase: { envId: 'test', publishableKey: 'public' } } : { poolUsers: 0 });
    } });
  await api.init(); api.subscribePending(value => pending.push(value));
  await api.queryAdmin({ view: 'overview', password: 'secret' });
  assert.deepEqual(pending, []); assert.deepEqual(api.stats(), { waiting: 0 });
  assert.equal(requests.at(-1).request.headers.Authorization, 'Bearer real-token');
  assert.doesNotMatch(JSON.stringify([...local.entries()]), /secret/);
  assert.match(requests.at(-1).url, /\/admin\/query$/);
});
