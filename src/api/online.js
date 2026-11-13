export class OnlineApiError extends Error {
  constructor(code, { message = code, status, retryAt } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAt = retryAt;
  }
}

async function createSdkAuth({ envId, publishableKey }) {
  // 按需加载登录模块，不在浏览器中引入服务端 SDK 或服务端密钥。
  const [{ default: cloudbase }, { registerAuth }] = await Promise.all([
    import('@cloudbase/js-sdk/app'), import('@cloudbase/js-sdk/auth'),
  ]);
  registerAuth(cloudbase);
  return { auth: cloudbase.init({ env: envId, region: 'ap-shanghai', accessKey: publishableKey,
    persistence: 'local', auth: { detectSessionInUrl: false } }).auth };
}

function checked(result) {
  if (result?.error) throw new OnlineApiError(result.error.code || 'AUTH_ERROR', { message: result.error.message });
  return result?.data;
}

export function normalizeState(state) {
  return { ...state, matches: [...state.matches, ...state.history],
    quotaLeft: state.quota.left, resetAt: state.quota.resetAt, completedCount: state.me.completedCount };
}

export function createOnlineApi({ apiBase, storage, fetcher = fetch, createAuth = createSdkAuth, uuid = () => crypto.randomUUID() }) {
  if (!/^https:\/\//.test(apiBase)) throw new Error('线上 API 地址必须使用 HTTPS');
  const base = apiBase.replace(/\/$/, '');
  const deviceId = storage.get('deviceId') || uuid();
  storage.set('deviceId', deviceId);
  let config;
  let auth;
  let initializing;
  let signingIn;
  let listing = null;
  let stats = { waiting: 0 };
  let lastState;

  async function request(path, { method = 'GET', body, authenticated = true } = {}) {
    const headers = { 'X-Device-Id': deviceId };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['Idempotency-Key'] = uuid();
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    let refreshed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (authenticated) {
        const session = checked(await auth.getSession())?.session;
        if (!session?.access_token) throw new OnlineApiError('UNAUTHENTICATED', { message: '登录已失效，请刷新页面重试' });
        headers.Authorization = `Bearer ${session.access_token}`;
      }
      let response;
      try {
        response = await fetcher(`${base}${path}`, { method, headers, body: serialized, signal: AbortSignal.timeout(25000) });
      } catch {
        // 同一请求自动重试一次，保持幂等键与请求体不变；建立 B站身份的入口不自动重试。
        if (attempt === 0 && path !== '/session') continue;
        throw new OnlineApiError('NETWORK_ERROR', { message: '无法连接线上服务，请检查网络后重试' });
      }
      if (response.status === 401 && authenticated && !refreshed) {
        checked(await auth.refreshSession());
        refreshed = true;
        continue;
      }
      let result;
      try { result = await response.json(); }
      catch { throw new OnlineApiError('INVALID_RESPONSE', { message: '线上服务返回了无效响应' }); }
      if (!response.ok) throw new OnlineApiError(result.error?.code || 'BACKEND_ERROR', {
        status: response.status, retryAt: result.error?.retryAt, message: result.error?.message,
      });
      return result;
    }
    throw new OnlineApiError('UNAUTHENTICATED');
  }

  async function init() {
    if (!initializing) initializing = (async () => {
      config = await request('/config', { authenticated: false });
      if (!config.cloudbase?.envId || !config.cloudbase?.publishableKey) throw new OnlineApiError('AUTH_NOT_CONFIGURED');
      ({ auth } = await createAuth(config.cloudbase));
      // SDK 自行维护和续期真实会话；应用快照不保存访问令牌。
      auth.onAuthStateChange(event => {
        if (event === 'SIGNED_OUT') { listing = null; stats = { waiting: 0 }; lastState = undefined; }
      });
      return config;
    })().catch(error => { initializing = undefined; throw error; });
    return initializing;
  }

  const api = {
    init,
    async createSession(accountType = 'anon', credential) {
      await init();
      if (signingIn) return signingIn;
      signingIn = (async () => {
        let newCredential;
        if (accountType === 'bili') {
          const session = await request('/session', { method: 'POST', authenticated: false,
            body: { provider: 'bili', ...(credential ? { credential } : {}) } });
          checked(await auth.signInWithCustomTicket(() => Promise.resolve(session.ticket)));
          newCredential = session.credential;
        } else {
          const current = checked(await auth.getSession())?.session;
          // 独立站本来就采用匿名账号；只在初次访问时建立身份，不用它掩盖业务鉴权失败。
          if (!current) checked(await auth.signInAnonymously());
        }
        const realSession = checked(await auth.getSession())?.session;
        if (!realSession?.access_token) throw new OnlineApiError('UNAUTHENTICATED');
        return { accountType, ...(newCredential ? { credential: newCredential } : {}) };
      })();
      try { return await signingIn; } finally { signingIn = undefined; }
    },
    updateProfile: data => request('/me', { method: 'PUT', body: data }),
    async getState(_server, { light = false } = {}) {
      let received = await request(light && lastState ? '/state?light=1' : '/state');
      if (received.history === null && lastState?.matches.some(old => !received.matches.some(m => m.id === old.id))) {
        // 自动结算或另一设备确认后，补拉最终记录，匹配详情才能立即显示已完成。
        received = await request('/state');
      }
      const complete = { ...received, history: received.history ?? lastState?.history ?? [],
        stats: received.stats ?? lastState?.stats ?? { waiting: 0 },
        nextHistoryCursor: received.history === null ? lastState?.nextHistoryCursor : received.nextHistoryCursor };
      lastState = complete;
      const state = normalizeState(complete);
      listing = state.listing;
      stats = state.stats;
      return state;
    },
    async publish({ give, want, note, mode }) {
      const result = await request('/listings', { method: 'POST', body: { give, want, note, mode: mode === 'full' ? 'box' : 'quick' } });
      listing = result.listing;
      return result;
    },
    async editListing({ give, want, note }) {
      if (!listing) throw new OnlineApiError('NO_LISTING');
      const result = await request('/listings/current', { method: 'PATCH', body: { give, want, note, version: listing.version } });
      listing = result.listing;
      return result;
    },
    async withdraw() {
      const result = await request('/listings/current', { method: 'DELETE' });
      listing = null;
      return result;
    },
    rematch: () => request('/listings/current/rematch', { method: 'POST' }),
    reveal: id => request(`/matches/${encodeURIComponent(id)}/reveal`, { method: 'POST' }),
    confirm: (id, body) => request(`/matches/${encodeURIComponent(id)}/confirm`, { method: 'POST', body }),
    feedback: (id, body) => request(`/matches/${encodeURIComponent(id)}/feedback`, { method: 'POST', body }),
    getAuthorMid: async () => (await init()).authorMid,
    stats: () => stats,
  };
  return api;
}
