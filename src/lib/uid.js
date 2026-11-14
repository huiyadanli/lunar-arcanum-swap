// UID → 服务器识别与脱敏（设计文档 2.5、5.4）。
// 静态规则随前端打包，后端复用同一模块校验提交的 UID，不再通过 /config 下发。

export const SERVERS = {
  celestia: { region: 'cn', name: { 'zh-CN': '天空岛', en: 'Celestia' }, tone: 'gold', tz: 8 },
  // 同属国服不代表可以互加好友：世界树必须使用独立的匹配分区。
  irminsul: { region: 'cn_bili', name: { 'zh-CN': '世界树', en: 'Irminsul' }, tone: 'gold', tz: 8 },
  asia: { region: 'asia', name: { 'zh-CN': '亚服', en: 'Asia' }, tone: 'cyan', tz: 8 },
  america: { region: 'us', name: { 'zh-CN': '美服', en: 'America' }, tone: 'blue', tz: -5 },
  europe: { region: 'eu', name: { 'zh-CN': '欧服', en: 'Europe' }, tone: 'violet', tz: 1 },
  tw: { region: 'tw', name: { 'zh-CN': '港澳台服', en: 'TW·HK·MO' }, tone: 'rose', tz: 8 },
};

export const NINE_DIGIT = { 1: 'celestia', 2: 'celestia', 3: 'celestia', 5: 'irminsul', 6: 'america', 7: 'europe', 8: 'asia', 9: 'tw' };
export const TEN_DIGIT_PREFIX = { 18: 'asia' };

/** 只做格式判断：纯数字、9/10 位、不是全同数字或顺序串。 */
export function isPlausibleUid(uid) {
  if (!/^\d{9,10}$/.test(uid)) return false;
  if (/^(\d)\1+$/.test(uid)) return false;
  if ('01234567890123'.includes(uid) || '98765432109876'.includes(uid)) return false;
  return true;
}

/**
 * @returns {{ state: 'empty'|'typing'|'ok'|'unknown'|'invalid', server?: string }}
 */
export function resolveUid(uid) {
  if (!uid) return { state: 'empty' };
  if (!/^\d*$/.test(uid)) return { state: 'invalid' };
  if (uid.length < 9) return { state: 'typing' };
  if (!isPlausibleUid(uid)) return { state: 'invalid' };
  const server = uid.length === 9 ? NINE_DIGIT[uid[0]] : TEN_DIGIT_PREFIX[uid.slice(0, 2)];
  return server ? { state: 'ok', server } : { state: 'unknown' };
}

/** 保留前 3 位和后 2 位：812345678 → 812****78 */
export function maskUid(uid) {
  if (!uid || uid.length < 6) return uid || '';
  return uid.slice(0, 3) + '*'.repeat(uid.length - 5) + uid.slice(-2);
}

/** 该服务器下一次 04:00 刷新的时间戳（ms）。 */
export function nextResetAt(serverKey, now = Date.now()) {
  const tz = SERVERS[serverKey]?.tz ?? 8;
  const local = new Date(now + tz * 3600e3);
  const reset = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 4);
  let at = reset - tz * 3600e3;
  if (at <= now) at += 24 * 3600e3;
  return at;
}
