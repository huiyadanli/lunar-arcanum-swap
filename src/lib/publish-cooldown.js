// 发布与重新匹配共用十分钟冷却；撤回需求或成功结算后立即恢复。
export const PUBLISH_COOLDOWN_MS = 10 * 60e3;

export function publishQuota(usedAt, now = Date.now()) {
  const resetAt = usedAt ? usedAt + PUBLISH_COOLDOWN_MS : now;
  return { quotaLeft: resetAt > now ? 0 : 1, resetAt };
}
