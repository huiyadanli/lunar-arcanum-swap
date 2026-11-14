// 平台适配层（设计文档 3.1、3.6、12.5）。
// 业务代码只调用这里导出的 platform，不直接使用 window.toy。
// 原型阶段：非 B站域名且 dev.env 为 toy-* 时注入模拟 SDK；真实 Toy 包里 window.toy 由按域名加载的平台脚本提供。

import { dev } from '../mock/dev.js';
import { createMockToy } from '../mock/toy-sdk.js';
import { createQrDataUrl } from '../lib/qrcode.js';
import { ONLINE_BACKEND } from '../config.js';
import { standaloneSiteUrl, biliToyPageUrl, isBiliToyUrl } from './exchange-site.js';
import { isBilibiliHost, loadToySdk } from './toy-sdk-loader.js';

/** 统一错误：kind = unsupported | rate_limited | not_logged_in | invalid | denied | unknown */
export class PlatformError extends Error {
  constructor(kind, cause) {
    super(`${kind}: ${cause?.message || cause || ''}`);
    this.kind = kind;
    this.cause = cause;
  }
}

function classify(err) {
  if (err instanceof PlatformError) return err;
  if (err?.type === 'http_error' && Number(err.code) === 307044) return new PlatformError('rate_limited', err);
  if (err?.type === 'unsupported') return new PlatformError('unsupported', err);
  if (err?.type === 'invalid_param') return new PlatformError('invalid', err);
  if (err?.type === 'user_denied') return new PlatformError('denied', err);
  return new PlatformError('unknown', err);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 限流时指数退避：2s → 4s → 8s，最多 3 次（设计文档 3.6）。 */
async function withBackoff(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = classify(e);
      if (err.kind !== 'rate_limited' || i >= 3) throw err;
      await sleep(2000 * 2 ** i);
    }
  }
}

const FEATURE_ABILITY = {
  share: 'share', shareImage: 'sharePicture', saveImage: 'saveImageToAlbum', qrcode: 'getQrCode', cloud: 'getCloudStorage',
  profile: 'getUserProfile', inputSafety: 'checkInputSafety', follow: 'getAuthorRelation',
  container: 'onContainerChange',
};

const AUTHOR_MID = '0'; // 正式版由 /config 的 authorMid 下发（服务端 SWAP_AUTHOR_MID 已配置）

