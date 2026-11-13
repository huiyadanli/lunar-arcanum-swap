// 交换名片页脚的随机文案池：每次打开名片随机抽一句，保存前重新生成不会变。
// 想增删文案直接改这里；中文建议 16 字以内，英文 40 字符以内，以免页脚自动缩字过小。
export const TAGLINES = {
  'zh-CN': [
    '让多余，成为彼此的惊喜。',
    '一牌相赠，一月圆满。',
    '月相盈亏，圣牌有归。',
    '月谕所指，牌缘相逢。',
    '你的多余，恰是她的圆满。',
  ],
  en: [
    'Your spare, someone’s missing piece.',
    'One card shared, one moon made whole.',
    'As the moon turns, cards find their way home.',
    'Where the moon points, cards meet.',
    'Your spare is someone’s whole.',
  ],
};

export function pickTagline(lang) {
  const pool = TAGLINES[lang === 'en' ? 'en' : 'zh-CN'];
  return pool[Math.floor(Math.random() * pool.length)];
}
