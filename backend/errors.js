export class ApiError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export function upstreamError(body, status) {
  if (['P0001', 'DATABASE_P0001'].includes(body?.code)) {
    if (String(body.message).startsWith('SWAP_ERROR:')) {
      try {
        const detail = JSON.parse(body.message.slice('SWAP_ERROR:'.length));
        if (/^[A-Z][A-Z_]+$/.test(detail.code) && Number.isInteger(detail.status) && detail.status >= 400 && detail.status <= 599) {
          return new ApiError(detail.code, detail.status, Number.isFinite(detail.retryAt) ? { retryAt: detail.retryAt } : {});
        }
      } catch { /* 不返回平台未识别的错误文本。 */ }
    }
    if (!/^[A-Z][A-Z_]+$/.test(body.message || '')) return new ApiError('BACKEND_UNAVAILABLE', 503);
    let detail = {};
    try { detail = JSON.parse(body.details || '{}'); } catch { /* 非 JSON 详情不向客户端回显。 */ }
    const fallback = { NOT_FOUND: 404, NO_LISTING: 404, CREDENTIAL_INVALID: 401, UNAUTHENTICATED: 401,
      BILI_REQUIRED: 403, NOTE_TEXT_FORBIDDEN: 403, DAILY_LIMIT: 429, COOLDOWN: 429, RATE_LIMITED: 429,
      UID_REQUIRED: 422, INVALID_REQUEST: 422, INVALID_COMPLETED_PAIRS: 422, IDEMPOTENCY_KEY_REQUIRED: 400 };
    return new ApiError(body.message, Number.isInteger(detail.status) ? detail.status : (fallback[body.message] || 409),
      detail.retryAt ? { retryAt: detail.retryAt } : {});
  }
  return new ApiError(status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'BACKEND_UNAVAILABLE', status === 429 ? 429 : 503);
}