export const platform = {
  env: 'standalone',
  /** 'bili' | 'anon' */
  accountType: 'anon',
  authorMid: AUTHOR_MID,
  /** Toy 中但未登录：提示「登录 B站 可跨设备同步」 */
  loginHint: false,
  features: {},

  async init() {
    let toy = await loadToySdk();
    if (!isBilibiliHost(location.hostname) && !ONLINE_BACKEND && dev.env !== 'standalone') {
      // 本地显式模拟仍可用，但不借用其他域名预先注入的真实 SDK。
      toy = window.toy = createMockToy();
    }
    this.features = {};
    this.author.isAuthor = false;
    if (!toy) {
      this.env = 'standalone';
    } else {
      this.env = (await safeSupport('closeBrowser')) ? 'toy-app' : 'toy-web';
      for (const [f, ability] of Object.entries(FEATURE_ABILITY)) this.features[f] = await safeSupport(ability);
    }
    // 独立站的浏览器替代能力
    if (this.env === 'standalone') {
      this.features = { share: true, shareImage: false, saveImage: true, qrcode: false, cloud: false, profile: false, inputSafety: false, follow: false, container: false };
    } else {
      this.features.share = true;     // toy-web 没有原生分享，但有 navigator.share / 复制链接兜底
      // App 内相册；SDK 激活时保留实际支持状态，只有独立站使用下载。
    }
    return this;
  },

  can(feature) {
    return !!this.features[feature];
  },

  /** 建立 B站身份的第一步：能读云存储 = 已登录（设计文档 3.3）。非限流错误一律按未登录处理。 */
  async probeLogin() {
    if (!this.can('cloud')) return { loggedIn: false };
    try {
      const data = await withBackoff(() => window.toy.getCloudStorage(['cred']));
      return { loggedIn: true, cred: data.cred || null };
    } catch {
      return { loggedIn: false };
    }
  },

  cloud: {
    async get(keys) {
      return withBackoff(() => window.toy.getCloudStorage(keys));
    },
    async set(items) {
      return withBackoff(() => window.toy.setCloudStorage(items));
    },
    async remove(keys) {
      return withBackoff(() => window.toy.removeCloudStorage(keys));
    },
  },

  /** 必须在用户手势中调用；拒绝或不支持时返回 null。 */
  async getProfile() {
    if (!this.can('profile')) return null;
    try {
      const p = await window.toy.getUserProfile();
      if (!p) return null;
      return { ...p, avatar: normalizeAvatarUrl(p.avatar) };
    } catch {
      return null;
    }
  },

  /** → 'ok' | 'rejected' | 'unavailable' */
  async checkText(text, scene) {
    if (!this.can('inputSafety')) return 'unavailable';
    try {
      const r = await window.toy.checkInputSafety({ text, scene });
      return r.passed ? 'ok' : r.status === 'rejected' ? 'rejected' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  },

  /** toy.share → navigator.share → 复制链接。返回 'shared' | 'copied' | 'cancelled' */
  async share({ title, text } = {}) {
    if (this.env === 'toy-app' && this.features.share) {
      await window.toy.share();
      return 'shared';
    }
    const url = biliToyPageUrl(location.href) || standaloneSiteUrl(location.href, import.meta.env.VITE_PUBLIC_SITE_URL || '');
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return 'shared';
      } catch {
        return 'cancelled';
      }
    }
    await copyText(url);
    return 'copied';
  },

  /** SDK 激活时直接分享图片，不用只分享 Toy 链接的 toy.share，也不回退到下载。 */
  async shareImage({ dataUrl }) {
    if (this.env === 'standalone' || !this.can('shareImage') || typeof window.toy?.sharePicture !== 'function') {
      throw new PlatformError('unsupported', 'share_picture_unavailable');
    }
    try {
      await window.toy.sharePicture({ base64Data: dataUrl });
      return 'shared';
    } catch (error) {
      throw classify(error);
    }
  },

  /** App 内存相册，只有独立站走 <a download>；SDK 失败不触发下载。 */
  async saveImage({ dataUrl, name = 'image.png' }) {
    if (this.env !== 'standalone') {
      if (!this.can('saveImage') || typeof window.toy?.saveImageToAlbum !== 'function') {
        throw new PlatformError('unsupported', 'save_image_unavailable');
      }
      try {
        await window.toy.saveImageToAlbum({ base64Data: dataUrl });
        return 'album';
      } catch (error) {
        throw classify(error);
      }
    }
    // Blob URL 避免大体积 data URL 触发浏览器导航长度限制；同步创建以保留用户手势。
    const comma = dataUrl.indexOf(',');
    const mime = dataUrl.slice(0, comma).match(/^data:(image\/[^;]+);base64$/)?.[1];
    if (!mime) throw new PlatformError('invalid', 'invalid_image');
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const href = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
    return 'download';
  },

  async qrcode() {
    if (!this.can('qrcode')) return null;
    try {
      return (await window.toy.getQrCode()).base64;
    } catch {
      return null;
    }
  },

  /** 名片的链接与二维码成对返回，按运行平台区分，而不是按用户登录状态区分。 */
  async exchangeSite() {
    if (this.env === 'standalone') {
      const url = standaloneSiteUrl(location.href, import.meta.env.VITE_PUBLIC_SITE_URL || '');
      return { kind: 'standalone', url, qr: createQrDataUrl(url), source: 'local' };
    }
    if (this.can('qrcode')) {
      try {
        const result = await window.toy.getQrCode({ size: 320 });
        if (isBiliToyUrl(result.url) && /^data:image\/png;base64,/.test(result.base64)) {
          return { kind: 'bili', url: result.url, qr: result.base64, source: 'sdk', mock: !!window.toy.__mock };
        }
      } catch { /* 平台暂不可用时，仍只允许回退到真实的 B站 Toy 地址。 */ }
    }
    const url = biliToyPageUrl(location.href) || biliToyPageUrl(import.meta.env.VITE_BILIBILI_TOY_URL);
    if (!url) throw new PlatformError('unsupported', 'toy_url_unavailable');
    return { kind: 'bili', url, qr: createQrDataUrl(url), source: 'local', mock: !!window.toy?.__mock };
  },

  author: {
    isAuthor: false,
    /** true | false | null（作者本人也返回 true；null = 无法判断，调用方应放行，设计文档 5.5） */
    async isFollowing() {
      if (!platform.can('follow')) return null;
      try {
        const r = await window.toy.getAuthorRelation();
        if (r?.status !== 'ok') return null;
        this.isAuthor = r.data?.isAuthor === true;
        if (this.isAuthor) return true;
        // 缺失或格式异常不能当成“未关注”，否则作者或旧 SDK 会被误拦截。
        return typeof r.data?.isFollowing === 'boolean' ? r.data.isFollowing : null;
      } catch {
        return null;
      }
    },
    async profile() {
      if (platform.env === 'standalone' || !window.toy) return null;
      try {
        const r = await window.toy.getAuthorProfile();
        return r?.status === 'ok' ? r.data : null;
      } catch {
        return null;
      }
    },
    /** 必须在用户手势中调用。 */
    async openSpace() {
      const id = String(platform.authorMid || '').trim();
      if (!/^[1-9]\d*$/.test(id) && !window.toy?.__mock) throw new PlatformError('unsupported', 'author_not_configured');
      if (platform.env !== 'standalone') {
        if (typeof window.toy?.navigate !== 'function') throw new PlatformError('unsupported', 'navigate_unavailable');
        try {
          await window.toy.navigate({ type: 'space', id });
          return;
        } catch (error) {
          throw classify(error);
        }
      }
      // 先打开空页再断开 opener，既隔离新页面，也能识别弹窗被拦截的情况。
      const target = window.open('about:blank', '_blank');
      if (!target) throw new PlatformError('denied', 'space_popup_blocked');
      target.opener = null;
      target.location.href = `https://space.bilibili.com/${id}`;
    },
  },

  /** 底部安全区：App 内用容器状态，其他环境用 env(safe-area-inset-*)。 */
  onSafeArea(cb) {
    if (this.env === 'toy-app' && this.features.container) {
      return window.toy.onContainerChange((s) => cb(s.safeArea));
    }
    return () => {};
  },
};

/** B站头像常为协议相对地址（//i0.hdslb.com/...）；统一成 https，避免在 file/http 页面下加载失败。 */
export function normalizeAvatarUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('http://')) return `https://${u.slice(7)}`;
  return u;
}

async function safeSupport(ability) {
  try {
    return await window.toy.isSupport(ability);
  } catch {
    return false;
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}
