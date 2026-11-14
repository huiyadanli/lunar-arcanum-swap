// 模拟后端（设计文档第 11、13 节）。数据存在 localStorage，接口形状与正式 API 草案一致：
//  - 主动扫描（发布 / 重新匹配）最多 3 对，被动匹配不限
//  - 匹配详情在 reveal 之前只返回 uidMasked
//  - 主动发布 / 重新匹配共用十分钟冷却；撤回需求、主动或自动确认成功后立即恢复次数

import { storage } from '../lib/storage.js';
import { maskUid } from '../lib/uid.js';
import { publishQuota } from '../lib/publish-cooldown.js';
import { TRADE_NOTE_PRESETS, isPresetNote } from '../lib/trade-notes.js';
import { dev } from './dev.js';

const ACTIVE_SCAN_MAX = 3;
const MATCH_TTL = 48 * 3600e3;
const CONFIRM_TIMEOUT = 10 * 60e3;
const SERVER_PREFIX = { celestia: '1', irminsul: '5', asia: '8', america: '6', europe: '7', tw: '9' };
const PARTNER_FAULT = ['no_friend', 'no_response', 'no_card', 'changed_mind'];

const delay = (ms = 350 + Math.random() * 400) => new Promise((r) => setTimeout(r, ms));
const rid = (n = 8) => Math.random().toString(36).slice(2, 2 + n);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

class ApiError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    Object.assign(this, extra);
  }
}

function load() {
  const db = storage.get('mockdb', { session: null, listing: null, matches: [], quotaUsedAt: 0, completedCount: 0 });
  if (db.session) {
    // 会话只保留当前支持的字段，清理旧版已废弃的数据。
    const { token, accountType, credential } = db.session;
    const session = { token, accountType, credential };
    if (Object.keys(db.session).some((key) => !Object.hasOwn(session, key))) {
      db.session = session;
      save(db);
    }
  }
  let changed = false;
  for (const m of db.matches) {
    if (m.status !== 'confirming') continue;
    const confirmation = m.myConfirm || m.partnerConfirm;
    if (confirmation?.result !== 'completed') continue;
    const deadline = confirmation.at + CONFIRM_TIMEOUT;
    // 兼容原型已有记录，首次确认后重新计算期限，重复读取不延长计时。
    if (m.expiresAt !== deadline) { m.expiresAt = deadline; changed = true; }
    if (m.expiresAt <= Date.now()) {
      m.status = 'completed';
      db.completedCount += 1;
      // 自动确认成功同样恢复主动发布次数，与正式后端保持一致。
      db.quotaUsedAt = 0;
      changed = true;
    }
  }
  if (changed) save(db);
  return db;
}
function save(db) {
  storage.set('mockdb', db);
}

function quotaLeft(db) {
  return publishQuota(db.quotaUsedAt).quotaLeft;
}

/** 对外视图：未 reveal 或匹配已结束时不返回完整 UID（设计文档 5.4）。 */
function view(m) {
  const active = m.status === 'matched' || m.status === 'confirming';
  const { uid, ...partner } = m.partner;
  return { ...m, partner: m.revealed && active ? { ...partner, uid } : partner };
}

function fakePartner(server, note) {
  const uid = (SERVER_PREFIX[server] || '8') + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  return { uid, uidMasked: maskUid(uid), server, creditLevel: Math.random() < 0.8 ? 5 : 4, note };
}

/** 从换牌需求剩余部分中取出至多 max 对交换，并从换牌需求中扣除（reserved）。 */
function takePairs(listing, max) {
  // 对方缺一张只要一张，所以同一匹配内给出的牌互不相同；严格 1 换 1
  const gives = shuffle(Object.keys(listing.give).map(Number).filter((id) => listing.give[id] > 0));
  const wants = shuffle([...listing.want]);
  const n = Math.min(max, gives.length, wants.length);
  const pairs = Array.from({ length: n }, (_, i) => ({ give: gives[i], get: wants[i] }));
  for (const p of pairs) {
    listing.give[p.give] -= 1;
    if (listing.give[p.give] <= 0) delete listing.give[p.give];
    listing.want = listing.want.filter((w) => w !== p.get);
  }
  return pairs;
}

