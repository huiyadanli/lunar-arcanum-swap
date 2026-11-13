// localStorage 的安全封装：隐私模式或被禁用时静默降级为内存存储。

import { ONLINE_BACKEND, API_BASE_URL } from '../config.js';

// 保留原型数据；不同线上 API 的 Box、UID 和偏好也各自独立。
const PREFIX = ONLINE_BACKEND ? `las.online.${encodeURIComponent(API_BASE_URL)}.` : 'las.';
const memory = new Map();

function backend() {
  try {
    const k = PREFIX + '__probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    return null;
  }
}

const ls = backend();

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = ls ? ls.getItem(PREFIX + key) : memory.get(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    const raw = JSON.stringify(value);
    try {
      if (ls) ls.setItem(PREFIX + key, raw);
      else memory.set(key, raw);
    } catch {
      memory.set(key, raw);
    }
  },
  remove(key) {
    try {
      if (ls) ls.removeItem(PREFIX + key);
    } catch { /* ignore */ }
    memory.delete(key);
  },
  clearAll() {
    try {
      if (ls) Object.keys(ls).filter((k) => k.startsWith(PREFIX)).forEach((k) => ls.removeItem(k));
    } catch { /* ignore */ }
    memory.clear();
  },
};
