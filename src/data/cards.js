// 22 种月谕圣牌元数据（设计文档 2.2，官方中英文名）。
// 中文显示名省略官方名称中的中文数字序号与分隔点。
// color 为从卡面插画提取的主色，用于光晕与选中态。

const RAW = [
  [1, 'I', '魔法师', 'The Magician', '#994B7D', '🎩'],
  [2, 'II', '女祭司', 'The High Priestess', '#559680', '🌙'],
  [3, 'III', '女皇', 'The Empress', '#BB9B5D', '👑'],
  [4, 'IV', '皇帝', 'The Emperor', '#4A89AF', '🏰'],
  [5, 'V', '圣职者', 'The Hierophant', '#49A9B0', '📿'],
  [6, 'VI', '恋人', 'The Lovers', '#8F4861', '💞'],
  [7, 'VII', '战车', 'The Chariot', '#BF9757', '🏇'],
  [8, 'VIII', '力量', 'Strength', '#BC7941', '🦁'],
  [9, 'IX', '隐者', 'The Hermit', '#899A5C', '🏮'],
  [10, 'X', '命运之轮', 'The Wheel of Fortune', '#6F586D', '🎡'],
  [11, 'XI', '正义', 'Justice', '#6090CB', '⚖️'],
  [12, 'XII', '倒吊人', 'The Hanged Man', '#924D9E', '🙃'],
  [13, 'XIII', '死神', 'Death', '#844143', '💀'],
  [14, 'XIV', '节制', 'Temperance', '#A48B61', '🍷'],
  [15, 'XV', '魔鬼', 'The Devil', '#8A449F', '😈'],
  [16, 'XVI', '塔', 'The Tower', '#6C54AB', '⚡'],
  [17, 'XVII', '星', 'The Star', '#4D6FBF', '⭐'],
  [18, 'XVIII', '月亮', 'The Moon', '#5697AA', '🌕'],
  [19, 'XIX', '太阳', 'The Sun', '#BBBF51', '☀️'],
  [20, 'XX', '审判', 'Judgment', '#4876BA', '📯'],
  [21, 'XXI', '世界', 'The World', '#AB905C', '🌍'],
  [22, 'XXII', '愚者', 'The Fool', '#4F8CC7', '🃏'],
];

const slug = (en) => en.toLowerCase().replace(/ /g, '-');

// 显式导入所有尺寸的卡图，让 Vite 生成带哈希且支持子目录部署的资源地址。
const cardImages = import.meta.glob('../../assets/cards/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

export const CARDS = RAW.map(([id, roman, zh, en, color, emoji]) => {
  const base = `../../assets/cards/${String(id).padStart(2, '0')}-${slug(en)}`;
  return {
    id,
    roman,
    color,
    emoji,
    name: { 'zh-CN': zh, en, enFull: `Lunar Arcanum ${roman}: ${en}` },
    img: {
      s: cardImages[`${base}-160.webp`],
      m: cardImages[`${base}-360.webp`],
      l: cardImages[`${base}-684.webp`],
    },
  };
});

export const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));
export const CARD_COUNT = CARDS.length;
