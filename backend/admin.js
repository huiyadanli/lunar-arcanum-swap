import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './errors.js';

const scrypt = promisify(scryptCallback);
const VIEWS = ['overview', 'waiting', 'matches', 'users', 'feedback'];
const SERVERS = ['celestia', 'irminsul', 'asia', 'america', 'europe', 'tw'];
const STATUSES = { waiting: ['waiting', 'closed'], matches: ['matched', 'confirming', 'completed', 'failed', 'expired', 'disputed'], feedback: ['pending', 'resolved'] };

/** 管理查询独立验参；身份、名单和密码验证结果不能从请求体透传。 */
export function adminQuery(input) {
  const invalid = () => { throw new ApiError('INVALID_ADMIN_QUERY', 422); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const view = input.view ?? 'overview';
  if (!VIEWS.includes(view)) invalid();
  const query = { view, page: input.page ?? 1, pageSize: input.pageSize ?? 50 };
  if (!Number.isInteger(query.page) || query.page < 1 || query.page > 1000000 ||
      !Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100) invalid();
  for (const key of ['id', 'accountId', 'search', 'server', 'status', 'accountType']) {
    if (input[key] === undefined || input[key] === '') continue;
    if (typeof input[key] !== 'string' || input[key].length > 128 || /[\u0000-\u001f]/.test(input[key])) invalid();
    query[key] = input[key].trim();
  }
  if (query.server && !SERVERS.includes(query.server)) invalid();
  if (query.accountType && !['anon', 'bili'].includes(query.accountType)) invalid();
  if (query.status && !STATUSES[view]?.includes(query.status)) invalid();
  if (query.id && ['waiting', 'matches', 'feedback'].includes(view) && !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(query.id)) invalid();
  if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 512)) invalid();
  return { query, password: input.password };
}

/** 实例内失败限流，不读写业务限流表，也不影响普通 API 请求。 */
export function createAdminHandler({ passwordHash = '', query, now = Date.now }) {
  const attempts = new Map();
  return async (identity, input, context) => {
    const normalized = adminQuery(input);
    let passwordVerified = false;
    if (!identity.customId) {
      const encoded = /^scrypt\$([a-f\d]{32})\$([a-f\d]{128})$/i.exec(passwordHash);
      if (!encoded) throw new ApiError('ADMIN_NOT_CONFIGURED', 503);
      if (!normalized.password) throw new ApiError('ADMIN_PASSWORD_REQUIRED', 403);
      const at = now();
      for (const [key, bucket] of attempts) if (bucket.until <= at) attempts.delete(key);
      const key = context.ip || identity.authId;
      if (!attempts.has(key)) {
        if (attempts.size >= 4096) throw new ApiError('ADMIN_RATE_LIMITED', 429);
        attempts.set(key, { used: 0, until: at + 300000 });
      }
      const bucket = attempts.get(key);
      if (bucket.used >= 5) throw new ApiError('ADMIN_RATE_LIMITED', 429, { retryAt: bucket.until });
      // 先占用名额，阻止并发密码计算；成功不消耗失败次数。
      bucket.used++;
      const derived = await scrypt(normalized.password, Buffer.from(encoded[1], 'hex'), 64);
      passwordVerified = timingSafeEqual(derived, Buffer.from(encoded[2], 'hex'));
      if (!passwordVerified) throw new ApiError('ADMIN_FORBIDDEN', 403);
      bucket.used--;
    }
    return query(identity, normalized.query, passwordVerified);
  };
}
