import { ApiError } from './errors.js';
import { resolveUid, SERVERS } from '../src/lib/uid.js';
import { TRADE_NOTE_LABELS, isPresetNote } from '../src/lib/trade-notes.js';

export const PRESETS = Object.keys(TRADE_NOTE_LABELS);
export const REASONS = ['no_friend', 'no_response', 'no_card', 'changed_mind', 'self', 'other'];
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function invalid(code = 'INVALID_REQUEST') { throw new ApiError(code, 422); }
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
export function text(value, max, { optional = false, filter = true } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string') invalid();
  const cleaned = value.normalize('NFKC').trim();
  if (!cleaned || [...cleaned].length > max || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(cleaned)) invalid();
  if (filter && /(?:https?:|www\.|[\w.-]+\.(?:com|cn|net|org)\b|(?:qq|微信|wechat|电话|手机|加群|群号)\s*[:：号]?\s*[a-z\d_-]{5,}|\b1[3-9]\d{9}\b)/iu.test(cleaned)) {
    throw new ApiError('NOTE_REJECTED', 422);
  }
  return cleaned;
}
export function note(value) {
  if (value === undefined || value === null) return null;
  const item = object(value);
  if (isPresetNote(item)) return { preset: item.preset };
  invalid('NOTE_REJECTED');
}
export function profile(value) {
  const input = object(value);
  const result = {};
  if (Object.hasOwn(input, 'uid')) {
    if (typeof input.uid !== 'string') invalid('UID_INVALID');
    const uid = input.uid.trim();
    const resolved = resolveUid(uid);
    if (resolved.state !== 'ok') invalid('UID_INVALID');
    Object.assign(result, { uid, server: resolved.server, region: SERVERS[resolved.server].region });
  }
  if (Object.hasOwn(input, 'toyOpenId')) result.toyOpenId = text(input.toyOpenId, 256, { filter: false });
  if (!Object.keys(result).length) invalid();
  return result;
}
export function listing(value, editing = false) {
  const input = object(value);
  const give = object(input.give);
  const entries = Object.entries(give);
  if (!entries.length || entries.length > 22 || !Array.isArray(input.want) || !input.want.length || input.want.length > 22) invalid('INVALID_CARDS');
  let total = 0;
  const normalizedGive = {};
  for (const [key, quantity] of entries) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 1 || id > 22 || String(id) !== key || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) invalid('INVALID_CARDS');
    normalizedGive[id] = quantity;
    total += quantity;
  }
  if (total > 200 || new Set(input.want).size !== input.want.length || input.want.some(id => !Number.isInteger(id) || id < 1 || id > 22 || normalizedGive[id])) invalid('INVALID_CARDS');
  const result = { give: normalizedGive, want: [...input.want].sort((a, b) => a - b), note: note(input.note) };
  if (editing) {
    if (!Number.isSafeInteger(input.version) || input.version < 1) invalid('VERSION_REQUIRED');
    result.version = input.version;
  } else {
    if (!['quick', 'box'].includes(input.mode)) invalid();
    result.mode = input.mode;
  }
  return result;
}
export function matchId(value) {
  if (!UUID.test(value)) throw new ApiError('NOT_FOUND', 404);
  return value.toLowerCase();
}
export function confirmation(value) {
  const input = object(value);
  if (!['completed', 'failed'].includes(input.result)) invalid();
  const result = { result: input.result };
  if (input.result === 'completed') {
    const indices = input.completedPairs;
    if (indices === undefined) return result;
    if (!Array.isArray(indices) || !indices.length || indices.length > 3 || new Set(indices).size !== indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i > 2)) invalid('INVALID_COMPLETED_PAIRS');
    result.completedPairs = [...indices].sort((a, b) => a - b);
  } else {
    if (!REASONS.includes(input.reason)) invalid();
    result.reason = input.reason;
    const explanation = text(input.note, 120, { optional: true });
    if (explanation) result.note = explanation;
  }
  return result;
}
export function feedback(value) {
  const input = object(value);
  if (!['appeal', 'report'].includes(input.kind)) invalid();
  const result = { kind: input.kind };
  const reason = text(input.reason, 40, { optional: true });
  const explanation = text(input.note, 200, { optional: true });
  if (reason) result.reason = reason;
  if (explanation) result.note = explanation;
  if (input.kind === 'report' && !reason) invalid();
  return result;
}
export function historyCursor(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 256 || !/^[\w-]+$/.test(value)) invalid('INVALID_CURSOR');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { invalid('INVALID_CURSOR'); }
  if (typeof parsed?.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed.at) || !Number.isFinite(Date.parse(parsed.at)) || !UUID.test(parsed.id || '')) invalid('INVALID_CURSOR');
  return { at: parsed.at, id: parsed.id };
}
