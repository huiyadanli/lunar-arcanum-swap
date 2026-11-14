// 发布与重新匹配共用冷却：B站授权账号 1 分钟，匿名账号 20 分钟；撤回需求或成功结算后立即恢复。
export const PUBLISH_COOLDOWN_BILI_MS = 60e3;
export const PUBLISH_COOLDOWN_ANON_MS = 20 * 60e3;

export function publishCooldownMs(accountType) {
  return accountType === 'bili' ? PUBLISH_COOLDOWN_BILI_MS : PUBLISH_COOLDOWN_ANON_MS;
}

export function publishQuota(usedAt, now = Date.now(), accountType = 'anon') {
  const resetAt = usedAt ? usedAt + publishCooldownMs(accountType) : now;
  return { quotaLeft: resetAt > now ? 0 : 1, resetAt };
}
