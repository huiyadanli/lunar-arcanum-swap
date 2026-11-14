export function statePollDelay({ listing, matches = [], visible = true, quotaLeft = 1, resetAt = 0, now = Date.now() }) {
  if (!visible) return null;
  const delay = matches.some(m => ['matched', 'confirming'].includes(m.status)) ? 10000
    : listing && Object.values(listing.give).some(q => q > 0) && listing.want.length ? 30000 : null;
  // 冷却到期补拉一次状态；空闲时不持续轮询，失败后也不进行零间隔重试。
  if (!quotaLeft && resetAt > 0) return Math.min(delay ?? Infinity, resetAt > now ? resetAt - now : 10000);
  return delay;
}
