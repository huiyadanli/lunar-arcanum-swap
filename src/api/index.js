import { ONLINE_BACKEND, API_BASE_URL } from '../config.js';
import { storage } from '../lib/storage.js';

// 分开加载，线上模式的请求失败时直接报错，不回退到模拟数据。
export const api = ONLINE_BACKEND
  ? (await import('./online.js')).createOnlineApi({ apiBase: API_BASE_URL, storage })
  : (await import('../mock/api.js')).api;
