// 原型调试配置：URL 参数 ?mock=bili|anon 或 ?env=toy-app|toy-web|standalone
// 选择会持久化，刷新后保持；调试面板里也可以切换。
// 用户类型不单独配置，由环境推导（设计文档 3.2）：Toy 中已登录 = B站用户，其余 = 匿名用户。

import { storage } from '../lib/storage.js';

const DEFAULTS = {
  env: 'standalone',     // 'toy-app' | 'toy-web' | 'standalone'
  loggedIn: true,        // Toy 环境中是否已登录 B站
  following: false,      // 是否已关注 UP主（模拟 getAuthorRelation）
  instantMatch: 'random' // 发布时是否立即匹配：'random' | 'always' | 'never'
};

function fromUrl() {
  const q = new URLSearchParams(location.search);
  const out = {};
  const mock = q.get('mock');
  if (mock === 'bili') Object.assign(out, { env: 'toy-app', loggedIn: true });
  if (mock === 'anon') Object.assign(out, { env: 'standalone' });
  const env = q.get('env');
  if (['toy-app', 'toy-web', 'standalone'].includes(env)) out.env = env;
  return out;
}

export const dev = { ...DEFAULTS, ...storage.get('dev', {}), ...fromUrl() };
storage.set('dev', dev);

export function setDev(patch, reload = false) {
  Object.assign(dev, patch);
  storage.set('dev', dev);
  if (reload) {
    const url = new URL(location.href);
    url.searchParams.delete('mock');
    url.searchParams.delete('env');
    location.replace(url.toString());
  }
}
