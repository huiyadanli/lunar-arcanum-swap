import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from '../backend/server.js';
import { createCloudBaseService } from '../backend/cloudbase.js';
import { ApiError, upstreamError } from '../backend/errors.js';
import * as validation from '../backend/validation.js';

const config = { envId: 'test-env', apiBase: 'https://test-env.api.tcloudbasegateway.com',
  serverKey: 'server-secret', hmacSecret: 'hmac-test-secret-never-used-in-production',
  publishableKey: 'public-key', authorMid: '', gatewayCors: true, corsOrigins: [], trustProxy: false };

async function withServer(run, overrides = {}) {
  const calls = [];
  const service = {
    authenticate: async token => { if (token !== 'valid-token') throw new ApiError('UNAUTHENTICATED', 401); return { authId: 'test-user', customId: null }; },
    execute: async (...args) => { calls.push(args); return { ok: true }; }, session: async () => ({ ticket: 'ticket' }), ...overrides,
  };
  const logs = [];
  const server = createServer({ service, config, logger: { error: message => logs.push(message) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, calls, logs); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const headers = { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json', 'Idempotency-Key': 'request-key-123', 'X-Device-Id': 'device-12345' };

describe('HTTP API 与输入边界', () => {
  it('公开配置可读取，但业务接口必须校验真实会话及幂等键', async () => {
    await withServer(async base => {
      const configResponse = await fetch(`${base}/api/v1/config`);
      assert.equal(configResponse.status, 200);
      const publicConfig = await configResponse.json();
      assert.deepEqual(publicConfig, { authorMid: '', cloudbase: { envId: 'test-env', publishableKey: 'public-key' } });
      assert.doesNotMatch(JSON.stringify(publicConfig), /server-secret|hmac-test-secret/);
      assert.equal((await fetch(`${base}/api/v1/state`)).status, 401);
      assert.equal((await fetch(`${base}/api/v1/state`, { headers: { Authorization: 'Bearer forged-token' } })).status, 401);
      assert.equal((await fetch(`${base}/api/v1/me`, { method: 'PUT', headers: { Authorization: 'Bearer valid-token' } })).status, 400);
    });
  });
  it('绑定 UID 由服务端推导分区，客户端伪造服务器、账号 ID 和重复状态均不透传', async () => {
    await withServer(async (base, calls) => {
      const response = await fetch(`${base}/api/v1/me`, { method: 'PUT', headers,
        body: JSON.stringify({ uid: '812345678', server: 'america', region: 'us', accountId: 'victim', duplicateUid: true }) });
      assert.equal(response.status, 200);
      assert.deepEqual(calls[0][2], { uid: '812345678', server: 'asia', region: 'asia' });
      assert.equal(calls[0][0].authId, 'test-user');
    });
  });
  it('区分未知路由和错误方法，预检不重复设置网关跨域头', async () => {
    await withServer(async base => {
      assert.equal((await fetch(`${base}/api/v1/nope`)).status, 404);
      const response = await fetch(`${base}/api/v1/me`);
      assert.equal(response.status, 405);
      assert.match(response.headers.get('allow'), /PUT/);
      const preflight = await fetch(`${base}/api/v1/me`, { method: 'OPTIONS', headers: { Origin: 'https://www.bilibili.com' } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    });
  });
  it('错误响应与日志不泄露请求头、token 或异常中的密钥', async () => {
    await withServer(async (base, calls, logs) => {
      const response = await fetch(`${base}/api/v1/state`, { headers });
      const body = await response.text();
      assert.equal(response.status, 500);
      assert.match(body, /INTERNAL_ERROR/);
      assert.doesNotMatch(body + logs.join(''), /server-secret|valid-token|Bearer|headers/);
    }, { execute: async () => { throw new Error('server-secret'); } });
  });
  it('拒绝无效 JSON、错误媒体类型和超大请求，不执行业务操作', async () => {
    await withServer(async (base, calls) => {
      assert.equal((await fetch(`${base}/api/v1/me`, { method: 'PUT', headers, body: '{' })).status, 400);
      assert.equal((await fetch(`${base}/api/v1/me`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
      assert.equal((await fetch(`${base}/api/v1/me`, { method: 'PUT', headers, body: JSON.stringify({ x: 'a'.repeat(17000) }) })).status, 413);
      assert.equal(calls.length, 0);
    });
  });
  it('校验牌号、数量、给出与想要互斥、联系方式和部分完成索引', () => {
    for (const value of [
      { give: { 23: 1 }, want: [1], mode: 'quick' },
      { give: { 17: 100 }, want: [1], mode: 'quick' },
      { give: { 17: 1 }, want: [17], mode: 'quick' },
      { give: { 17: 1 }, want: [1, 1], mode: 'quick' },
    ]) assert.throws(() => validation.listing(value), /INVALID_CARDS/);
    assert.throws(() => validation.note({ text: '访问 https://bad.example' }), /NOTE_REJECTED/);
    assert.throws(() => validation.confirmation({ result: 'completed', completedPairs: [0, 0] }), /INVALID_COMPLETED_PAIRS/);
    assert.throws(() => validation.historyCursor('not-a-valid-cursor'), /INVALID_CURSOR/);
    assert.deepEqual(validation.confirmation({ result: 'completed' }), { result: 'completed' });
  });
});

describe('CloudBase 平台适配', () => {
  it('兼容 PG 网关改写后的错误，保留业务状态码与重试时间', () => {
    const error = upstreamError({ code: 'DATABASE_P0001', message: 'SWAP_ERROR:{"code":"DAILY_LIMIT","status":429,"retryAt":1800000000000}' }, 400);
    assert.equal(error.code, 'DAILY_LIMIT');
    assert.equal(error.status, 429);
    assert.equal(error.retryAt, 1800000000000);
    assert.equal(upstreamError({ code: 'DATABASE_P0001', message: 'NOT_FOUND' }, 400).status, 404);
  });
  it('通过平台验证 token，拒绝未生效或属于其他环境的身份', async () => {
    const service = createCloudBaseService(config, async () => Response.json({ sub: 'forged', client_id: 'another-env', scope: 'anonymous' }));
    await assert.rejects(service.authenticate('token'), /UNAUTHENTICATED/);
    const invalid = createCloudBaseService(config, async () => Response.json({}, { status: 401 }));
    await assert.rejects(invalid.authenticate('token'), error => error.status === 401);
  });
  it('上游不可用保持失败，不把请求内容或服务端凭据回传', async () => {
    const service = createCloudBaseService(config, async () => { throw new Error('server-secret'); });
    await assert.rejects(service.authenticate('token'), error => error.status === 503 && !error.message.includes('secret'));
  });
  it('toyOpenId 原文仅在内存中处理，RPC 只接收 HMAC 与经验证账号', async () => {
    let captured;
    const service = createCloudBaseService(config, async (url, request) => { captured = JSON.parse(request.body); return Response.json({}); });
    await service.execute({ authId: 'subject', customId: null }, 'profile', { toyOpenId: 'sensitive-open-id' }, { requestKey: 'request-123', deviceId: 'device-123', ip: '127.0.0.1' });
    assert.equal(captured.p_auth_id, 'subject');
    assert.match(captured.p_data.toyOpenIdHmac, /^[a-f\d]{64}$/);
    assert.doesNotMatch(JSON.stringify(captured), /sensitive-open-id|127\.0\.0\.1|device-123/);
  });
  it('用 CloudBase SDK 签发真实 RSA Ticket，恢复身份只验证密钥哈希', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const customLoginKey = { env_id: config.envId, private_key_id: 'test-key-id', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    let params;
    const customId = 'b_0123456789abcdef01234567';
    const service = createCloudBaseService({ ...config, customLoginKey }, async (url, request) => { params = JSON.parse(request.body); return Response.json({ customUserId: customId }); });
    const first = await service.session({}, { deviceId: 'device-123' });
    assert.match(first.credential, /^[\w-]{43}$/);
    assert.doesNotMatch(JSON.stringify(params), new RegExp(first.credential));
    const token = first.ticket.split('/@@/')[1];
    const [header, payload, signature] = token.split('.');
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.uid, customId);
    assert.ok(claims.exp > Date.now());
    const recovered = await service.session({ credential: first.credential }, {});
    assert.equal(recovered.credential, undefined);
    assert.match(params.p_credential_hash, /^[a-f\d]{64}$/);
  });

  it('业务写入先持久化唤醒，再调用数据库；状态读取不产生唤醒信号', async () => {
    const calls = [];
    const service = createCloudBaseService({ ...config, maintenanceSignals: true }, async (url, request) => {
      calls.push({ url, body: JSON.parse(request.body) });
      return Response.json(url.includes('/v1/functions/') ? { leaseUntil: Date.now() + 120000 } : {});
    });
    await service.execute({ authId: 'subject' }, 'publish', { give: { 17: 1 }, want: [1] }, { requestKey: 'key-12345' });
    assert.match(calls[0].url, /\/v1\/functions\/swap-maintenance$/);
    assert.equal(calls[0].body.action, 'wake');
    assert.ok(calls[1].body.p_data._maintenanceLeaseUntil > Date.now());
    await service.execute({ authId: 'subject' }, 'state', {}, {});
    assert.equal(calls.length, 3);
    assert.match(calls[2].url, /\/rpc\/swap_dispatch$/);
  });

  it('唤醒失败时不提交业务写入，避免成功结算后丢失后台确认任务', async () => {
    let calls = 0;
    const service = createCloudBaseService({ ...config, maintenanceSignals: true }, async () => {
      calls++; throw Error('storage failure');
    });
    await assert.rejects(service.execute({ authId: 'subject' }, 'confirm', { result: 'completed' }, { requestKey: 'key-12345' }), /BACKEND_UNAVAILABLE/);
    assert.equal(calls, 1);
  });
});
