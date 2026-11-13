// 显式运行的云端集成验证：创建独立测试身份，结束后撤回它们的等待需求。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from '../backend/server.js';
import { createCloudBaseService, loadConfig } from '../backend/cloudbase.js';

const runtime = JSON.parse(await readFile(new URL('../.secrets/backend.runtime.json', import.meta.url), 'utf8'));
const config = loadConfig(runtime);
const service = createCloudBaseService(config);
const remoteUrl = process.argv[process.argv.indexOf('--url') + 1];
const useRemote = process.argv.includes('--url');
let server;
let apiRoot;
if (useRemote) {
  if (!remoteUrl?.startsWith('https://')) throw new Error('--url must be an HTTPS API root');
  apiRoot = remoteUrl.replace(/\/$/, '');
} else {
  server = createServer({ config, service });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  apiRoot = `http://127.0.0.1:${server.address().port}/api/v1`;
}
const clients = [];
const report = [];
async function platform(path, body, client) {
  const response = await fetch(`${config.apiBase}${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${config.publishableKey}`, 'Content-Type': 'application/json', 'x-device-id': client.deviceId },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok || typeof result.access_token !== 'string') throw new Error(`Platform login failed: HTTP ${response.status}, code=${result.code || 'unknown'}`);
  client.token = result.access_token;
}
async function request(client, path, { method = 'GET', body, key = randomUUID(), expected = 200 } = {}) {
  const response = await fetch(`${apiRoot}${path}`, { method,
    headers: { Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json', 'x-device-id': client.deviceId, 'Idempotency-Key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (response.status !== expected) throw new Error(`API ${method} ${path}: HTTP ${response.status}, expected ${expected}, code=${result.error?.code || 'unknown'}`);
  return result;
}
try {
  for (let i = 0; i < 3; i++) {
    const client = { deviceId: randomUUID() }; clients.push(client);
    await platform('/auth/v1/signin/anonymously', {}, client);
    await request(client, '/me', { method: 'PUT', body: { uid: '812345678' } });
  }
  report.push('真实匿名登录、重复 UID 保存和账号独立成功');
  const [alice, bob, carol] = clients;
  const publishAlice = { give: { 17: 1 }, want: [1], mode: 'quick' };
  const publishKey = randomUUID();
  await request(alice, '/listings', { method: 'POST', body: publishAlice, key: publishKey });
  const duplicates = await Promise.all([bob, carol].map(client => request(client, '/listings', {
    method: 'POST', body: { give: { 1: 1 }, want: [17], mode: 'quick' },
  })));
  assert.equal(duplicates.reduce((sum, result) => sum + result.matches.length, 0), 1, 'A card was allocated more than once');
  const winner = duplicates[0].matches.length ? bob : carol;
  const outsider = winner === bob ? carol : bob;
  const active = await request(alice, '/state');
  const mid = active.matches[0].id;
  assert.equal(active.matches[0].partner.uid, undefined);
  report.push('真实并发竞争同一张牌：只分配一次');
  await request(outsider, `/matches/${mid}/reveal`, { method: 'POST', expected: 404 });
  const revealKey = randomUUID();
  assert.equal((await request(alice, `/matches/${mid}/reveal`, { method: 'POST', key: revealKey })).uid, '812345678');
  await request(alice, `/matches/${mid}/confirm`, { method: 'POST', body: { result: 'completed' } });
  await request(winner, `/matches/${mid}/confirm`, { method: 'POST', body: { result: 'completed' } });
  const finished = await request(alice, '/state');
  assert.equal(finished.history[0].status, 'completed');
  assert.equal(finished.history[0].partner.uid, undefined);
  assert.equal(finished.me.completedCount, 1);
  await request(alice, `/matches/${mid}/reveal`, { method: 'POST', key: revealKey, expected: 409 });
  await request(alice, '/listings', { method: 'POST', body: publishAlice, key: publishKey });
  assert.equal((await request(alice, '/state')).me.completedCount, 1);
  report.push('越权拒绝、按需展示 UID、完成结算和请求幂等成功');
  for (const path of ['/v1/rdb/rest/matches?select=*', '/v1/rdb/rest/rpc/swap_dispatch']) {
    const response = await fetch(`${config.apiBase}${path}`, { method: path.includes('/rpc/') ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
      ...(path.includes('/rpc/') ? { body: JSON.stringify({ p_auth_id: 'forged', p_action: 'state' }) } : {}) });
    assert.ok([401, 403, 404].includes(response.status), 'Client bypassed backend permissions');
  }
  report.push('客户端不能直读业务表或执行内部 RPC');
  const bili = { deviceId: randomUUID() };
  const biliSession = await request(bili, '/session', { method: 'POST', body: { provider: 'bili' } });
  await platform('/auth/v1/signin/custom', { provider_id: 'custom', ticket: biliSession.ticket }, bili);
  clients.push(bili);
  const biliState = await request(bili, '/state');
  assert.equal(biliState.me.accountType, 'bili');
  const restored = { deviceId: randomUUID() };
  const restoredSession = await request(restored, '/session', { method: 'POST', body: { provider: 'bili', credential: biliSession.credential } });
  assert.equal(restoredSession.credential, undefined);
  await platform('/auth/v1/signin/custom', { provider_id: 'custom', ticket: restoredSession.ticket }, restored);
  assert.equal((await request(restored, '/state')).me.accountId, biliState.me.accountId);
  report.push('真实 B站身份 Ticket 登录、密钥恢复和跨设备同账号成功');
  console.log(JSON.stringify({ ok: true, mode: useRemote ? 'deployed-api' : 'local-api-real-cloud', checks: report }, null, 2));
} finally {
  for (const client of clients) {
    if (!client.token) continue;
    try {
      const current = await request(client, '/state');
      if (current.listing) await request(client, '/listings/current', { method: 'DELETE' });
    } catch (error) { console.error(`Test cleanup: ${error.message}`); }
  }
  if (server) await new Promise(resolve => server.close(resolve));
}
