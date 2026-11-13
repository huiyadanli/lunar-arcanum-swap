import { CARD_BY_ID } from '../data/cards.js';

const W = 1080;
const INK = '#f2ebdb';
const GOLD = '#dfc48c';
const MUTED = '#a2afc8';
const SANS = '"Microsoft YaHei", "PingFang SC", sans-serif';
const SERIF = 'Cinzel, Georgia, serif';

function imageOf(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('image_timeout')), 12000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('image_load_failed')); };
    img.src = src;
  });
}

function panel(ctx, x, y, w, h, radius, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function text(ctx, value, x, y, size, color = INK, weight = 400, family = SANS) {
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

function fitText(ctx, value, x, y, size, width, color = INK, weight = 400, family = SANS) {
  ctx.font = `${weight} ${size}px ${family}`;
  while (size > 12 && ctx.measureText(value).width > width) ctx.font = `${weight} ${--size}px ${family}`;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

function lines(ctx, value, x, y, width, lineHeight, size, color) {
  ctx.font = `400 ${size}px ${SANS}`;
  ctx.fillStyle = color;
  let line = '';
  let row = 0;
  for (const char of value) {
    if (ctx.measureText(line + char).width > width && line) {
      ctx.fillText(line, x, y + row++ * lineHeight);
      line = char;
    } else line += char;
  }
  if (line) ctx.fillText(line, x, y + row++ * lineHeight);
  return row;
}

function star(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + r * .25, y - r * .25);
  ctx.lineTo(x + r, y); ctx.lineTo(x + r * .25, y + r * .25);
  ctx.lineTo(x, y + r); ctx.lineTo(x - r * .25, y + r * .25);
  ctx.lineTo(x - r, y); ctx.lineTo(x - r * .25, y - r * .25);
  ctx.closePath(); ctx.fillStyle = color; ctx.fill();
}

function sectionLayout(count) {
  const columns = count <= 4 ? Math.max(3, count) : 6;
  const artWidth = count <= 4 ? 180 : 130;
  const rowHeight = artWidth * 1.5 + 80;
  return { columns, artWidth, rowHeight, height: 100 + Math.ceil(count / columns) * rowHeight };
}

/** Canvas 直接绘制高清名片，预览即导出结果；不依赖 DOM 截图或外部生图服务。 */
export async function renderExchangeCard({ give, want, displayName, server, uid, includeUid = true, lang, site, createdAt }) {
  const en = lang === 'en';
  const giveIds = Object.keys(give).map(Number);
  const ids = [...new Set([...giveIds, ...want])];
  const [qr, ...art] = await Promise.all([
    imageOf(site.qr),
    ...ids.map((id) => imageOf(CARD_BY_ID[id].img.m)),
    document.fonts.load(`600 24px ${SERIF}`),
  ]);
  const images = Object.fromEntries(ids.map((id, i) => [id, art[i]]));
  const giveH = sectionLayout(giveIds.length).height;
  const wantH = sectionLayout(want.length).height;
  const footerY = 435 + giveH + wantH + 32;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const url = new URL(site.url);
  const displayUrl = url.host + url.pathname + url.search + url.hash;
  ctx.font = `400 17px ${SANS}`;
  let urlLineCount = 1;
  let urlLine = '';
  for (const char of displayUrl) {
    if (ctx.measureText(urlLine + char).width > 590 && urlLine) { urlLineCount++; urlLine = char; }
    else urlLine += char;
  }
  const footerH = Math.max(268, 190 + urlLineCount * 24);
  const height = footerY + footerH + 82;
  canvas.width = W;
  canvas.height = height;
  const bg = ctx.createLinearGradient(0, 0, W, height);
  bg.addColorStop(0, '#182740'); bg.addColorStop(.38, '#101a30'); bg.addColorStop(1, '#0a1123');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, height);
  const glow = ctx.createRadialGradient(850, 130, 0, 850, 130, 660);
  glow.addColorStop(0, '#6d759529'); glow.addColorStop(1, '#6d759500');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, height);
  // 固定星图：重新生成时装饰不跳动，也不影响内容或二维码。
  for (let i = 0; i < 110; i++) {
    const x = (i * 137.508 + 31) % W;
    const y = (i * 229.87 + 17) % height;
    ctx.fillStyle = i % 4 ? '#e5d8b52a' : '#e5d8b56a';
    ctx.beginPath(); ctx.arc(x, y, i % 3 ? 1 : 1.8, 0, Math.PI * 2); ctx.fill();
  }
  panel(ctx, 26, 26, W - 52, height - 52, 24, null, '#d9bd8055');
  panel(ctx, 35, 35, W - 70, height - 70, 18, null, '#d9bd801c');
  [62, W - 62].forEach((x) => { star(ctx, x, 62, 8, GOLD); star(ctx, x, height - 62, 8, GOLD); });

  text(ctx, 'L U N A R   A R C A N U M', 80, 93, 21, GOLD, 600, SERIF);
  text(ctx, en ? 'A little' : '月下换牌', 77, 180, en ? 59 : 68, INK, 600, en ? SERIF : SANS);
  text(ctx, en ? 'serendipity.' : '让多余，遇见期待。', 80, 239, en ? 45 : 28, en ? INK : MUTED, en ? 600 : 400, en ? SERIF : SANS);
  text(ctx, 'COLLECT · CONNECT · COMPLETE', 81, 283, 15, GOLD, 600, SERIF);

  // 卡面扇形与同心星轨，与站点已有的月夜主题呼应。
  ctx.save();
  ctx.strokeStyle = '#d9bd8033';
  [113, 145, 160].forEach((r) => { ctx.beginPath(); ctx.arc(840, 194, r, 0, Math.PI * 2); ctx.stroke(); });
  const hero = ids.slice(0, 3);
  hero.forEach((id, i) => {
    const offset = i - (hero.length - 1) / 2;
    ctx.save(); ctx.translate(840 + offset * 83, 188 + Math.abs(offset) * 12); ctx.rotate(offset * .23);
    ctx.shadowColor = '#0009'; ctx.shadowBlur = 24;
    ctx.drawImage(images[id], -70, -105, 140, 210); ctx.restore();
  });
  star(ctx, 1000, 125, 10, GOLD); star(ctx, 672, 238, 7, GOLD);
  ctx.restore();

  panel(ctx, 72, 325, 936, 92, 16, '#ffffff06', '#d9bd8033');
  star(ctx, 103, 370, 10, GOLD);
  fitText(ctx, displayName, 127, 365, 27, 450, INK, 600);
  text(ctx, includeUid ? `UID  ${uid}` : (en ? 'UID hidden' : 'UID 已隐藏'), 127, 395, 20, MUTED);
  panel(ctx, 785, 346, 197, 46, 23, '#d9bd8012', '#d9bd8055');
  ctx.textAlign = 'center'; fitText(ctx, server, 884, 377, 23, 173, GOLD, 600); ctx.textAlign = 'left';

  function drawSection(list, y, h, giving) {
    const { columns, artWidth, rowHeight } = sectionLayout(list.length);
    const step = 900 / columns;
    const tileW = artWidth + 8;
    const tileH = artWidth * 1.5 + 20;
    const accent = giving ? GOLD : '#93c9db';
    panel(ctx, 72, y, 936, h, 20, giving ? '#d9bd8007' : '#70bddd07', giving ? '#d9bd8030' : '#70bddd30');
    star(ctx, 104, y + 38, 7, accent);
    text(ctx, giving ? (en ? 'I CAN OFFER' : '我能给出') : (en ? 'LOOKING FOR' : '我想要'), 124, y + 47, 27, accent, 600);
    const summary = giving ? Object.values(give).reduce((a, b) => a + b, 0) : list.length;
    ctx.textAlign = 'right'; text(ctx, en ? `${summary} ${giving ? 'cards' : 'wanted'}` : `${summary} ${giving ? '张可换' : '种想要'}`, 977, y + 45, 20, MUTED); ctx.textAlign = 'left';
    list.forEach((id, i) => {
      const row = Math.floor(i / columns);
      const cardsInRow = Math.min(columns, list.length - row * columns);
      const x = 72 + (936 - step * cardsInRow) / 2 + (step - tileW) / 2 + (i % columns) * step;
      const top = y + 76 + row * rowHeight;
      const c = CARD_BY_ID[id];
      panel(ctx, x, top, tileW, tileH, [tileW / 2, tileW / 2, 12, 12], `${c.color}18`, `${c.color}55`);
      ctx.drawImage(images[id], x + 4, top + 6, artWidth, artWidth * 1.5);
      if (giving) {
        panel(ctx, x + tileW - 47, top + tileH - 31, 45, 28, 10, '#132238', '#d9bd8077');
        ctx.textAlign = 'center'; text(ctx, `×${give[id]}`, x + tileW - 25, top + tileH - 11, 18, GOLD, 600); ctx.textAlign = 'left';
      }
      ctx.textAlign = 'center';
      const name = c.name[en ? 'en' : 'zh-CN'];
      if (en) {
        const words = name.replace(/^The /, '').split(' ');
        const middle = words.length > 2 ? 2 : 1;
        fitText(ctx, words.slice(0, middle).join(' '), x + tileW / 2, top + tileH + 25, 18, step - 8);
        if (words.length > middle) fitText(ctx, words.slice(middle).join(' '), x + tileW / 2, top + tileH + 46, 18, step - 8);
      } else text(ctx, name, x + tileW / 2, top + tileH + 30, 23, INK);
      ctx.textAlign = 'left';
    });
  }
  drawSection(giveIds, 435, giveH, true);
  drawSection(want, 435 + giveH + 18, wantH, false);

  // 高对比的完整静区保留在二维码内；二维码上不叠加图标。
  // 页脚延续整张名片的深蓝底、细金边和浅金文字，仅二维码保留明亮底色以保证扫码。
  const bili = site.kind === 'bili';
  panel(ctx, 72, footerY, 936, footerH, 20, '#ffffff04', '#d9bd8033');
  const label = bili ? (en ? 'BILIBILI TOY' : 'B站 Toy · 月谕圣牌交换站') : (en ? 'INDEPENDENT SITE' : '独立站 · 月谕圣牌交换站');
  fitText(ctx, label, 103, footerY + 48, 23, 590, GOLD, 600);
  text(ctx, en ? 'Find your missing piece.' : '缺的那张，总有人多一张。', 101, footerY + 100, en ? 29 : 33, INK, 600, en ? SERIF : SANS);
  text(ctx, bili ? (en ? 'Scan with the Bilibili app' : '用 B站 App 扫码，来这里换牌') : (en ? 'Scan to open this swap site' : '扫码打开本站，一起寻找换牌伙伴'), 103, footerY + 142, 21, MUTED);
  // 使用实际链接，完整换行展示；长度过长时在下方继续排版。
  lines(ctx, displayUrl, 103, footerY + 185, 590, 24, 17, MUTED);
  panel(ctx, 736, footerY + 10, 248, 248, 14, '#d9bd800d', '#d9bd8040');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qr, 744, footerY + 18, 232, 232);
  ctx.imageSmoothingEnabled = true;
  const date = new Intl.DateTimeFormat(en ? 'en-GB' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(createdAt);
  text(ctx, en ? `TRADE WISHES · ${date}` : `换牌心愿 · ${date}`, 80, height - 44, 17, MUTED);
  ctx.textAlign = 'right'; text(ctx, 'MAY EVERY CARD FIND ITS HOME', 1000, height - 44, 13, GOLD, 600, SERIF);
  return { dataUrl: canvas.toDataURL('image/png'), width: W, height };
}