function releasePairs(listing, pairs) {
  if (!listing) return;
  for (const p of pairs) {
    listing.give[p.give] = (listing.give[p.give] || 0) + 1;
    if (!listing.want.includes(p.get)) listing.want.push(p.get);
  }
}

function makeMatch(db, scannedBy, max) {
  const pairs = takePairs(db.listing, max);
  if (!pairs.length) return null;
  const note = Math.random() < 0.6 ? { preset: pick(TRADE_NOTE_PRESETS) } : null;
  const m = {
    id: rid(), createdAt: Date.now(), expiresAt: Date.now() + MATCH_TTL, scannedBy,
    partner: fakePartner(db.listing.server, note), pairs, status: 'matched',
    revealed: false, partnerRevealed: false, myConfirm: null, partnerConfirm: null,
  };
  db.matches.unshift(m);
  return m;
}

function listingEmpty(l) {
  return !l || !Object.keys(l.give).length || !l.want.length;
}

export const api = {
  async createSession(provider, credential) {
    await delay(300);
    const db = load();
    if (!db.session) db.session = { token: rid(16), accountType: provider, credential: provider === 'bili' ? rid(32) : null };
    if (provider === 'bili') db.session.accountType = 'bili';
    save(db);
    return { ...db.session, credential: credential ? undefined : db.session.credential };
  },

  async getState(server) {
    const db = load();
    return {
      listing: db.listing,
      matches: db.matches.map(view),
      ...publishQuota(db.quotaUsedAt),
      completedCount: db.completedCount,
    };
  },

  /** POST /listings —— 发布并立即主动扫描（最多 3 对）。 */
  async publish({ give, want, note, server, mode }) {
    await delay();
    const db = load();
    if (!quotaLeft(db)) throw new ApiError('DAILY_LIMIT', { retryAt: publishQuota(db.quotaUsedAt).resetAt });
    if (db.listing) throw new ApiError('LISTING_EXISTS');
    if (db.matches.some(m => ['matched', 'confirming'].includes(m.status))) throw new ApiError('ACTIVE_EXCHANGE');
    if (note != null && !isPresetNote(note)) throw new ApiError('NOTE_REJECTED');
    note = note == null ? null : { preset: note.preset };
    db.listing = { id: rid(), give: { ...give }, want: [...want], note, server, mode, createdAt: Date.now() };
    db.quotaUsedAt = Date.now();
    const created = [];
    const go = dev.instantMatch === 'always' || (dev.instantMatch === 'random' && Math.random() < 0.55);
    if (go) {
      const m = makeMatch(db, 'me', ACTIVE_SCAN_MAX);
      if (m) created.push(m);
    }
    save(db);
    return { listing: db.listing, matches: created.map(view) };
  },

  /** PATCH /listings/current —— 等待中编辑，不触发主动扫描。 */
  async editListing({ give, want, note }) {
    await delay(250);
    const db = load();
    if (!db.listing) throw new ApiError('NO_LISTING');
    if (note != null && !isPresetNote(note)) throw new ApiError('NOTE_REJECTED');
    note = note == null ? null : { preset: note.preset };
    Object.assign(db.listing, { give: { ...give }, want: [...want], note });
    save(db);
    return db.listing;
  },

  async withdraw() {
    await delay(250);
    const db = load();
    db.listing = null;
    db.quotaUsedAt = 0;
    save(db);
  },

  /** POST /listings/current/rematch —— 开始十分钟冷却，再做一次主动扫描。 */
  async rematch(server) {
    await delay();
    const db = load();
    if (!quotaLeft(db)) throw new ApiError('DAILY_LIMIT', { retryAt: publishQuota(db.quotaUsedAt).resetAt });
    if (!db.listing) throw new ApiError('NO_LISTING');
    db.quotaUsedAt = Date.now();
    const m = dev.instantMatch === 'never' ? null : makeMatch(db, 'me', ACTIVE_SCAN_MAX);
    save(db);
    return { matches: m ? [view(m)] : [] };
  },

  async reveal(id) {
    await delay(300);
    const db = load();
    const m = db.matches.find((x) => x.id === id);
    if (!m) throw new ApiError('NOT_FOUND');
    if (!['matched', 'confirming'].includes(m.status) || m.expiresAt <= Date.now()) throw new ApiError('MATCH_CLOSED');
    m.revealed = true;
    m.revealedAt = m.revealedAt || Date.now();
    save(db);
    return { uid: m.partner.uid };
  },

  /** POST /matches/:id/confirm */
  async confirm(id, { result, completedPairs, reason, note }) {
    await delay();
    const db = load();
    const m = db.matches.find((x) => x.id === id);
    if (!m) throw new ApiError('NOT_FOUND');
    if (!['matched', 'confirming'].includes(m.status) || m.expiresAt <= Date.now()) throw new ApiError('MATCH_CLOSED');
    if (m.myConfirm) throw new ApiError('CONFIRM_ALREADY_SUBMITTED');
    if (result === 'completed') completedPairs ??= m.pairs.map((_, i) => i);
    m.myConfirm = { result, completedPairs, reason, note, at: Date.now() };
    let outcome;
    if (result === 'completed') {
      const done = completedPairs ?? m.pairs.map((_, i) => i);
      releasePairs(db.listing, m.pairs.filter((_, i) => !done.includes(i)));
      // 成功声明结束本次需求；已有匹配继续确认，不自动匹配剩余牌。
      db.listing = null;
      m.status = m.partnerConfirm ? 'completed' : 'confirming';
      if (m.status === 'confirming') m.expiresAt = m.myConfirm.at + CONFIRM_TIMEOUT;
      if (m.status === 'completed') {
        db.completedCount += 1;
        db.quotaUsedAt = 0;
      }
      outcome = m.status;
    } else {
      m.status = 'failed';
      releasePairs(db.listing, m.pairs);
      outcome = PARTNER_FAULT.includes(reason) ? 'back_to_pool' : 'released';
    }
    save(db);
    return { match: view(m), outcome };
  },

  async getAuthorMid() {
    return '0';
  },

  stats(server) {
    // 稳定的伪随机等待人数（按服务器）
    const base = { celestia: 312, irminsul: 312, asia: 128, america: 96, europe: 74, tw: 41 }[server] || 64;
    return { waiting: base + (new Date().getMinutes() % 7) };
  },

  // ---------- 以下为原型调试用：模拟「对方」的行为 ----------
  dev: {
    /** 有人主动扫描时匹配到我（被动匹配，单次最多 3 对）。 */
    incoming() {
      const db = load();
      if (listingEmpty(db.listing)) return null;
      const m = makeMatch(db, 'partner', ACTIVE_SCAN_MAX);
      save(db);
      return m && view(m);
    },
    partnerReveal() {
      const db = load();
      const m = db.matches.find((x) => x.status === 'matched' || x.status === 'confirming');
      if (!m) return null;
      m.partnerRevealed = true;
      save(db);
      return view(m);
    },
    partnerConfirm() {
      const db = load();
      const m = db.matches.find((x) => x.status === 'matched' || x.status === 'confirming');
      if (!m) return null;
      if (m.partnerConfirm) return view(m);
      m.partnerConfirm = { result: 'completed', completedPairs: m.pairs.map((_, i) => i), at: Date.now() };
      db.listing = null;
      if (m.myConfirm) {
        m.status = 'completed';
        db.completedCount += 1;
        db.quotaUsedAt = 0;
      } else {
        m.status = 'confirming';
        m.expiresAt = m.partnerConfirm.at + CONFIRM_TIMEOUT;
      }
      save(db);
      return view(m);
    },
    resetQuota() {
      const db = load();
      db.quotaUsedAt = 0;
      save(db);
    },
  },
};
