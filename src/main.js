// M0 原型入口：插入构建时打包的页面片段 → 初始化平台 → 启动 Alpine。
// 业务状态集中在 app() 组件里；原型后端为 mock/api.js，online 模式连接真实 API。

import Alpine from './vendor/alpine-3.14.1.esm.js';
import { CARDS, CARD_BY_ID, CARD_COUNT } from './data/cards.js';
import { translate, detectLang, LANGS } from './i18n.js';
import { resolveUid, maskUid, SERVERS } from './lib/uid.js';
import { storage } from './lib/storage.js';
import { encodeBox, decodeBox } from './lib/box-code.js';
import { parseImageCount, createImageBoxPatch } from './lib/image-box-draft.js';
import imageImportIcons from '../assets/icons/ui.svg?url';
import { renderExchangeCard } from './lib/exchange-card.js';
import { getNamecardSelection, hasNamecardSelection } from './lib/namecard-selection.js';
import { hasWaitingCards, canStartTrade, matchStatus } from './lib/trade-state.js';
import { QUICK_NOTE_PRESETS, TRADE_TIME_PRESETS, TRADE_NOTE_PRESETS, isPresetNote } from './lib/trade-notes.js';
import { statePollDelay } from './lib/state-polling.js';
import { platform, copyText } from './platform/index.js';
import { api } from './api/index.js';
import { ONLINE_BACKEND } from './config.js';
import { dev, setDev } from './mock/dev.js';
import { toyUi } from './mock/toy-sdk.js';
import { detectTier, watchLowFps } from './fx/perf.js';
import { startStars } from './fx/stars.js';
import { tiltDirective, decodeText, burst, moonPath, playReveal } from './fx/effects.js';
import { cardShowcase } from './fx/showcase.js';
import welcomeHtml from './partials/welcome.html?raw';
import boxHtml from './partials/box.html?raw';
import tradeHtml from './partials/trade.html?raw';
import matchHtml from './partials/match.html?raw';
import meHtml from './partials/me.html?raw';
import sheetsHtml from './partials/sheets.html?raw';
import overlaysHtml from './partials/overlays.html?raw';

const PARTIALS = [welcomeHtml, boxHtml, tradeHtml, matchHtml, meHtml, sheetsHtml, overlaysHtml];
const ROUTES = ['welcome', 'box', 'trade', 'me'];
const ACTIVE = ['matched', 'confirming'];
const REASONS = ['no_friend', 'no_response', 'no_card', 'changed_mind', 'self', 'other'];

const rid4 = () => Math.random().toString(16).slice(2, 6).toUpperCase();

