// 模拟 B站 Toy JS SDK（docs/toy-js-sdk-abilities.md）的子集。
// 只在原型中使用：真实 Toy 包里 window.toy 由平台脚本提供。
// 需要平台 UI 的能力（授权弹窗、UP主空间、分享面板）通过 ui 钩子交给页面渲染。

import { storage } from '../lib/storage.js';
import { dev } from './dev.js';
import { createQrDataUrl } from '../lib/qrcode.js';
import { biliToyPageUrl } from '../platform/exchange-site.js';

const APP_ONLY = ['saveImageToAlbum', 'share', 'sharePicture', 'closeBrowser', 'onContainerChange', 'getContainerState', 'setContainerMode'];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const sdkError = (type, message) => Object.assign(new Error(`[ToySDK] ${message}`), { type });

export const toyUi = {
  /** @type {() => Promise<boolean>} */ confirmProfile: async () => true,
  /** @type {() => Promise<void>} */ openSpace: async () => {},
  /** @type {(msg: string) => void} */ notice: () => {},
};

function requireLogin() {
  if (!dev.loggedIn) throw sdkError('not_logged_in', 'user not logged in');
}

export function createMockToy() {
  const cloud = () => storage.get('mockcloud', {});
  return {
    __mock: true,
    async isSupport(name) {
      if (dev.env === 'toy-web' && APP_ONLY.includes(name)) return false;
      return true;
    },
    async getCloudStorage(keys) {
      await delay(120);
      requireLogin();
      const all = cloud();
      if (!keys || !keys.length) return { ...all };
      return Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, all[k]]));
    },
    async setCloudStorage(items) {
      await delay(160);
      requireLogin();
      for (const v of Object.values(items)) if (typeof v !== 'string' || v.length > 1024) throw sdkError('invalid_param', 'value too long');
      storage.set('mockcloud', { ...cloud(), ...items });
    },
    async removeCloudStorage(keys) {
      requireLogin();
      const all = cloud();
      keys.forEach((k) => delete all[k]);
      storage.set('mockcloud', all);
    },
    async getUserProfile() {
      requireLogin();
      const granted = storage.get('mockprofile');
      if (!granted) {
        const ok = await toyUi.confirmProfile();
        if (!ok) throw sdkError('user_denied', 'user denied');
        storage.set('mockprofile', true);
      }
      return { avatar: '', nickname: '提瓦特观星者', toyOpenId: 'mock-openid-7f3a9c' };
    },
    async getAuthorRelation() {
      await delay(200);
      requireLogin();
      return { status: 'ok', data: { isFollowing: dev.following, isAuthor: dev.isAuthor, isOldFan: false, hasFanMedal: false } };
    },
    async getAuthorProfile() {
      await delay(120);
      return { status: 'ok', data: { nickname: '月下观牌人', avatar: '', follower: 12380 } };
    },
    async navigate(req) {
      if (req.type === 'space') return toyUi.openSpace(req.id);
      toyUi.notice(`navigate → ${req.type}/${req.id}`);
    },
    async checkInputSafety({ text }) {
      await delay(300);
      requireLogin();
      // 模拟：联系方式、链接、长数字串会被拒绝
      const bad = /(qq|vx|wx|微信|加群|http|www\.|\d{6,})/i.test(text);
      return { passed: !bad, status: bad ? 'rejected' : 'ok' };
    },
    async share({ path }) {
      if (dev.env !== 'toy-app') throw sdkError('unsupported', 'share is app only');
      toyUi.notice(`share → /toy/<slug>/${path}`);
    },
    async sharePicture({ base64Data }) {
      if (dev.env !== 'toy-app') throw sdkError('unsupported', 'sharePicture is app only');
      if (!base64Data) throw sdkError('invalid_param', 'image is required');
      toyUi.notice('sharePicture → 交换名片图片分享面板');
    },
    async saveImageToAlbum() {
      if (dev.env !== 'toy-app') throw sdkError('unsupported', 'app only');
      await delay(300);
      return { localPath: '/mock/album/exchange-card.png' };
    },
    async getQrCode({ path = '', size = 320 } = {}) {
      const url = biliToyPageUrl(location.href, path) || biliToyPageUrl(import.meta.env.VITE_BILIBILI_TOY_URL, path);
      if (!url) throw sdkError('unsupported', '请配置 VITE_BILIBILI_TOY_URL 后预览真实的 Toy 二维码');
      return { base64: createQrDataUrl(url, size), url };
    },
    onContainerChange(listener) {
      listener({ deviceType: 'phone', viewport: { width: innerWidth, height: innerHeight }, safeArea: { top: 0, bottom: 16, left: 0, right: 0 }, orientation: 'portrait', immersive: false, changedFields: [] });
      return () => {};
    },
  };
}

