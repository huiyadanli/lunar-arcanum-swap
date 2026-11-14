import test from 'node:test';
import assert from 'node:assert/strict';
import { publishQuota, PUBLISH_COOLDOWN_MS } from '../src/lib/publish-cooldown.js';
import { statePollDelay } from '../src/lib/state-polling.js';

test('发布额度按十分钟边界恢复，不依赖日期、服务器或维护任务', () => {
  const usedAt = Date.UTC(2026, 10, 14, 19, 59);
  assert.equal(PUBLISH_COOLDOWN_MS, 600000);
  assert.deepEqual(publishQuota(usedAt, usedAt + 599999), { quotaLeft: 0, resetAt: usedAt + 600000 });
  assert.deepEqual(publishQuota(usedAt, usedAt + 600000), { quotaLeft: 1, resetAt: usedAt + 600000 });
  assert.equal(publishQuota(0, usedAt).quotaLeft, 1);
});

test('空闲冷却只安排到期刷新；活跃轮询不推迟到期检查，隐藏页不访问', () => {
  const now = 1000000;
  const cooldown = { now, quotaLeft: 0, resetAt: now + 600000 };
  assert.equal(statePollDelay(cooldown), 600000);
  assert.equal(statePollDelay({ ...cooldown, resetAt: now + 500, matches: [{ status: 'matched' }] }), 500);
  assert.equal(statePollDelay({ ...cooldown, matches: [{ status: 'matched' }] }), 10000);
  assert.equal(statePollDelay({ ...cooldown, visible: false }), null);
  assert.equal(statePollDelay({ ...cooldown, quotaLeft: 1 }), null);
  assert.equal(statePollDelay({ ...cooldown, resetAt: now - 1 }), 10000);
});

test('模拟后端：发布与重新匹配十分钟共用冷却，撤回立即恢复', async () => {
  globalThis.location = { search: '' };
  const { api } = await import('../src/mock/api.js');
  const { dev } = await import('../src/mock/dev.js');
  const { storage } = await import('../src/lib/storage.js');
  const originalNow = Date.now;
  let now = Date.UTC(2026, 10, 14, 19, 59);
  Date.now = () => now;
  dev.instantMatch = 'never';
  storage.remove('mockdb');
  try {
    const request = { give: { 17: 1 }, want: [1], server: 'asia', mode: 'quick', note: null };
    await api.publish(request);
    const first = await api.getState('asia');
    assert.equal(first.quotaLeft, 0);
    assert.equal(first.resetAt, now + 600000);
    await assert.rejects(api.rematch('asia'), e => e.code === 'DAILY_LIMIT' && e.retryAt === first.resetAt);
    now += 600000;
    assert.equal((await api.getState('asia')).quotaLeft, 1);
    await api.rematch('asia');
    assert.equal((await api.getState('asia')).resetAt, now + 600000);
    await api.withdraw();
    assert.equal((await api.getState('asia')).quotaLeft, 1);
    await api.publish(request);
    assert.equal((await api.getState('asia')).quotaLeft, 0);
  } finally {
    Date.now = originalNow;
    storage.remove('mockdb');
    delete globalThis.location;
  }
});
