import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID, scryptSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from '../backend/server.js';
import { createCloudBaseService, loadConfig } from '../backend/cloudbase.js';
import { adminQuery, createAdminHandler } from '../backend/admin.js';
import { ApiError } from '../backend/errors.js';

const password = 'test-admin-password';
const salt = 'a'.repeat(32);
const passwordHash = `scrypt$${salt}$${scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex')}`;
const identity = { authId: 'admin-subject', customId: null };
const customId = 'b_0123456789abcdef01234567';

describe('附加管理接口', () => {
  it('严格验参，忽略客户端伪造的身份、密码验证结果和额外操作', () => {
    assert.deepEqual(adminQuery({ view: 'users', password, authId: 'victim', passwordVerified: true, action: 'ban' }),
      { query: { view: 'users', page: 1, pageSize: 50 }, password });
    for (const input of [{ view: 'ban' }, { page: 0 }, { pageSize: 101 }, { server: 'cn' }, { view: 'users', status: 'completed' },
      { search: {} }, { view: 'matches', id: 'invalid' }]) assert.throws(() => adminQuery(input), /INVALID_ADMIN_QUERY/);
  });
  it('匿名密码逐次验证；错误和并发失败受实例内限流，过期恢复', async () => {
    let at = 0;
    const calls = [];
    const handler = createAdminHandler({ passwordHash, now: () => at, query: async (...args) => { calls.push(args); return {}; } });
    await assert.rejects(handler(identity, {}, {}), /ADMIN_PASSWORD_REQUIRED/);
    await handler(identity, { password }, {});
    assert.equal(calls[0][2], true);
    for (let n = 0; n < 5; n++) await assert.rejects(handler(identity, { password: 'wrong' }, {}), /ADMIN_FORBIDDEN/);
    await assert.rejects(handler(identity, { password }, {}), error => error.status === 429);
    at = 300001;
    await handler(identity, { password }, {});
    assert.equal(calls.length, 2);
  });
  it('配置无效只禁用匿名管理；B站身份只由数据库名单授权，不能使用密码绕过', async () => {
    const handler = createAdminHandler({ passwordHash: 'invalid', query: async (who, query, verified) => ({ who, verified }) });
    await assert.rejects(handler(identity, { password }, {}), /ADMIN_NOT_CONFIGURED/);
    assert.equal((await handler({ ...identity, customId }, { password }, {})).verified, false);
    assert.doesNotThrow(() => loadConfig({ TCB_ENV: 'test', CLOUDBASE_APIKEY: 'secret', SWAP_HMAC_SECRET: 'a'.repeat(32), SWAP_ADMIN_PASSWORD_HASH: 'invalid' }));
  });
  it('密码生成脚本兼容中文密码，输出可由实际管理接口验证', async () => {
    const child = spawn(process.execPath, ['scripts/hash-admin-password.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    const ended = once(child, 'close');
    const secret = '中文测试密码-足够长度-2026';
    child.stdin.end(secret + '\n');
    assert.equal((await ended)[0], 0, errors);
    assert.doesNotMatch(output, /中文/);
    const handler = createAdminHandler({ passwordHash: output.trim(), query: async (_who, _query, verified) => verified });
    assert.equal(await handler(identity, { password: secret }, {}), true);
  });
  it('管理 HTTP 不进入业务 execute，不需要幂等键，错误不影响 state/config', async () => {
    let businessCalls = 0;
    let adminCalls = 0;
    const server = createServer({ config: { adminPasswordHash: passwordHash, gatewayCors: true }, service: {
      authenticate: async token => { if (token !== 'real-token') throw new ApiError('UNAUTHENTICATED', 401); return identity; },
      execute: async () => { businessCalls++; return { normal: true }; },
      queryAdmin: async (who, query, verified) => { assert.deepEqual(who, identity); assert.equal(verified, true); adminCalls++; return { items: [] }; },
    } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const send = (body, token = 'real-token') => fetch(`${base}/admin/query`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      assert.equal((await send({ password })).status, 200);
      assert.equal((await send({ password: 'wrong', passwordVerified: true })).status, 403);
      assert.equal((await send({ password }, 'forged')).status, 401);
      assert.equal((await fetch(`${base}/state`, { headers: { Authorization: 'Bearer real-token' } })).status, 200);
      assert.equal((await fetch(`${base}/config`)).status, 200);
      assert.equal(adminCalls, 1); assert.equal(businessCalls, 1);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  it('CloudBase 管理查询仅调用独立 RPC，不调用维护、dispatch 或透传密码', async () => {
    const calls = [];
    const service = createCloudBaseService({ apiBase: 'https://test', serverKey: 'secret', hmacSecret: 'a'.repeat(32), maintenanceSignals: true },
      async (url, request) => { calls.push({ url, body: JSON.parse(request.body) }); return Response.json({}); });
    await service.queryAdmin(identity, { view: 'overview' }, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rpc\/swap_admin_query$/);
    assert.deepEqual(calls[0].body, { p_auth_id: identity.authId, p_custom_id: null, p_password_verified: true, p_query: { view: 'overview' } });
  });
});

let db;
async function business(actor, action, data = {}, custom = null) {
  return (await db.query('SELECT public.swap_dispatch($1,$2,$3::jsonb,$4,$5,$6) data',
    [actor, action, JSON.stringify(data), custom, randomUUID(), 'test-fingerprint'])).rows[0].data;
}
async function query(data = {}, who = identity, verified = true) {
  return (await db.query('SELECT public.swap_admin_query($1,$2,$3,$4::jsonb) data',
    [who.authId, who.customId, verified, JSON.stringify(data)])).rows[0].data;
}
async function snapshot() {
  const rows = (await db.query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN ('public','swap_private') ORDER BY 1,2")).rows;
  return Promise.all(rows.map(async row => (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') data FROM ${row.table_schema}.${row.table_name} t`)).rows[0].data));
}

describe('管理 RPC 真实 PostgreSQL 查询', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite();
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    const folder = new URL('../cloudbase/migrations/', import.meta.url);
    const names = (await readdir(folder)).filter(name => name.endsWith('.sql')).sort();
    for (const name of names.filter(name => !name.endsWith('_admin_readonly.sql'))) await db.exec(await readFile(new URL(name, folder), 'utf8'));
    const catalog = async () => (await db.query("SELECT pg_get_functiondef(oid) def FROM pg_proc WHERE pronamespace IN ('public'::regnamespace,'swap_private'::regnamespace) AND proname<>'swap_admin_query' ORDER BY oid")).rows;
    const before = await catalog();
    await db.exec(await readFile(new URL(names.find(name => name.endsWith('_admin_readonly.sql')), folder), 'utf8'));
    assert.deepEqual(await catalog(), before, '追加迁移不修改任何既有函数');
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE public.accounts CASCADE; TRUNCATE swap_private.rate_limits;');
    for (const actor of ['alice', 'bob', 'charlie']) await business(actor, 'profile', { uid: '812345678', server: 'asia', region: 'asia' });
    await business('dave', 'profile', { uid: '598765432', server: 'irminsul', region: 'cn_bili' });
    await business('alice', 'publish', { give: { 17: 2 }, want: [1, 2], mode: 'quick', note: { preset: 'anytime' } });
    await business('bob', 'publish', { give: { 1: 1 }, want: [17], mode: 'quick' });
    await business('charlie', 'publish', { give: { 6: 1 }, want: [7], mode: 'quick' });
    await business('dave', 'publish', { give: { 3: 1 }, want: [4], mode: 'quick' });
    await db.query('SELECT public.swap_bili_session(NULL,$1,$2)', [customId, 'test-credential']);
    await business('admin-bili-subject', 'state', {}, customId);
  });
  after(async () => { await db?.close(); });
  it('拒绝普通用户、伪造绑定和名单外 B站账号；名单增删立即生效', async () => {
    await assert.rejects(query({}, identity, false), /ADMIN_FORBIDDEN/);
    const who = { authId: 'admin-bili-subject', customId };
    await assert.rejects(query({}, who), /ADMIN_FORBIDDEN/);
    await db.query('INSERT INTO swap_private.admin_accounts VALUES ($1)', [customId]);
    assert.equal((await query({}, who, false)).registeredUsers, 5);
    await assert.rejects(query({}, { ...who, authId: 'forged' }), /ADMIN_FORBIDDEN/);
    await db.query('DELETE FROM swap_private.admin_accounts');
    await assert.rejects(query({}, who, false), /ADMIN_FORBIDDEN/);
  });
  it('匿名和 authenticated 不能直调管理 RPC 或读取名单', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await assert.rejects(query(), /permission denied/);
        await assert.rejects(db.query('SELECT * FROM swap_private.admin_accounts'), /permission denied/);
      } finally { await db.exec('RESET ROLE'); }
    }
  });
  it('全池按账号去重、部分占用仍可等待，六服供需独立且完整保留', async () => {
    const data = await query();
    assert.equal(data.poolUsers, 4); assert.equal(data.waitingUsers, 3);
    assert.equal(data.activeUsers, 2); assert.equal(data.activeMatches, 1);
    assert.equal(data.servers.length, 6);
    assert.deepEqual(data.servers.find(s => s.server === 'asia').supply, { 6: 1, 17: 1 });
    assert.deepEqual(data.servers.find(s => s.server === 'irminsul').demand, { 4: 1 });
    assert.equal((await query({ server: 'irminsul' })).poolUsers, 1);
    await db.query("UPDATE public.players SET credit=20 WHERE account_id='anon:charlie'");
    assert.equal((await query()).waitingUsers, 2);
  });
  it('列表筛选、详情、总数和越界空页正确；不泄露认证字段', async () => {
    const list = await query({ view: 'waiting', server: 'asia', pageSize: 1 });
    assert.equal(list.total, 3); assert.equal(list.items.length, 1);
    assert.equal((await query({ view: 'waiting', page: 99 })).total, 4);
    assert.deepEqual((await query({ view: 'waiting', page: 99 })).items, []);
    const users = await query({ view: 'users', search: '812345678' });
    assert.equal(users.total, 3);
    assert.equal((await query({ view: 'users', id: customId })).items[0].accountType, 'bili');
    const matches = await query({ view: 'matches', accountId: 'anon:alice', status: 'matched' });
    assert.equal(matches.total, 1); assert.equal(matches.items[0].partnerB.uid, '812345678');
    assert.doesNotMatch(JSON.stringify([list, users, matches]), /credential|auth_user_id|toy_open_id|test-credential/);
  });
  it('查看反馈及所有分页详情后，业务表、限流和幂等记录逐项不变', async () => {
    const mid = (await query({ view: 'matches' })).items[0].id;
    await business('alice', 'feedback', { matchId: mid, kind: 'report', reason: 'test', note: '保留原反馈' });
    const before = await snapshot();
    for (const view of ['overview', 'waiting', 'matches', 'users', 'feedback']) await query({ view });
    const feedback = await query({ view: 'feedback', accountId: 'anon:alice' });
    assert.equal(feedback.items[0].note, '保留原反馈');
    await query({ view: 'matches', id: mid });
    await db.exec('BEGIN READ ONLY');
    await query(); await query({ view: 'users' });
    await db.exec('COMMIT');
    assert.deepEqual(await snapshot(), before);
  });
});
