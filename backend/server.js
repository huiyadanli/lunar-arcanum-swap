import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { ApiError } from './errors.js';
import * as validate from './validation.js';

const routes = [
  ['GET', /^\/api\/v1\/config$/, 'config'],
  ['POST', /^\/api\/v1\/session$/, 'session'],
  ['PUT', /^\/api\/v1\/me$/, 'profile'],
  ['GET', /^\/api\/v1\/state$/, 'state'],
  ['POST', /^\/api\/v1\/listings$/, 'publish'],
  ['PATCH', /^\/api\/v1\/listings\/current$/, 'edit'],
  ['DELETE', /^\/api\/v1\/listings\/current$/, 'withdraw'],
  ['POST', /^\/api\/v1\/listings\/current\/rematch$/, 'rematch'],
  ['POST', /^\/api\/v1\/matches\/([^/]+)\/reveal$/, 'reveal'],
  ['POST', /^\/api\/v1\/matches\/([^/]+)\/confirm$/, 'confirm'],
  ['POST', /^\/api\/v1\/matches\/([^/]+)\/feedback$/, 'feedback'],
];

async function readBody(request) {
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength > 16384) throw new ApiError('BODY_TOO_LARGE', 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw new ApiError('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  if (!length) return {};
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 415);
  try { return validate.object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('INVALID_JSON', 400);
  }
}

export function createServer({ service, config, logger = console }) {
  return http.createServer({ requestTimeout: 20000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (request, response) => {
    const requestId = randomUUID();
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId };
    // 网关负责生产环境的跨域，避免生成两个 Access-Control-Allow-Origin。
    const origin = request.headers.origin;
    if (!config.gatewayCors && config.corsOrigins.includes(origin)) {
      Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type,Idempotency-Key,X-Device-Id' });
    }
    const send = (status, body) => { response.writeHead(status, headers); response.end(body === undefined ? undefined : JSON.stringify(body)); };
    try {
      if (request.method === 'OPTIONS') { send(204); return; }
      if ((request.url || '').length > 2048) throw new ApiError('URI_TOO_LONG', 414);
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') { send(200, { ok: true }); return; }
      const pathMatches = routes.filter(([, pattern]) => pattern.test(url.pathname));
      if (!pathMatches.length) throw new ApiError('NOT_FOUND', 404);
      const route = pathMatches.find(([method]) => method === request.method);
      if (!route) { headers.Allow = [...pathMatches.map(([method]) => method), 'OPTIONS'].join(','); throw new ApiError('METHOD_NOT_ALLOWED', 405); }
      const [, pattern, action] = route;
      const deviceId = request.headers['x-device-id'];
      if (deviceId !== undefined && (typeof deviceId !== 'string' || !/^[\w-]{8,128}$/.test(deviceId))) throw new ApiError('INVALID_DEVICE_ID', 400);
      const forwarded = config.trustProxy ? String(request.headers['x-forwarded-for'] || '').split(',').at(-1)?.trim() : null;
      const context = { deviceId, ip: forwarded && isIP(forwarded) ? forwarded : request.socket.remoteAddress };
      if (action === 'config') {
        // 只返回部署相关的公开配置；服务器、UID 规则、留言等静态数据随前端打包。
        send(200, { authorMid: config.authorMid,
          cloudbase: { envId: config.envId, publishableKey: config.publishableKey } });
        return;
      }
      if (action === 'session') {
        const body = await readBody(request);
        if (body.provider !== 'bili' || (body.credential !== undefined && (typeof body.credential !== 'string' || !/^[\w-]{43}$/.test(body.credential)))) throw new ApiError('INVALID_REQUEST', 422);
        send(200, await service.session({ credential: body.credential }, context)); return;
      }
      const authorization = request.headers.authorization;
      if (typeof authorization !== 'string' || !/^Bearer [\w.\/~+\-=]+$/.test(authorization) || authorization.length > 8192) throw new ApiError('UNAUTHENTICATED', 401);
      const identity = await service.authenticate(authorization.slice(7), deviceId);
      if (request.method !== 'GET') {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[\w-]{8,128}$/.test(key)) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 400);
        context.requestKey = key;
      }
      let data = {};
      if (action === 'state') data = { historyCursor: validate.historyCursor(url.searchParams.get('historyCursor')),
        ...(url.searchParams.get('light') === '1' ? { light: true } : {}) };
      else {
        const body = await readBody(request);
        if (action === 'profile') data = validate.profile(body);
        if (action === 'publish' || action === 'edit') data = validate.listing(body, action === 'edit');
        if (action === 'confirm') data = validate.confirmation(body);
        if (action === 'feedback') data = validate.feedback(body);
        if (['reveal', 'confirm', 'feedback'].includes(action)) data.matchId = validate.matchId(pattern.exec(url.pathname)[1]);
      }
      send(200, await service.execute(identity, action, data, context));
    } catch (error) {
      const known = error instanceof ApiError;
      const status = known ? error.status : 500;
      const code = known ? error.code : 'INTERNAL_ERROR';
      // 只记录状态和请求 ID；请求体、headers、平台上下文与密钥一律不回显。
      if (status >= 500) logger.error(JSON.stringify({ requestId, code, status }));
      if (!response.headersSent && !response.destroyed) send(status, { error: { code, message: code, ...(known && error.retryAt ? { retryAt: error.retryAt } : {}) }, requestId });
    }
  });
}