function app() {
  const saved = storage.get('state', {});
  // 大图、AbortController等资源不进入Alpine响应式状态或持久化快照。
  let imageSource = null;
  let imageController = null;
  let imageRevision = 0;
  let refreshing = null;
  const SHEET_LEAVE_MS = 260; // 略长于 CSS 中抽屉的离场过渡
  return {
    // ---------- 常量 ----------
    cards: CARDS,
    imageImportIcons,
    langs: LANGS,
    servers: SERVERS,
    presetKeys: QUICK_NOTE_PRESETS,
    timePresetKeys: TRADE_TIME_PRESETS,
    reasons: REASONS,
    dev,
    platform,
    online: ONLINE_BACKEND,

    // ---------- 持久化状态 ----------
    lang: saved.lang || detectLang(),
    fxPref: saved.fxPref || 'auto',
    fxAuto: saved.fxAuto || null,
    keep: saved.keep ?? 1,
    uid: saved.uid || '',
    onboarded: !!saved.onboarded,
    mode: saved.mode || 'quick',
    counts: saved.counts || Array(CARD_COUNT).fill(0),
    wantOff: saved.wantOff || [],
    quick: saved.quick || { give: {}, want: [] },
    profile: saved.profile || null,
    profileDeclined: !!saved.profileDeclined,
    anonTag: saved.anonTag || rid4(),
    session: saved.session ? { token: saved.session.token, accountType: saved.session.accountType } : null,
    notify: !!saved.notify,

    // ---------- 运行时状态 ----------
    ready: false,
    route: 'box',
    param: null,
    onboardStep: 0,
    onboardHint: null,
    uidInput: '',
    fx: 'high',
    sheet: null,
    sheetView: null, // 抽屉里正在渲染的内容；关闭动画播完后才清空
    sheetData: {},
    filter: 'all',
    batch: false,
    quickTab: 'give',
    listing: null,
    matches: [],
    quotaLeft: 1,
    resetAt: 0,
    completedCount: 0,
    poolStatsValue: { waiting: 0 },
    connectionError: '',
    toasts: [],
    revealing: null,
    platformDialog: null,
    syncState: 'synced',
    note: { preset: null },
    followCache: null,
    authorInfo: null,
    uidPeek: false,
    busy: false,
    accountType: 'anon',
    loginHint: false,
    loginHintClosed: false,
    fanCards: [17, 18, 21, 6, 22],
    boxCode: '',
    boxImportInput: '',
    boxImportPreview: null,
    boxImportError: null,
    imageImport: null,
    qrSrc: null,
    namecard: null,
    _namecardRevision: 0,
    wide: matchMedia('(min-width: 1024px)').matches,
    _press: null,
    _dialogResolve: null,
    _syncTimer: 0,
    _touchX: null,

    // ====================================================================
    async init() {
      this.applyFx(this.fxPref === 'auto' ? this.fxAuto || 'high' : this.fxPref);
      this.stars = startStars(document.getElementById('stars'));
      if (this.fxPref === 'auto' && !this.fxAuto) {
        detectTier().then((tier) => {
          this.fxAuto = tier;
          if (this.fxPref === 'auto') this.applyFx(tier);
        });
      }
      watchLowFps(() => {
        if (this.fxPref === 'auto' && this.fx === 'high') {
          this.fxAuto = 'lite';
          this.applyFx('lite');
          this.toast(this.t('fx.downgraded'));
        }
      });
      matchMedia('(min-width: 1024px)').addEventListener('change', (e) => (this.wide = e.matches));
      // 关闭时保留内容直到离场动画结束，否则抽屉会先塌成空框再消失。
      this.$watch('sheet', (value) => {
        clearTimeout(this._sheetTimer);
        if (value) {
          this.sheetView = value;
          if (value !== 'imageImport' && this.imageImport) this.disposeImageBoxImport();
          return;
        }
        // 识别任务立即中止，草稿和图片等动画结束再释放。
        if (this.imageImport) { imageRevision++; imageController?.abort(); imageController = null; }
        this._sheetTimer = setTimeout(() => {
          if (this.sheet) return;
          this.sheetView = null;
          if (this.imageImport) this.disposeImageBoxImport();
        }, SHEET_LEAVE_MS);
      });

      // 模拟 SDK 的平台 UI 钩子
      toyUi.confirmProfile = () => new Promise((res) => {
        this.platformDialog = 'profile';
        this._dialogResolve = res;
      });
      toyUi.openSpace = () => new Promise((res) => {
        this.platformDialog = 'space';
        this._dialogResolve = res;
      });
      toyUi.notice = (msg) => this.toast(`（模拟）${msg}`);

      try {
        await this.setupIdentity();
      } catch (error) {
        this.showApiError(error);
      }
      this.platform.onSafeArea((sa) => document.documentElement.style.setProperty('--safe-bottom', `${sa.bottom}px`));

      // 持久化 + 云同步（B站用户）：JSON.stringify 会读取所有嵌套字段，从而建立响应式依赖
      Alpine.effect(() => {
        const snap = this.snapshot();
        const json = JSON.stringify(snap);
        storage.set('state', JSON.parse(json));
        this.scheduleCloudSync();
      });

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { this.flushCloudSync(); this.pollState(); }
        if (document.visibilityState === 'visible' && this.sheet === 'follow') this.recheckFollow(true).catch(error => this.showApiError(error));
        if (document.visibilityState === 'visible') this.refresh(true).catch(error => this.showApiError(error));
      });

      window.addEventListener('hashchange', () => this.parseRoute(true));
      this.parseRoute(false);
      try { await this.refresh(); } catch (error) { this.showApiError(error); }
      this.ready = true;
      this.pollState();
    },

    snapshot() {
      return {
        lang: this.lang, fxPref: this.fxPref, fxAuto: this.fxAuto, keep: this.keep, uid: this.uid,
        onboarded: this.onboarded, mode: this.mode,
        counts: this.counts, wantOff: this.wantOff, quick: this.quick, profile: this.profile,
        profileDeclined: this.profileDeclined, anonTag: this.anonTag, session: ONLINE_BACKEND ? null : this.session,
        notify: this.notify,
      };
    },

    // ---------- 身份（设计文档 3.3、3.4） ----------
    async setupIdentity() {
      if (ONLINE_BACKEND) {
        const config = await api.init();
        this.platform.authorMid = config.authorMid;
      }
      if (this.platform.env === 'standalone') {
        this.accountType = 'anon';
        if (ONLINE_BACKEND) this.session = await api.createSession('anon');
        return;
      }
      const probe = await this.platform.probeLogin();
      if (!probe.loggedIn) {
        this.accountType = 'anon';
        this.loginHint = true;
        if (ONLINE_BACKEND) this.session = await api.createSession('anon');
        return;
      }
      this.accountType = 'bili';
      const s = await api.createSession('bili', probe.cred);
      if (!probe.cred && s.credential) {
        try {
          await this.platform.cloud.set({ cred: s.credential });
        } catch {
          this.syncState = 'error';
        }
      }
      this.session = ONLINE_BACKEND ? { accountType: 'bili' } : { token: s.token, accountType: 'bili' };
      // 从云端恢复（新设备场景）
      try {
        const cloud = await this.platform.cloud.get(['box', 'quick', 'prefs', 'sync']);
        const cloudAt = JSON.parse(cloud.sync || '{}').at || 0;
        const localAt = storage.get('syncAt', 0);
        if (cloud.box && cloudAt > localAt) this.applyCloud(cloud);
      } catch {
        this.syncState = 'error';
      }
    },

    applyCloud(cloud) {
      const [, nums, keep] = cloud.box.split('|');
      const arr = nums.split(',').map(Number);
      if (arr.length === CARD_COUNT) this.counts = arr;
      this.keep = Number(keep) || 1;
      if (cloud.quick) this.quick = JSON.parse(cloud.quick);
      if (cloud.prefs) {
        const p = JSON.parse(cloud.prefs);
        Object.assign(this, { lang: p.lang ?? this.lang, uid: p.uid ?? this.uid, onboarded: p.onboarded ?? this.onboarded, mode: p.mode ?? this.mode });
      }
    },

    scheduleCloudSync() {
      if (this.accountType !== 'bili') return;
      clearTimeout(this._syncTimer);
      this._syncTimer = setTimeout(() => this.flushCloudSync(), 5000);
    },

    async flushCloudSync() {
      if (this.accountType !== 'bili') return;
      clearTimeout(this._syncTimer);
      this.syncState = 'syncing';
      const at = Date.now();
      try {
        await this.platform.cloud.set({
          box: `v1|${this.counts.join(',')}|${this.keep}`,
          quick: JSON.stringify(this.quick),
          prefs: JSON.stringify({ lang: this.lang, uid: this.uid, onboarded: this.onboarded, mode: this.mode }),
          sync: JSON.stringify({ at }),
        });
        storage.set('syncAt', at);
        this.syncState = 'synced';
      } catch {
        this.syncState = 'error';
      }
    },

    async useBiliProfile() {
      const p = await this.platform.getProfile();
      if (p) {
        this.profile = { nickname: p.nickname, avatar: p.avatar };
        this.toast(this.t('welcome.biliLinked'));
      } else {
        this.profileDeclined = true;
      }
    },

    resolveDialog(value) {
      const r = this._dialogResolve;
      this._dialogResolve = null;
      this.platformDialog = null;
      if (r) r(value);
    },

    // ---------- i18n / 工具 ----------
    t(key, vars) {
      return translate(this.lang, key, vars);
    },
    cardName(id) {
      return CARD_BY_ID[id].name[this.lang === 'en' ? 'en' : 'zh-CN'];
    },
    card(id) {
      return CARD_BY_ID[id];
    },
    serverName(key) {
      return key ? SERVERS[key].name[this.lang === 'en' ? 'en' : 'zh-CN'] : '—';
    },
    mask: maskUid,
    moonPath,
    timeLeft(ts) {
      const ms = Math.max(0, ts - Date.now());
      const h = Math.floor(ms / 3600e3);
      const m = Math.floor((ms % 3600e3) / 60e3);
      return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    },
    dateStr(ts) {
      return new Intl.DateTimeFormat(this.lang, { month: 'numeric', day: 'numeric' }).format(ts);
    },
    applyFx(tier) {
      this.fx = tier;
      document.documentElement.dataset.fx = tier;
      this.stars?.refresh();
    },
    setFxPref(p) {
      this.fxPref = p;
      this.applyFx(p === 'auto' ? this.fxAuto || 'high' : p);
    },
    toast(msg, opts = {}) {
      const id = Math.random();
      this.toasts.push({ id, msg, ...opts });
      setTimeout(() => this.dismissToast(id), opts.ms || 2600);
    },
    dismissToast(id) {
      this.toasts = this.toasts.filter((x) => x.id !== id);
    },
    async copy(text) {
      const copied = await copyText(text);
      if (copied) this.toast(this.t('common.copied'));
      return copied;
    },

    // ---------- 路由 ----------
    parseRoute(animate) {
      const [r, p] = location.hash.replace(/^#\/?/, '').split('/');
      let route = ROUTES.includes(r) ? r : this.onboarded ? 'box' : 'welcome';
      if (!this.onboarded && route !== 'welcome') route = 'welcome';
      if (this.onboarded && route === 'welcome' && !this.onboardStep) route = 'box';
      const apply = () => {
        this.route = route;
        this.param = p || null;
        this.sheet = null;
        window.scrollTo(0, 0);
      };
      if (animate && document.startViewTransition && this.fx !== 'off' && document.visibilityState === 'visible') {
        // 回调同步执行：Alpine 的 DOM 更新在微任务里完成，早于浏览器截取新画面
        const vt = document.startViewTransition(apply);
        [vt.ready, vt.finished, vt.updateCallbackDone].forEach((p) => p?.catch(() => {}));
      } else apply();
    },
    go(path) {
      const target = `#/${path}`;
      if (location.hash === target) this.parseRoute(false);
      else location.hash = target;
    },

    // ---------- 引导（设计文档 5.1） ----------
    get uidState() {
      return resolveUid(this.uidInput);
    },
    get serverKey() {
      return this.serverKeyOf(this.uid);
    },
    serverKeyOf(uid) {
      return resolveUid(uid).server || null;
    },
    startOnboarding() {
      this.uidInput = this.uid;
      this.onboardStep = 1;
    },
    onUidInput(e) {
      this.uidInput = e.target.value.replace(/\D/g, '').slice(0, 10);
      e.target.value = this.uidInput;
    },
    get uidReady() {
      return this.uidState.state === 'ok';
    },
    async confirmUid() {
      if (!this.uidReady || this.busy) return;
      this.busy = true;
      try {
        const uid = this.uidInput;
        if (ONLINE_BACKEND) {
          if (!this.session) await this.setupIdentity();
          await api.updateProfile({ uid });
        }
        this.uid = uid;
        if (this.onboardStep === 1) this.onboardStep = 2;
        else this.sheet = null;
        if (ONLINE_BACKEND) await this.refresh(true);
      } catch (error) { this.showApiError(error); }
      finally { this.busy = false; }
    },
    chooseMode(mode) {
      this.mode = mode;
      this.onboarded = true;
      this.onboardStep = 0;
      this.onboardHint = mode;
      this.go('box');
    },
    // ---------- Box 计算（设计文档 2.3） ----------
    get activeMatches() {
      return this.matches.filter((m) => ACTIVE.includes(m.status));
    },
    get historyMatches() {
      return this.matches.filter((m) => !ACTIVE.includes(m.status));
    },
    get hasWaitingListing() {
      return hasWaitingCards(this.listing);
    },
    lockedGive(id) {
      return this.activeMatches.reduce((n, m) => n + m.pairs.filter((p) => p.give === id).length, 0);
    },
    lockedGet(id) {
      return this.activeMatches.some((m) => m.pairs.some((p) => p.get === id));
    },
    count(id) {
      return this.counts[id - 1];
    },
    spare(id) {
      return Math.max(0, this.count(id) - this.keep - this.lockedGive(id));
    },
    get ownedCount() {
      return this.counts.filter((c) => c > 0).length;
    },
    get missingCount() {
      return CARD_COUNT - this.ownedCount;
    },
    get spareTotal() {
      return CARDS.reduce((n, c) => n + this.spare(c.id), 0);
    },
    get totalCount() {
      return this.counts.reduce((a, b) => a + b, 0);
    },
    tileState(id) {
      if (this.lockedGive(id) || this.lockedGet(id)) return 'locked';
      const c = this.count(id);
      if (c === 0) return 'missing';
      return c > this.keep ? 'spare' : 'owned';
    },
    get visibleCards() {
      if (this.mode !== 'full' || this.filter === 'all') return CARDS;
      if (this.filter === 'missing') return CARDS.filter((c) => this.count(c.id) === 0);
      return CARDS.filter((c) => this.spare(c.id) > 0);
    },
    wanted(id) {
      return this.count(id) === 0 && !this.wantOff.includes(id);
    },
    get giveMap() {
      if (this.mode === 'quick') return { ...this.quick.give };
      const out = {};
      CARDS.forEach((c) => {
        const s = this.spare(c.id);
        if (s > 0) out[c.id] = s;
      });
      return out;
    },
    get wantList() {
      const list = this.mode === 'quick' ? this.quick.want : CARDS.filter((c) => this.wanted(c.id)).map((c) => c.id);
      return list.filter((id) => !this.lockedGet(id));
    },
    get giveTotal() {
      return Object.values(this.giveMap).reduce((a, b) => a + b, 0);
    },
    get giveIds() {
      return Object.keys(this.giveMap).map(Number);
    },
    get listingDirty() {
      if (!this.listing) return false;
      const norm = (g, w) => JSON.stringify([Object.entries(g).filter(([, q]) => q > 0).sort(), [...w].sort()]);
      return norm(this.listing.give, this.listing.want) !== norm(this.giveMap, this.wantList);
    },
    get publishBlocker() {
      if (this.activeMatches.length) return this.t('box.finishActive');
      if (!this.giveTotal) return this.mode === 'full' ? this.t('box.noSpare') : this.t('box.noWant');
      if (!this.wantList.length) return this.mode === 'full' && this.ownedCount === CARD_COUNT ? this.t('box.completeDesc') : this.t('box.noWant');
      return null;
    },

    // ---------- Box 编辑 ----------
    setCount(id, v, evt) {
      const before = this.count(id);
      const next = Math.max(0, Math.min(99, v));
      if (next === before) return;
      if (next < this.lockedGive(id) + (this.lockedGive(id) ? this.keep : 0)) {
        this.toast(this.t('box.tagLocked'));
        return;
      }
      this.counts[id - 1] = next;
      const el = evt && (evt.currentTarget || evt.target);
      if (before === 0 && next > 0 && el?.getBoundingClientRect) {
        const r = (el.closest('[data-burst]') || el).getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2, CARD_BY_ID[id].color);
      }
      if (this.ownedCount === CARD_COUNT && before === 0) this.toast(this.t('match.fullMoon'));
    },
    toggleWant(id) {
      if (this.count(id) > 0) {
        this.toast(this.t('box.ownedCantWant'));
        return;
      }
      this.wantOff = this.wantOff.includes(id) ? this.wantOff.filter((x) => x !== id) : [...this.wantOff, id];
    },
    openCard(id) {
      this.sheetData = { id };
      this.sheet = 'card';
    },
    sheetStep(dir) {
      const ids = this.visibleCards.map((c) => c.id);
      const i = ids.indexOf(this.sheetData.id);
      this.sheetData = { id: ids[(i + dir + ids.length) % ids.length] };
    },
    touchStart(e) {
      this._touchX = e.touches[0].clientX;
    },
    touchEnd(e) {
      if (this._touchX == null) return;
      const dx = e.changedTouches[0].clientX - this._touchX;
      this._touchX = null;
      if (Math.abs(dx) > 50) this.sheetStep(dx < 0 ? 1 : -1);
    },

    // 长按：步进器连续加减；快速模式长按移除
    holdStart(fn) {
      this.holdStop();
      fn();
      const t = setTimeout(() => {
        this._press = setInterval(fn, 90);
      }, 420);
      this._press = t;
    },
    holdStop() {
      clearTimeout(this._press);
      clearInterval(this._press);
      this._press = null;
    },
    tileDown(id) {
      if (this.mode !== 'quick') return;
      this._longFired = false;
      clearTimeout(this._lp);
      this._lp = setTimeout(() => {
        this._longFired = true;
        if (this.quick.give[id]) {
          const g = { ...this.quick.give };
          delete g[id];
          this.quick.give = g;
          navigator.vibrate?.(12);
        } else if (this.quick.want.includes(id)) this.quick.want = this.quick.want.filter((x) => x !== id);
      }, 520);
    },
    tileUp() {
      clearTimeout(this._lp);
    },
    tileClick(id, evt) {
      if (this._longFired) {
        this._longFired = false;
        return;
      }
      if (this.mode === 'full') {
        if (!this.batch) this.openCard(id);
        return;
      }
      if (this.lockedGive(id) || this.lockedGet(id)) {
        this.toast(this.t('box.tagLocked'));
        return;
      }
      if (this.quickTab === 'give') {
        if (this.quick.want.includes(id)) return this.toast(this.t('box.inWant'));
        const q = this.quick.give[id] || 0;
        this.quick.give = { ...this.quick.give, [id]: Math.min(9, q + 1) };
        if (!q) burst(evt.clientX, evt.clientY, CARD_BY_ID[id].color, 8);
      } else {
        if (this.quick.give[id]) return this.toast(this.t('box.inGive'));
        const has = this.quick.want.includes(id);
        this.quick.want = has ? this.quick.want.filter((x) => x !== id) : [...this.quick.want, id];
        if (!has) burst(evt.clientX, evt.clientY, '#E9C77B', 8);
      }
    },

    // ---------- 发布（设计文档 6.3.3） ----------
    openPublish() {
      if (this.publishBlocker || this.listing) return;
      this.note = { preset: null };
      this.sheet = 'publish';
    },
    async doPublish() {
      if (this.busy) return;
      const note = TRADE_NOTE_PRESETS.includes(this.note.preset) ? { preset: this.note.preset } : null;
      this.busy = true;
      try {
        if (!this.session) {
          const s = await api.createSession('anon');
          this.session = ONLINE_BACKEND ? { accountType: 'anon' } : { token: s.token, accountType: 'anon' };
        }
        const res = await api.publish({ give: this.giveMap, want: this.wantList, note, server: this.serverKey, mode: this.mode });
        this.onboardHint = null;
        await this.refresh(true);
        this.sheet = null;
        this.go('trade');
        if (res.matches.length) {
          await this.playMatch(res.matches[0]);
          this.go(`trade/${res.matches[0].id}`);
        }
      } catch (e) {
        this.toast(e.code === 'DAILY_LIMIT' ? this.t('publish.quotaUsed', { time: this.timeLeft(e.retryAt) }) : String(e.code || e.message));
      } finally {
        this.busy = false;
      }
    },
    async syncListing() {
      if (this.busy || !this.listing) return;
      this.busy = true;
      try {
        await api.editListing({ give: this.giveMap, want: this.wantList,
          note: isPresetNote(this.listing.note) ? { preset: this.listing.note.preset } : null });
        await this.refresh(true);
        this.toast(this.t('common.done'));
      } catch (error) {
        this.showApiError(error);
        if (error.code === 'VERSION_CONFLICT') await this.refresh(true).catch(next => this.showApiError(next));
      } finally { this.busy = false; }
    },

    // ---------- 交换（设计文档 5.3–5.5、6.5） ----------
    async refresh(fresh = false) {
      if (!ONLINE_BACKEND && !this.serverKey) return;
      if (ONLINE_BACKEND && !this.session) await this.setupIdentity();
      if (refreshing) {
        if (!fresh) return refreshing;
        // 写操作完成后，等待旧轮询结束再获取新状态，避免将写入前的视图当作结果。
        try { await refreshing; } catch (error) { this.showApiError(error); }
      }
      refreshing = (async () => {
        const s = await api.getState(this.serverKey, { light: !fresh && this.ready });
        Object.assign(this, { listing: s.listing, matches: s.matches, quotaLeft: s.quotaLeft, resetAt: s.resetAt, completedCount: s.completedCount });
        if (ONLINE_BACKEND) {
          // 身份、额度和匹配以服务端为准；完整 Box 仍按原有方式保存在本机或 Toy 云存储。
          this.uid = s.me.uid || '';
          this.accountType = s.me.accountType;
          this.poolStatsValue = s.stats;
          this.connectionError = '';
        }
      })();
      try { return await refreshing; } finally { refreshing = null; this.pollState(); }
    },
    pollState() {
      clearTimeout(this._pollTimer);
      const delay = statePollDelay({ listing: this.listing, matches: this.matches, visible: document.visibilityState === 'visible' });
      if (delay === null) return;
      this._pollTimer = setTimeout(async () => {
        if (document.visibilityState === 'visible' && !this.busy) {
          try { await this.refresh(); } catch (error) { this.showApiError(error); }
        }
        this.pollState();
      }, delay);
    },
    showApiError(error) {
      const message = error.message || error.code || String(error);
      if (!ONLINE_BACKEND || this.connectionError !== message) this.toast(message);
      if (ONLINE_BACKEND) this.connectionError = message;
    },
    get newMatchCount() {
      return this.activeMatches.filter((m) => !m.myConfirm && !m.revealed).length;
    },
    get currentMatch() {
      return this.matches.find((m) => m.id === this.param) || null;
    },
    canStartTrade,
    matchStatus,
    noteText(note) {
      return isPresetNote(note) ? this.t(`presets.${note.preset}`) : '';
    },
    get poolStats() {
      return ONLINE_BACKEND ? this.poolStatsValue : api.stats(this.serverKey);
    },
    async playMatch(m) {
      this.revealing = { give: m.pairs[0].give, get: m.pairs[0].get, n: m.pairs.length };
      await Alpine.nextTick();
      await playReveal(document.querySelector('.reveal'));
      this.revealing = null;
    },
    async withdraw() {
      if (this.busy) return;
      this.busy = true;
      try {
        await api.withdraw();
        await this.refresh(true);
        this.toast(this.t('trade.withdrawn'));
      } catch (error) { this.showApiError(error); }
      finally { this.busy = false; }
    },
    async rematch() {
      if (!this.quotaLeft || this.busy) return;
      this.busy = true;
      try {
        const r = await api.rematch(this.serverKey);
        await this.refresh(true);
        if (r.matches.length) {
          await this.playMatch(r.matches[0]);
          this.go(`trade/${r.matches[0].id}`);
        } else this.toast(this.t('trade.waiting'));
      } catch (e) {
        this.toast(String(e.code));
      } finally {
        this.busy = false;
      }
    },
    async invite() {
      const r = await this.platform.share({ path: 'index.html#/welcome', title: this.t('app.name'), text: this.t('app.tagline') });
      if (r === 'copied') this.toast(this.t('common.copied'));
    },

    // 开始交换：B站用户先检查关注（5.5），失败或无法判断时放行
    async startTrade(m) {
      if (this.busy) return;
      if (this.accountType === 'bili' && this.platform.can('follow') && this.followCache !== true) {
        this.busy = true;
        const f = await this.platform.author.isFollowing();
        this.busy = false;
        if (f === false) {
          this.sheetData = { matchId: m.id };
          this.sheet = 'follow';
          if (!this.authorInfo) this.platform.author.profile().then((p) => (this.authorInfo = p));
          return;
        }
        this.followCache = f;
      }
      await this.revealUid(m.id);
    },
    async revealUid(id) {
      this.busy = true;
      try {
        await api.reveal(id);
        await this.refresh(true);
        await Alpine.nextTick();
        const m = this.matches.find((x) => x.id === id);
        const el = document.getElementById('uid-full');
        if (el && m?.partner.uid) await decodeText(el, m.partner.uid);
      } catch (error) {
        this.showApiError(error);
      } finally {
        this.busy = false;
      }
    },
    async goFollow() {
      await this.platform.author.openSpace();
      await this.recheckFollow(true);
    },
    async recheckFollow(silent = false) {
      const f = await this.platform.author.isFollowing();
      if (f === false) {
        if (!silent) this.toast(this.t('follow.notYet'));
        return;
      }
      this.followCache = true;
      const id = this.sheetData.matchId;
      this.sheet = null;
      if (id) await this.revealUid(id);
    },
    async followFromMe() {
      if (this.followCache === true) return;
      await this.platform.author.openSpace();
      const f = await this.platform.author.isFollowing();
      if (f !== false) this.followCache = true;
    },
    tradeMsg(m) {
      const gives = m.pairs.map((p) => this.cardName(p.give));
      const gets = m.pairs.map((p) => this.cardName(p.get));
      const fmt = (arr) => (this.lang === 'en' ? arr.join(', ') : arr.map((n) => `「${n}」`).join(''));
      return this.t('match.msg', { give: fmt(gives), get: fmt(gets) });
    },
    openDone(m) {
      if (m.pairs.length > 1) {
        this.sheetData = { matchId: m.id, sel: m.pairs.map((_, i) => i) };
        this.sheet = 'done';
      } else this.confirmDone(m.id, [0]);
    },
    toggleSel(i) {
      const sel = this.sheetData.sel;
      this.sheetData.sel = sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i].sort();
    },
    async confirmDone(id, sel) {
      const m = this.matches.find((x) => x.id === id);
      if (!m || !sel.length || this.busy || m.myConfirm) return;
      this.busy = true;
      try {
        const res = await api.confirm(id, { result: 'completed', completedPairs: sel });
        const before = { counts: [...this.counts], quick: JSON.parse(JSON.stringify(this.quick)) };
        const done = sel.map((i) => m.pairs[i]);
        const wasComplete = this.ownedCount === CARD_COUNT;
        for (const p of done) {
          if (this.mode === 'full') {
            this.counts[p.give - 1] = Math.max(0, this.counts[p.give - 1] - 1);
            this.counts[p.get - 1] += 1;
          } else {
            const g = { ...this.quick.give };
            g[p.give] = (g[p.give] || 1) - 1;
            if (g[p.give] <= 0) delete g[p.give];
            this.quick.give = g;
            this.quick.want = this.quick.want.filter((x) => x !== p.get);
          }
        }
        this.sheet = null;
        await this.refresh(true);
        const changes = done.map((p) => `${this.cardName(p.give)} −1，${this.cardName(p.get)} +1`).join('；');
        this.toast(this.t('match.boxUpdated', { changes }), {
          ms: 5000,
          action: this.t('common.undo'),
          onAction: () => {
            this.counts = before.counts;
            this.quick = before.quick;
          },
        });
        if (res.outcome === 'confirming') setTimeout(() => this.toast(this.t('match.waitPartner')), 600);
        if (!wasComplete && this.mode === 'full' && this.ownedCount === CARD_COUNT) {
          burst(innerWidth / 2, innerHeight / 3, '#E9C77B', 12);
          this.toast(this.t('match.fullMoon'));
        }
      } catch (error) { this.showApiError(error); }
      finally { this.busy = false; }
    },
    openProblem(m, reason = null) {
      this.sheetData = { matchId: m.id, reason, note: '' };
      this.sheet = 'problem';
    },
    async submitProblem() {
      const { matchId, reason, note } = this.sheetData;
      if (!reason || this.busy) return;
      this.busy = true;
      try {
        const res = await api.confirm(matchId, { result: 'failed', reason, note });
        this.sheet = null;
        await this.refresh(true);
        this.toast(this.t(res.outcome === 'back_to_pool' && this.hasWaitingListing ? 'match.backToPool' : 'match.recordedSelf'), { ms: 3600 });
      } catch (error) { this.showApiError(error); }
      finally { this.busy = false; }
    },

    // ---------- 我的 ----------
    peekUid() {
      this.uidPeek = true;
      clearTimeout(this._peekT);
      this._peekT = setTimeout(() => (this.uidPeek = false), 3000);
    },
    editUid() {
      this.uidInput = this.uid;
      this.sheet = 'uid';
    },
    get displayName() {
      if (this.accountType === 'bili') return this.profile?.nickname || this.t('me.biliTag') + ' · ' + this.anonTag;
      return (this.lang === 'en' ? 'Traveler·' : '旅人·') + this.anonTag;
    },
    async openQr() {
      this.qrSrc = await this.platform.qrcode({ path: 'index.html#/box' });
      if (!this.qrSrc) return this.toast(this.t('namecard.toyUnavailable'));
      this.sheet = 'qr';
    },

    // ---------- 交换名片：从当前选牌或已发布需求生成独立快照 ----------
    get namecardSelection() {
      return getNamecardSelection(this);
    },
    get canCreateNamecard() {
      return hasNamecardSelection(this.namecardSelection);
    },
    async openNamecard(source = 'box') {
      const request = source === 'listing' ? this.listing : this.namecardSelection;
      if (!hasNamecardSelection(request)) {
        return this.toast(this.t('namecard.chooseCards'));
      }
      this.namecard = {
        give: { ...request.give }, want: [...request.want], source,
        displayName: this.displayName, server: this.serverName(this.serverKey), uid: this.uid, lang: this.lang,
        createdAt: Date.now(), includeUid: true, site: null, image: null,
        generating: false, saving: false, error: null,
      };
      this.sheet = 'namecard';
      await this.generateNamecard();
    },
    async generateNamecard() {
      const revision = ++this._namecardRevision;
      const current = this.namecard;
      current.generating = true;
      current.image = null;
      current.error = null;
      try {
        const site = current.site || await this.platform.exchangeSite();
        const image = await renderExchangeCard({ ...current, site });
        // 关闭后重新打开或修改选项时，较旧的生成结果不能覆盖新名片。
        if (revision !== this._namecardRevision || this.sheet !== 'namecard') return;
        current.site = site;
        current.image = image;
      } catch (error) {
        if (revision !== this._namecardRevision || this.sheet !== 'namecard') return;
        current.error = this.t(error?.cause === 'toy_url_unavailable' ? 'namecard.toyUnavailable' : 'namecard.failed');
      } finally {
        if (revision === this._namecardRevision) current.generating = false;
      }
    },
    async saveNamecard() {
      const current = this.namecard;
      if (!current?.image || current.generating || current.saving) return;
      current.saving = true;
      try {
        const date = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(current.createdAt);
        const result = await this.platform.saveImage({
          dataUrl: current.image.dataUrl,
          name: `lunar-swap-${current.site.kind}-${date}.${current.image.extension}`,
        });
        this.toast(this.t(result === 'album' ? 'namecard.savedAlbum' : 'namecard.savedDownload'));
      } catch {
        this.toast(this.t('namecard.saveFailed'));
      } finally {
        current.saving = false;
      }
    },
    exportBox() {
      try {
        this.boxCode = encodeBox({ counts: this.counts, keep: this.keep, wantOff: this.wantOff, quick: this.quick, mode: this.mode });
        this.sheet = 'exportBox';
      } catch {
        this.toast(this.t('me.boxExportFailed'));
      }
    },
    openBoxImport() {
      this.boxImportInput = '';
      this.boxImportPreview = null;
      this.boxImportError = null;
      this.sheet = 'importBox';
    },
    previewBoxImport() {
      this.boxImportPreview = null;
      this.boxImportError = null;
      if (!this.boxImportInput.trim()) return;
      try {
        this.boxImportPreview = decodeBox(this.boxImportInput);
      } catch {
        this.boxImportError = this.t('me.boxInvalid');
      }
    },
    importBox() {
      if (this.busy || this.activeMatches.length) return;
      this.previewBoxImport();
      if (!this.boxImportPreview) return;
      const box = this.boxImportPreview;
      Object.assign(this, {
        counts: [...box.counts], keep: box.keep, wantOff: [...box.wantOff],
        quick: { give: { ...box.quick.give }, want: [...box.quick.want] }, mode: box.mode,
      });
      this.batch = false;
      this.filter = 'all';
      this.onboardHint = null;
      this.boxImportInput = '';
      this.boxImportPreview = null;
      this.sheet = null;
      this.go('box');
      this.toast(this.t('me.boxImported'));
    },
    // ---------- 米游社图片导入：识别草稿与当前Box完全分离 ----------
    disposeImageBoxImport() {
      imageRevision++;
      imageController?.abort();
      imageController = null;
      imageSource?.dispose();
      imageSource = null;
      this.imageImport = null;
    },
    openImageBoxImport() {
      this.disposeImageBoxImport();
      this.imageImport = {
        fileName: '', url: null, phase: 'select', progress: 0, error: null,
        counts: Array(CARD_COUNT).fill(null), edited: {}, cards: [], grid: null,
        calibrating: false, crop: null, drag: null, columns: 3, firstId: 1, focusedCard: null,
      };
      this.sheet = 'imageImport';
      // 焦点移入抽屉供键盘操作，但不画焦点环：鼠标或触屏打开时它会像一个常驻的选中框。
      this.$nextTick(() => document.getElementById('image-import-file')?.focus({ preventScroll: true, focusVisible: false }));
    },
    async selectImageBoxFile(file) {
      if (!file || !this.imageImport) return;
      const revision = ++imageRevision;
      imageController?.abort();
      imageSource?.dispose();
      imageSource = null;
      const controller = new AbortController();
      imageController = controller;
      const current = this.imageImport;
      Object.assign(current, {
        fileName: file.name, url: null, phase: 'recognizing', progress: 0, error: null,
        counts: Array(CARD_COUNT).fill(null), edited: {}, cards: [], grid: null,
        crop: null, drag: null, calibrating: false, firstId: 1, focusedCard: null,
      });
      try {
        // 只有进入识别流程才加载算法和493字节数字参考，首屏不加载识别资源。
        const { openImageImportSource } = await import('./lib/miyoushe-box-import.js');
        if (revision !== imageRevision || this.sheet !== 'imageImport') return;
        const source = await openImageImportSource(file, { signal: controller.signal });
        if (revision !== imageRevision || this.sheet !== 'imageImport') { source.dispose(); return; }
        imageSource = source;
        current.url = source.url;
        await this.runImageBoxRecognition();
      } catch (error) {
        if (revision !== imageRevision || this.sheet !== 'imageImport' || error.name === 'AbortError') return;
        current.phase = 'select';
        current.error = this.t('imageImport.decodeFailed');
      }
    },
    async runImageBoxRecognition(calibrated = false) {
      if (!imageSource || !this.imageImport) return;
      const revision = ++imageRevision;
      imageController?.abort();
      const controller = new AbortController();
      imageController = controller;
      const current = this.imageImport;
      current.phase = 'recognizing'; current.progress = 0; current.error = null;
      try {
        const result = await imageSource.recognize({
          crop: current.crop ? { ...current.crop } : null,
          calibrated,
          columns: calibrated ? Math.max(1, Math.min(22, Math.trunc(Number(current.columns) || 3))) : null,
          firstId: calibrated ? Math.max(1, Math.min(22, Math.trunc(Number(current.firstId) || 1))) : 1,
          signal: controller.signal,
          onProgress: (progress) => {
            if (revision === imageRevision && this.sheet === 'imageImport') current.progress = Math.round(progress * 100);
          },
        });
        if (revision !== imageRevision || this.sheet !== 'imageImport') return;
        current.counts = result.counts;
        current.cards = result.cards;
        current.grid = result.grid;
        current.edited = {};
        current.focusedCard = null;
        current.phase = 'review';
        if (!calibrated && result.grid.columns) current.columns = result.grid.columns;
        if (!result.grid.identityReliable) {
          current.error = this.t('imageImport.calibrateHint');
          current.calibrating = true;
        }
      } catch (error) {
        if (revision !== imageRevision || this.sheet !== 'imageImport' || error.name === 'AbortError') return;
        current.phase = 'review';
        current.error = this.t('imageImport.recognitionFailed');
        current.calibrating = true;
      } finally {
        if (revision === imageRevision) imageController = null;
      }
    },
    stopImageBoxRecognition() {
      imageRevision++;
      imageController?.abort();
      imageController = null;
      if (this.imageImport) { this.imageImport.phase = 'review'; this.imageImport.error = this.t('imageImport.stopped'); }
    },
    imageCropStart(event) {
      const current = this.imageImport;
      if (!current?.calibrating || current.phase === 'recognizing') return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      current.drag = { x, y };
      current.crop = { x, y, width: 0, height: 0 };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    imageCropMove(event) {
      const current = this.imageImport;
      if (!current?.drag) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      current.crop = { x: Math.min(x, current.drag.x), y: Math.min(y, current.drag.y), width: Math.abs(x - current.drag.x), height: Math.abs(y - current.drag.y) };
    },
    imageCropEnd(event) {
      const current = this.imageImport;
      if (!current?.drag) return;
      this.imageCropMove(event);
      current.drag = null;
      if (current.crop.width < 0.01 || current.crop.height < 0.01) current.crop = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    editImageBoxCount(id, value) {
      if (!this.imageImport || this.imageImport.phase === 'recognizing') return;
      this.imageImport.counts[id - 1] = parseImageCount(value);
      this.imageImport.edited[id] = true;
    },
    keepImageBoxCount(id) {
      this.editImageBoxCount(id, this.counts[id - 1]);
    },
    showImageBoxSource(id) {
      const card = this.imageImport?.cards.find((item) => item.id === id);
      if (card && imageSource) this.imageImport.focusedCard = { id, url: imageSource.thumbnail(card.sourceRect) };
    },
    keepUnrecognizedImageCounts() {
      if (!this.imageImport) return;
      this.imageImport.counts.forEach((value, index) => { if (value === null) this.keepImageBoxCount(index + 1); });
    },
    get imageImportStats() {
      const values = this.imageImport?.counts || [];
      return { owned: values.filter((value) => value > 0).length, total: values.reduce((sum, value) => sum + (value || 0), 0), pending: values.filter((value) => value === null).length };
    },
    get canApplyImageBoxImport() {
      return this.imageImport?.phase === 'review' && this.imageImportStats.pending === 0 && !this.busy && !this.activeMatches.length;
    },
    applyImageBoxImport() {
      if (this.sheet !== 'imageImport' || !this.canApplyImageBoxImport) return;
      try {
        // 提交时重新读取当前交换锁定状态；只一次性替换已确认的数量。
        const patch = createImageBoxPatch(this.imageImport.counts, this.activeMatches, { keep: this.keep, wantOff: this.wantOff });
        Object.assign(this, patch);
        this.sheet = null;
        this.go('box');
        this.toast(this.t('imageImport.imported'));
      } catch (error) {
        this.toast(this.t(error.message === 'IMAGE_IMPORT_LOCKED' ? 'me.boxImportLocked' : 'imageImport.confirmRemaining'));
      }
    },
    clearAll() {
      if (!confirm(this.t('me.clearConfirm'))) return;
      storage.clearAll();
      location.hash = '';
      location.reload();
    },
    moons(level) {
      return '●'.repeat(level) + '○'.repeat(5 - level);
    },

    // ---------- 原型调试面板 ----------
    devSet(patch, reload, quiet = false) {
      if (ONLINE_BACKEND) return;
      Object.assign(this.dev, patch); // 经过响应式代理，面板立即刷新
      setDev(patch, reload);
      if (!reload && !quiet) this.toast('已更新调试设置');
    },
    async devIncoming() {
      if (ONLINE_BACKEND) return;
      const m = api.dev.incoming();
      await this.refresh();
      this.sheet = null;
      if (!m) return this.toast('没有可匹配的换牌需求（请先发布需求，或可换的牌已全部匹配）');
      this.toast(this.t('status.matched'), { action: this.t('match.title'), onAction: async () => {
        await this.playMatch(m);
        this.go(`trade/${m.id}`);
      }, ms: 5000 });
    },
    async devPartner(kind) {
      if (ONLINE_BACKEND) return;
      const m = kind === 'reveal' ? api.dev.partnerReveal() : api.dev.partnerConfirm();
      await this.refresh();
      this.sheet = null;
      this.toast(m ? (kind === 'reveal' ? this.t('match.partnerStarted') : this.t('status.completed')) : '没有待完成的交换');
    },
    async devResetQuota() {
      if (ONLINE_BACKEND) return;
      api.dev.resetQuota();
      await this.refresh();
      this.toast('已重置今日次数');
    },
  };
}

async function boot() {
  document.getElementById('views').innerHTML = PARTIALS.join('\n');
  await platform.init();
  Alpine.directive('tilt', tiltDirective);
  Alpine.data('cardShowcase', cardShowcase);
  Alpine.data('app', app);
  window.Alpine = Alpine;
  Alpine.start();
}

boot();
