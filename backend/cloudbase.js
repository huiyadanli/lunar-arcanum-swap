import cloudbase from '@cloudbase/node-sdk';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { ApiError, upstreamError } from './errors.js';
import { maintenanceSignature, SCHEDULE_PREFIX } from './maintenance-scheduler.js';
import resources from './runtime-resources.json' with { type: 'json' };

export function createCloudBaseService(config, fetcher = fetch) {
  const base = config.apiBase.replace(/\/$/, '');
  const hash = value => createHmac('sha256', config.hmacSecret).update(value).digest('hex');
  let signingAuth;

  async function jsonRequest(path, options) {
    let response;
    try {
      response = await fetcher(`${base}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    } catch { throw new ApiError('BACKEND_UNAVAILABLE', 503); }
    let body;
    try { body = await response.json(); } catch { throw new ApiError('BACKEND_UNAVAILABLE', 503); }
    if (!response.ok) {
      if (path.startsWith('/auth/') && [401, 403].includes(response.status)) throw new ApiError('UNAUTHENTICATED', 401);
      throw upstreamError(body, response.status);
    }
    return body;
  }
  async function rpc(name, params) {
    return jsonRequest(`/v1/rdb/rest/rpc/${name}`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.serverKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }
  async function authenticate(token, deviceId) {
    // 使用平台校验接口，绝不信任客户端自行解码的 JWT、UID 或请求头里的账号 ID。
    const headers = { Authorization: `Bearer ${token}` };
    if (deviceId) headers['x-device-id'] = deviceId;
    let identity;
    try { identity = await jsonRequest('/auth/v1/token/introspect', { headers }); }
    catch (error) {
      if (error instanceof ApiError && error.status === 503) throw error;
      throw new ApiError('UNAUTHENTICATED', 401);
    }
    if (typeof identity.sub !== 'string' || !identity.sub || identity.client_id !== config.envId) throw new ApiError('UNAUTHENTICATED', 401);
    let customId = null;
    if (!String(identity.scope || '').split(' ').includes('anonymous')) {
      const profile = await jsonRequest('/auth/v1/user/me', { headers });
      if (profile.sub !== identity.sub) throw new ApiError('UNAUTHENTICATED', 401);
      const custom = profile.providers?.find(provider => provider.id === 'custom');
      if (custom) {
        if (typeof custom.provider_user_id !== 'string' || !/^b_[a-f0-9]{24}$/.test(custom.provider_user_id)) throw new ApiError('UNAUTHENTICATED', 401);
        customId = custom.provider_user_id;
      } else {
        // 本站只接受匿名身份和由本站签票的 Toy 身份。
        throw new ApiError('UNAUTHENTICATED', 401);
      }
    }
    return { authId: identity.sub, customId };
  }
  function rateKeys(context) {
    const keys = [];
    if (context.ip) keys.push(`ip:${hash(context.ip)}`);
    if (context.deviceId) keys.push(`device:${hash(context.deviceId)}`);
    return keys;
  }
  async function session(input, context) {
    if (!config.customLoginKey) throw new ApiError('SIGNING_NOT_CONFIGURED', 503);
    if (!signingAuth) signingAuth = cloudbase.init({ env: config.envId, accessKey: config.serverKey, credentials: config.customLoginKey }).auth();
    const credential = input.credential ? null : randomBytes(32).toString('base64url');
    const result = await rpc('swap_bili_session', {
      p_credential_hash: input.credential ? hash(`credential:${input.credential}`) : null,
      p_new_id: credential ? `b_${randomBytes(12).toString('hex')}` : null,
      p_new_credential_hash: credential ? hash(`credential:${credential}`) : null,
      p_rate_keys: rateKeys(context),
    });
    const ticket = await signingAuth.createTicket(result.customUserId);
    return credential ? { ticket, credential } : { ticket };
  }
  async function execute(identity, action, data, context) {
    const normalized = { ...data };
    if (normalized.toyOpenId) {
      normalized.toyOpenIdHmac = hash(`toy:${normalized.toyOpenId}`);
      delete normalized.toyOpenId;
    }
    const fingerprint = context.requestKey ? hash(JSON.stringify({ action, data: normalized })) : null;
    if (config.maintenanceSignals && action !== 'state') {
      const nonce = randomUUID();
      const issuedAt = Date.now();
      const wake = await jsonRequest('/v1/functions/swap-maintenance', { method: 'POST',
        headers: { Authorization: `Bearer ${config.serverKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'wake', nonce, issuedAt,
          signature: maintenanceSignature(config.hmacSecret, 'wake', nonce, issuedAt) }) });
      if (!Number.isSafeInteger(wake.leaseUntil) || wake.leaseUntil <= Date.now() || wake.leaseUntil > Date.now() + 180000) {
        throw new ApiError('MAINTENANCE_UNAVAILABLE', 503);
      }
      normalized._maintenanceLeaseUntil = wake.leaseUntil;
    }
    const result = await rpc('swap_dispatch', {
      p_auth_id: identity.authId, p_custom_id: identity.customId, p_action: action, p_data: normalized,
      p_request_key: context.requestKey || null,
      p_fingerprint: fingerprint,
      p_rate_keys: rateKeys(context),
    });
    if (action === 'state' && result.nextHistoryCursor) result.nextHistoryCursor = Buffer.from(JSON.stringify(result.nextHistoryCursor)).toString('base64url');
    return result;
  }
  return { authenticate, execute, session, maintenance: () => rpc('swap_maintenance', {}) };
}

