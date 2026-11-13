import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaintenanceScheduler, maintenanceSignature, SCHEDULE_PREFIX, WAKE_LEASE_MS } from '../backend/maintenance-scheduler.js';
import { statePollDelay } from '../src/lib/state-polling.js';

const secret = 'test-server-secret';
const time = 1800000000000;
const timer = { Type: 'Timer', TriggerName: 'every-minute' };
const signed = action => ({ action, issuedAt: time, nonce: 'test-nonce', signature: maintenanceSignature(secret, action, 'test-nonce', time) });
const key = (kind, due, id = 'test-task') => `${SCHEDULE_PREFIX}${kind}/${due}/${id}.json`;
function harness(keys = [], maintain = async () => ({ processed: 1, nextDueAt: time + 600000 })) {
  const objects = new Set(keys);
  let calls = 0;
  const store = { list: async () => [...objects], put: async k => { objects.add(k); }, remove: async list => { list.forEach(k => objects.delete(k)); } };
  const scheduler = createMaintenanceScheduler({ store, secret, now: () => time, timerSource: true,
    maintain: async () => { calls++; return maintain(); } });
  return { scheduler, objects, store, calls: () => calls };
}

test('没有任务或任务尚未到期时只检查存储，不访问数据库', async () => {
  for (const keys of [[], [key('plan', time + 600000)], [key('wake', time + WAKE_LEASE_MS)]]) {
    const h = harness(keys);
    assert.equal((await h.scheduler(timer)).databaseAccessed, false);
    assert.equal(h.calls(), 0);
    assert.deepEqual([...h.objects], keys);
  }
});

test('持久化成功后才返回写入租约；重启后仍能处理唤醒', async () => {
  const h = harness();
  const wake = await h.scheduler(signed('wake'));
  assert.equal(wake.leaseUntil, time + WAKE_LEASE_MS);
  assert.ok(h.objects.has(key('wake', wake.leaseUntil, 'test-nonce')));
  const restarted = createMaintenanceScheduler({ store: h.store, secret, now: () => time + WAKE_LEASE_MS, timerSource: true,
    maintain: async () => ({ processed: 1, nextDueAt: null }) });
  assert.equal((await restarted(timer)).processed, 1);
  assert.equal(h.objects.size, 0);
});

test('到期后先保存下一次计划，再删除旧快照；新的写入信号不会被删除', async () => {
  const old = key('plan', time - 1);
  const young = key('wake', time + WAKE_LEASE_MS);
  const h = harness([old, young]);
  assert.equal((await h.scheduler(timer)).databaseAccessed, true);
  assert.equal(h.calls(), 1);
  assert.equal(h.objects.has(old), false);
  assert.equal(h.objects.has(young), true);
  assert.ok([...h.objects].some(k => k.startsWith(`${SCHEDULE_PREFIX}plan/${time + 600000}/`)));
});

test('数据库或下一次计划写入失败时保留旧信号供下一轮重试', async () => {
  const old = key('wake', time - 1);
  const h = harness([old], async () => { throw Error('database unavailable'); });
  await assert.rejects(h.scheduler(timer), /database unavailable/);
  assert.equal(h.objects.has(old), true);
  const retry = harness([old]);
  retry.store.put = async () => { throw Error('storage unavailable'); };
  await assert.rejects(retry.scheduler(timer), /storage unavailable/);
  assert.equal(retry.objects.has(old), true);
});

test('并发维护的旧结果不会覆盖新结果或删除新任务', async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const h = harness([key('plan', time - 1)], async () => { entered(); await gate; return { processed: 0, nextDueAt: time + 600000 }; });
  const first = h.scheduler(timer);
  await ready;
  h.objects.add(key('wake', time - 1, 'new-write'));
  const second = createMaintenanceScheduler({ store: h.store, secret, now: () => time, timerSource: true,
    maintain: async () => ({ processed: 0, nextDueAt: time + 60000 }) });
  await second(timer);
  release(); await first;
  assert.ok([...h.objects].some(k => k.startsWith(`${SCHEDULE_PREFIX}plan/${time + 60000}/`)));
});

test('不接受伪造、过期签名；检查任务状态不访问数据库', async () => {
  const h = harness([key('plan', time - 1)]);
  for (const event of [{}, { ...signed('wake'), signature: '0'.repeat(64) }, { ...signed('wake'), issuedAt: time - WAKE_LEASE_MS - 1 }]) {
    await assert.rejects(h.scheduler(event), /MAINTENANCE_UNAUTHORIZED/);
  }
  assert.equal((await h.scheduler(signed('inspect'))).databaseAccessed, false);
  assert.equal(h.calls(), 0);
  const forged = createMaintenanceScheduler({ store: h.store, secret, now: () => time, maintain: async () => assert.fail('forged timer') });
  await assert.rejects(forged(timer), /MAINTENANCE_UNAUTHORIZED/);
});

test('轮询仅在可见且存在需求或进行中交换时启动', () => {
  assert.equal(statePollDelay({ matches: [] }), null);
  assert.equal(statePollDelay({ matches: [{ status: 'completed' }] }), null);
  assert.equal(statePollDelay({ listing: { give: { 17: 1 }, want: [1] } }), 30000);
  assert.equal(statePollDelay({ matches: [{ status: 'confirming' }] }), 10000);
  assert.equal(statePollDelay({ matches: [{ status: 'matched' }], visible: false }), null);
});
