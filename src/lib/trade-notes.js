// 快捷留言与新增的固定时段共用预设白名单，不接受自由文本。
export const QUICK_NOTE_PRESETS = ['online_tonight', 'anytime', 'weekday_night', 'weekend'];
export const TRADE_TIME_PRESETS = [
  'time_morning', 'time_noon', 'time_afternoon',
  'time_evening', 'time_night', 'time_overnight',
];
export const TRADE_NOTE_PRESETS = [...QUICK_NOTE_PRESETS, ...TRADE_TIME_PRESETS];

export const TRADE_NOTE_LABELS = {
  anytime: { 'zh-CN': '随时可加', en: 'Add me anytime' },
  time_morning: { 'zh-CN': '08:00–12:00', en: '08:00–12:00' },
  time_noon: { 'zh-CN': '12:00–14:00', en: '12:00–14:00' },
  time_afternoon: { 'zh-CN': '14:00–18:00', en: '14:00–18:00' },
  time_evening: { 'zh-CN': '18:00–20:00', en: '18:00–20:00' },
  time_night: { 'zh-CN': '20:00–24:00', en: '20:00–24:00' },
  time_overnight: { 'zh-CN': '00:00–08:00', en: '00:00–08:00' },
  online_tonight: { 'zh-CN': '今晚 20 点后在线', en: 'Online after 8pm' },
  weekday_night: { 'zh-CN': '工作日晚上', en: 'Weekday evenings' },
  weekend: { 'zh-CN': '周末全天在线', en: 'Online all weekend' },
};

export function isTimePresetNote(note) {
  return isPresetNote(note) && TRADE_TIME_PRESETS.includes(note.preset);
}

export function isPresetNote(note) {
  return note !== null && typeof note === 'object' && !Array.isArray(note)
    && typeof note.preset === 'string' && Object.hasOwn(TRADE_NOTE_LABELS, note.preset)
    && !Object.hasOwn(note, 'text');
}