export function loadConfig(env = process.env) {
  const envId = env.TCB_ENV;
  const serverKey = env.CLOUDBASE_APIKEY;
  const hmacSecret = env.SWAP_HMAC_SECRET;
  const projectResources = envId === resources.envId ? resources : null;
  const maintenanceEnabled = env.SWAP_MAINTENANCE_ENABLED !== 'false' && Boolean(projectResources?.maintenanceEnabled || env.SWAP_MAINTENANCE_BUCKET);
  if (!envId || !serverKey || !hmacSecret || hmacSecret.length < 32) throw new Error('Missing backend environment configuration');
  let customLoginKey = null;
  if (env.SWAP_CUSTOM_LOGIN_KEY) {
    customLoginKey = JSON.parse(env.SWAP_CUSTOM_LOGIN_KEY);
    if (customLoginKey.env_id !== envId || !customLoginKey.private_key || !customLoginKey.private_key_id) throw new Error('Invalid custom login key configuration');
  } else if (env.SWAP_CUSTOM_LOGIN_PRIVATE_KEY || env.SWAP_CUSTOM_LOGIN_KEY_ID) {
    if (!env.SWAP_CUSTOM_LOGIN_PRIVATE_KEY || !env.SWAP_CUSTOM_LOGIN_KEY_ID) throw new Error('Incomplete custom login key configuration');
    customLoginKey = { env_id: envId, private_key: env.SWAP_CUSTOM_LOGIN_PRIVATE_KEY, private_key_id: env.SWAP_CUSTOM_LOGIN_KEY_ID };
  }
  return {
    envId, serverKey, hmacSecret, customLoginKey,
    apiBase: env.CLOUDBASE_API_BASE || `https://${envId}.api.tcloudbasegateway.com`,
    publishableKey: env.CLOUDBASE_PUBLISHABLE_KEY || '', authorMid: env.SWAP_AUTHOR_MID || '',
    maintenanceSignals: maintenanceEnabled && env.SWAP_MAINTENANCE_SIGNALS !== 'false',
    maintenanceBucket: maintenanceEnabled ? (env.SWAP_MAINTENANCE_BUCKET || projectResources?.maintenanceBucket || '') : '',
    maintenanceRegion: env.SWAP_MAINTENANCE_REGION || projectResources?.maintenanceRegion || 'ap-shanghai',
    maintenancePrefix: SCHEDULE_PREFIX,
    trustProxy: ['true', 'enabled'].includes(env.SWAP_TRUST_PROXY),
    corsOrigins: (env.SWAP_CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    gatewayCors: !['false', 'disabled'].includes(env.SWAP_GATEWAY_CORS),
  };
}
