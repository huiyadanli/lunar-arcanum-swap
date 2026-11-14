const ERRORS = {
  ADMIN_FORBIDDEN: '没有管理权限：请检查密码或管理员名单。',
  ADMIN_PASSWORD_REQUIRED: '请输入管理密码。',
  ADMIN_NOT_CONFIGURED: '管理密码尚未配置，请联系部署维护者。',
  ADMIN_RATE_LIMITED: '密码尝试过于频繁，请在五分钟后重试。',
  UNAUTHENTICATED: '当前登录已失效，请关闭后台并重新登录。',
  INVALID_ADMIN_QUERY: '查询条件无效，请调整后重试。',
};

/** 管理状态与个人业务快照隔离；密码只在闭包内，关闭后丢弃。 */
export function createAdminController({ query, onChange = () => {} }) {
  let password = '';
  let revision = 0;
  let closed = false;
  const state = { view: 'overview', server: '', status: '', accountType: '', search: '', accountId: '',
    page: 1, pageSize: 50, data: null, detail: null, loading: false, authorized: false, error: '' };
  const emit = () => { if (!closed) onChange(state); };
  async function load() {
    if (closed) return;
    const current = ++revision;
    state.loading = true; state.error = ''; state.detail = null; emit();
    try {
      const result = await query({ view: state.view, server: state.server, status: state.status,
        accountType: state.accountType, search: state.search, accountId: state.accountId,
        page: state.page, pageSize: state.pageSize, ...(password ? { password } : {}) });
      if (closed || current !== revision) return;
      state.data = result; state.authorized = true;
    } catch (error) {
      if (closed || current !== revision) return;
      state.data = null;
      state.error = ERRORS[error.code] || '管理查询暂时不可用，请稍后重试。';
      if (error.status === 401 || error.status === 403 || ['ADMIN_PASSWORD_REQUIRED', 'ADMIN_FORBIDDEN', 'ADMIN_NOT_CONFIGURED'].includes(error.code)) {
        password = ''; state.authorized = false;
      }
    } finally {
      if (!closed && current === revision) { state.loading = false; emit(); }
    }
  }
  return {
    state, load,
    unlock(value) { password = value; return load(); },
    select(view, accountId = '') {
      Object.assign(state, { view, accountId, status: '', search: '', accountType: '', page: 1, detail: null });
      // 用户可能曾经更换过区服；查看关联记录时默认展示该账号全部历史。
      if (accountId) state.server = '';
      return load();
    },
    filter(values) { Object.assign(state, values, { page: 1 }); return load(); },
    page(value) { state.page = value; return load(); },
    detail(item) { state.detail = item; emit(); },
    close() {
      closed = true; revision++; password = '';
      state.data = null; state.detail = null; state.authorized = false; state.loading = false;
    },
  };
}
