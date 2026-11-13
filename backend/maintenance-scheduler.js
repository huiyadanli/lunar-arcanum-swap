import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const WAKE_LEASE_MS = 120000;
export const SCHEDULE_PREFIX = '_swap-maintenance/v1/';

export function maintenanceSignature(secret, action, nonce, issuedAt) {
  return createHmac('sha256', secret).update(`maintenance:${action}:${nonce}:${issuedAt}`).digest('hex');
}

function authorized(event, secret, now) {
  if (!['wake', 'inspect', 'tick', 'run'].includes(event.action) || !/^[\w-]{8,128}$/.test(event.nonce || '') ||
      !Number.isSafeInteger(event.issuedAt) || Math.abs(now - event.issuedAt) > WAKE_LEASE_MS ||
      !/^[a-f\d]{64}$/.test(event.signature || '')) return false;
  return timingSafeEqual(Buffer.from(event.signature, 'hex'),
    Buffer.from(maintenanceSignature(secret, event.action, event.nonce, event.issuedAt), 'hex'));
}

export function createMaintenanceScheduler({ store, maintain, secret, prefix = SCHEDULE_PREFIX, now = Date.now, uuid = randomUUID, timerSource = false }) {
  function task(key) {
    if (!key.startsWith(prefix)) return null;
    const found = /^(wake|plan)\/(\d{13})\/[\w-]+\.json$/.exec(key.slice(prefix.length));
    return found ? { key, kind: found[1], dueAt: Number(found[2]) } : null;
  }
  async function put(kind, at, id = uuid()) {
    await store.put(`${prefix}${kind}/${Math.floor(at)}/${id}.json`, '{}');
  }
  return async function schedule(event = {}) {
    const startedAt = now();
    const timer = timerSource && event.Type === 'Timer' && event.TriggerName === 'every-minute';
    if (!timer && !authorized(event, secret, startedAt)) throw new Error('MAINTENANCE_UNAUTHORIZED');
    if (event.action === 'wake') {
      const leaseUntil = startedAt + WAKE_LEASE_MS;
      // 先持久化，再允许业务写入。没有共享清单覆盖，多个实例各写各的信号。
      await put('wake', leaseUntil, event.nonce);
      return { leaseUntil };
    }
    const snapshot = (await store.list(prefix)).map(task).filter(Boolean);
    const next = snapshot.length ? snapshot.reduce((min, t) => Math.min(min, t.dueAt), Infinity) : null;
    if (event.action === 'inspect') return { tasks: snapshot.length, nextDueAt: next, databaseAccessed: false };
    if (event.action !== 'run' && !snapshot.some(t => t.dueAt <= startedAt)) {
      return { processed: 0, skipped: true, nextDueAt: next, databaseAccessed: false };
    }
    const result = await maintain();
    if (!Object.hasOwn(result, 'nextDueAt') || (result.nextDueAt !== null && !Number.isFinite(result.nextDueAt))) {
      throw new Error('MAINTENANCE_PLAN_MISSING');
    }
    // 先写下一次计划，成功后才删本次快照；失败、重试、并发运行均不会丢任务。
    if (result.nextDueAt !== null) await put('plan', result.nextDueAt);
    await store.remove(snapshot.filter(t => t.kind === 'plan' || t.dueAt <= startedAt).map(t => t.key));
    return { ...result, skipped: false, databaseAccessed: true };
  };
}
