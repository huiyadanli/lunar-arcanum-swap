import { CARD_BY_ID } from '../data/cards.js';
import { exportShareImage } from './image-export.js';

const W = 1080;
const M = 56; // 内容区左右边距
const CW = W - M * 2;
const R = W - M;
const INK = '#f2ebdb';
const GOLD = '#dfc48c';
const MUTED = '#a2afc8';
const SKY = '#93c9db';
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

/** 仅在浏览器支持时加字距；不支持时照常绘制，不影响排版。 */
function spaced(ctx, value, x, y, size, color, spacing, weight = 600, family = SERIF) {
  const supported = 'letterSpacing' in ctx;
  if (supported) ctx.letterSpacing = `${spacing}px`;
  text(ctx, value, x, y, size, color, weight, family);
  if (supported) ctx.letterSpacing = '0px';
}

/** 鎏金弯月与星轨：页眉的主视觉，不占用卡牌区域的高度。 */
function moon(ctx, cx, cy, r) {
  const halo = ctx.createRadialGradient(cx, cy, r * .5, cx, cy, r * 3.4);
  halo.addColorStop(0, '#ecd9a438'); halo.addColorStop(.45, '#8f9ac414'); halo.addColorStop(1, '#8f9ac400');
  ctx.fillStyle = halo; ctx.fillRect(cx - r * 3.4, cy - r * 3.4, r * 6.8, r * 6.8);
  ctx.save();
  ctx.lineWidth = 1;
  [[1.7, .56, '#d9bd8050'], [2.25, .78, '#d9bd8026']].forEach(([a, b, color]) => {
    ctx.strokeStyle = color; ctx.beginPath(); ctx.ellipse(cx, cy, r * a, r * b, -.38, 0, Math.PI * 2); ctx.stroke();
  });
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#ecd9a40f'; ctx.fill();
  ctx.clip();
  const gold = ctx.createLinearGradient(cx - r, cy - r, cx + r * .4, cy + r);
  gold.addColorStop(0, '#fff6dc'); gold.addColorStop(.55, '#e6cc94'); gold.addColorStop(1, '#b98f4c');
  ctx.beginPath(); ctx.rect(cx - r, cy - r, r * 2, r * 2);
  ctx.arc(cx + r * .44, cy - r * .2, r * .88, 0, Math.PI * 2, true);
  ctx.fillStyle = gold; ctx.fill('evenodd');
  ctx.restore();
  star(ctx, cx + r * 1.55, cy - r * .98, 9, GOLD);
  star(ctx, cx - r * 1.62, cy + r * .72, 6, GOLD);
  star(ctx, cx + r * .5, cy - r * .16, 5, '#fff6dc');
  star(ctx, cx - r * 2.3, cy - r * .7, 4, '#dfc48c99');
}

/**
 * 「给出 / 想要」左右并排的版式：两栏按卡牌数量分配宽度，并保证栏标题放得下。
 * 卡牌较多、并排放不下时返回 null，改为上下堆叠。
 */
function splitLayout(giveCount, wantCount, en) {
  const gap = 20;
  const minWidth = en ? 330 : 300;
  for (const [art, step] of [[124, 150], [112, 128]]) {
    const needs = [giveCount, wantCount].map((count) => Math.max(minWidth, 24 + count * step));
    const total = needs[0] + needs[1];
    if (total > CW - gap) continue;
    const giveWidth = Math.round(needs[0] + (CW - gap - total) * needs[0] / total);
    return { art, step, gap, widths: [giveWidth, CW - gap - giveWidth] };
  }
  return null;
}

/** 卡牌区排版：少量卡牌用大图；7 列能少排一行时改用 7 列，否则 6 列。split 为左右并排时的单行版式。 */
function sectionLayout(count, en, split = null) {
  let columns; let art; let step;
  if (split) { columns = count; art = split.art; step = split.step; }
  else if (count <= 4) { columns = Math.max(1, count); art = 136; step = 184; }
  else {
    columns = Math.ceil(count / 7) < Math.ceil(count / 6) ? 7 : 6;
    art = columns === 7 ? 112 : 128;
    step = (CW - 28) / columns;
  }
  const rows = Math.ceil(count / columns);
  // 行数确定后把卡牌均分到各行（如 8 张排成 4 + 4），避免末行只剩一两张。
  columns = Math.ceil(count / rows);
  const rowHeight = art * 1.5 + (en ? 54 : 40);
  return { columns, art, step, rowHeight, height: 66 + rows * rowHeight + (rows - 1) * 8 + 10 };
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
  // 两侧卡牌都不多时左右并排，名片接近方形，更适合聊天与动态里转发。
  const split = splitLayout(giveIds.length, want.length, en);
  const giveLayout = sectionLayout(giveIds.length, en, split);
  const wantLayout = sectionLayout(want.length, en, split);
  const sectionY = 308;
  const footerY = sectionY + (split ? giveLayout.height : giveLayout.height + 16 + wantLayout.height) + 16;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const url = new URL(site.url);
  const displayUrl = url.host + url.pathname + url.search + url.hash;
  const urlWidth = 670;
  ctx.font = `400 16px ${SANS}`;
  let urlLineCount = 1;
  let urlLine = '';
  for (const char of displayUrl) {
    if (ctx.measureText(urlLine + char).width > urlWidth && urlLine) { urlLineCount++; urlLine = char; }
    else urlLine += char;
  }
  const footerH = Math.max(244, 178 + urlLineCount * 22);
  const height = footerY + footerH + 72;
  canvas.width = W;
  canvas.height = height;
  const bg = ctx.createLinearGradient(0, 0, W * .35, height);
  bg.addColorStop(0, '#1b2b48'); bg.addColorStop(.4, '#111c33'); bg.addColorStop(1, '#090f20');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, height);
  const glow = ctx.createRadialGradient(900, 120, 0, 900, 120, 720);
  glow.addColorStop(0, '#7f86ab30'); glow.addColorStop(1, '#7f86ab00');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, height);
  const tide = ctx.createRadialGradient(120, height - 80, 0, 120, height - 80, 620);
  tide.addColorStop(0, '#4f8fb01c'); tide.addColorStop(1, '#4f8fb000');
  ctx.fillStyle = tide; ctx.fillRect(0, 0, W, height);
  // 固定星图：重新生成时装饰不跳动，也不影响内容或二维码。
  const starCount = Math.round(height / 18);
  for (let i = 0; i < starCount; i++) {
    const x = (i * 137.508 + 31) % W;
    const y = (i * 229.87 + 17) % height;
    if (i % 13 === 5) { star(ctx, x, y, 5, '#e5d8b555'); continue; }
    ctx.fillStyle = i % 4 ? '#e5d8b52a' : '#e5d8b56a';
    ctx.beginPath(); ctx.arc(x, y, i % 3 ? 1 : 1.8, 0, Math.PI * 2); ctx.fill();
  }
  panel(ctx, 18, 18, W - 36, height - 36, 26, null, '#d9bd8066');
  panel(ctx, 26, 26, W - 52, height - 52, 19, null, '#d9bd8022');
  [48, W - 48].forEach((x) => { star(ctx, x, 48, 8, GOLD); star(ctx, x, height - 48, 8, GOLD); });

  // 页眉：品牌、标题与弯月。
  moon(ctx, 898, 134, 56);
  spaced(ctx, 'LUNAR ARCANUM', M + 2, 90, 19, GOLD, 7);
  const titleInk = ctx.createLinearGradient(0, 104, 0, 170);
  titleInk.addColorStop(0, '#fffaf0'); titleInk.addColorStop(1, '#e3cfa2');
  if (en) {
    text(ctx, 'A little serendipity.', M, 156, 50, titleInk, 600, SERIF);
    spaced(ctx, 'COLLECT · CONNECT · COMPLETE', M + 2, 197, 15, MUTED, 3);
  } else {
    spaced(ctx, '月下换牌', M - 2, 162, 62, titleInk, 4, 700, SANS);
    spaced(ctx, '让多余，遇见期待。', M + 2, 201, 24, MUTED, 2, 400, SANS);
  }

  // 身份条：昵称、UID、服务器压缩为一行。
  const idY = 226;
  const idFill = ctx.createLinearGradient(M, 0, R, 0);
  idFill.addColorStop(0, '#d9bd8016'); idFill.addColorStop(1, '#d9bd8005');
  panel(ctx, M, idY, CW, 66, 33, idFill, '#d9bd803d');
  star(ctx, M + 34, idY + 33, 9, GOLD);
  ctx.font = `600 22px ${SANS}`;
  const serverW = Math.min(220, Math.max(96, ctx.measureText(server).width + 44));
  panel(ctx, R - 12 - serverW, idY + 12, serverW, 42, 21, '#d9bd8014', '#d9bd8066');
  ctx.textAlign = 'center'; fitText(ctx, server, R - 12 - serverW / 2, idY + 41, 22, serverW - 28, GOLD, 600);
  const uidText = includeUid ? `UID  ${uid}` : (en ? 'UID hidden' : 'UID 已隐藏');
  ctx.textAlign = 'right'; text(ctx, uidText, R - 32 - serverW, idY + 41, 21, includeUid ? INK : MUTED);
  const uidW = ctx.measureText(uidText).width;
  ctx.textAlign = 'left';
  fitText(ctx, displayName, M + 56, idY + 42, 25, R - 32 - serverW - uidW - 28 - (M + 56), INK, 600);

  function drawSection(list, x, y, w, h, layout, giving) {
    const { columns, art: artW, step, rowHeight } = layout;
    const artH = artW * 1.5;
    const accent = giving ? GOLD : SKY;
    const tint = giving ? '#d9bd80' : '#70bddd';
    const fill = ctx.createLinearGradient(0, y, 0, y + h);
    fill.addColorStop(0, `${tint}14`); fill.addColorStop(1, `${tint}04`);
    panel(ctx, x, y, w, h, 20, fill, `${tint}38`);
    star(ctx, x + 30, y + 35, 8, accent);
    const title = giving ? (en ? 'I CAN OFFER' : '我能给出') : (en ? 'LOOKING FOR' : '我想要');
    text(ctx, title, x + 48, y + 44, 25, accent, 600);
    const titleEnd = x + 48 + ctx.measureText(title).width;
    const summary = giving ? Object.values(give).reduce((a, b) => a + b, 0) : list.length;
    const note = en ? `${summary} ${giving ? 'cards' : 'wanted'}` : `${summary} ${giving ? '张可换' : '种想要'}`;
    ctx.textAlign = 'right'; text(ctx, note, x + w - 26, y + 42, 19, MUTED); ctx.textAlign = 'left';
    const noteStart = x + w - 26 - ctx.measureText(note).width;
    const rule = ctx.createLinearGradient(titleEnd + 16, 0, noteStart - 16, 0);
    rule.addColorStop(0, `${tint}66`); rule.addColorStop(1, `${tint}0a`);
    ctx.fillStyle = rule; ctx.fillRect(titleEnd + 16, y + 35, Math.max(0, noteStart - titleEnd - 32), 1);
    list.forEach((id, i) => {
      const row = Math.floor(i / columns);
      const cardsInRow = Math.min(columns, list.length - row * columns);
      const left = x + (w - step * cardsInRow) / 2 + (step - artW) / 2 + (i % columns) * step;
      const top = y + 64 + row * (rowHeight + 8);
      const cx = left + artW / 2;
      const c = CARD_BY_ID[id];
      // 以卡面主色做柔光，代替方框底板，让卡牌本身的拱形轮廓成为主角。
      const aura = ctx.createRadialGradient(cx, top + artH * .5, artW * .1, cx, top + artH * .5, artW * .92);
      aura.addColorStop(0, `${c.color}4d`); aura.addColorStop(1, `${c.color}00`);
      ctx.fillStyle = aura; ctx.fillRect(cx - artW, top - artW * .2, artW * 2, artH + artW * .4);
      ctx.save();
      ctx.shadowColor = '#00000073'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6;
      ctx.drawImage(images[id], left, top, artW, artH);
      ctx.restore();
      if (giving) {
        const badgeW = give[id] > 9 ? 54 : 44;
        panel(ctx, left + artW - badgeW + 6, top + artH - 30, badgeW, 28, 14, '#101b30', '#dfc48c99');
        ctx.textAlign = 'center'; text(ctx, `×${give[id]}`, left + artW - badgeW / 2 + 6, top + artH - 10, 18, GOLD, 600); ctx.textAlign = 'left';
      }
      ctx.textAlign = 'center';
      const name = c.name[en ? 'en' : 'zh-CN'];
      if (en) {
        const words = name.replace(/^The /, '').split(' ');
        const middle = words.length > 2 ? 2 : 1;
        fitText(ctx, words.slice(0, middle).join(' '), cx, top + artH + 24, 17, step - 8);
        if (words.length > middle) fitText(ctx, words.slice(middle).join(' '), cx, top + artH + 44, 17, step - 8);
      } else text(ctx, name, cx, top + artH + 29, artW < 120 ? 20 : 21, INK);
      ctx.textAlign = 'left';
    });
  }
  if (split) {
    const [giveWidth, wantWidth] = split.widths;
    drawSection(giveIds, M, sectionY, giveWidth, giveLayout.height, giveLayout, true);
    drawSection(want, R - wantWidth, sectionY, wantWidth, wantLayout.height, wantLayout, false);
    // 两栏之间的互换徽记，把左右连成一次「交换」。
    const ex = M + giveWidth + split.gap / 2;
    const ey = sectionY + 64 + giveLayout.art * .75;
    ctx.beginPath(); ctx.arc(ex, ey, 25, 0, Math.PI * 2);
    ctx.fillStyle = '#0f192e'; ctx.fill(); ctx.strokeStyle = '#dfc48c88'; ctx.lineWidth = 1; ctx.stroke();
    ctx.save();
    ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    [[-1, GOLD], [1, SKY]].forEach(([dir, color]) => {
      const ay = ey + dir * 6;
      ctx.strokeStyle = color; ctx.beginPath();
      ctx.moveTo(ex + dir * 11, ay); ctx.lineTo(ex - dir * 11, ay);
      ctx.moveTo(ex - dir * 6, ay - 5); ctx.lineTo(ex - dir * 11, ay); ctx.lineTo(ex - dir * 6, ay + 5);
      ctx.stroke();
    });
    ctx.restore();
  } else {
    drawSection(giveIds, M, sectionY, CW, giveLayout.height, giveLayout, true);
    drawSection(want, M, sectionY + giveLayout.height + 16, CW, wantLayout.height, wantLayout, false);
  }

  // 页脚延续整张名片的深蓝底、细金边和浅金文字，仅二维码保留明亮底色与完整静区以保证扫码；二维码上不叠加图标。
  const bili = site.kind === 'bili';
  const footFill = ctx.createLinearGradient(M, 0, R, 0);
  footFill.addColorStop(0, '#ffffff05'); footFill.addColorStop(1, '#d9bd8012');
  panel(ctx, M, footerY, CW, footerH, 20, footFill, '#d9bd803d');
  const label = bili ? (en ? 'BILIBILI TOY' : 'B站 Toy · 月谕圣牌交换站') : (en ? 'INDEPENDENT SITE' : 'BetterGI·月谕圣牌交换站');
  star(ctx, M + 34, footerY + 48, 7, GOLD);
  fitText(ctx, label, M + 52, footerY + 56, 21, urlWidth - 22, GOLD, 600);
  fitText(ctx, en ? 'Find your missing piece.' : '缺的那张，总有人多一张。', M + 28, footerY + 108, en ? 30 : 32, urlWidth, INK, 600, en ? SERIF : SANS);
  text(ctx, bili ? (en ? 'Scan with the Bilibili app' : '用 B站 App 扫码，来这里换牌') : (en ? 'Scan to open this swap site' : '扫码打开本站，一起寻找换牌伙伴'), M + 28, footerY + 147, 20, MUTED);
  // 使用实际链接，完整换行展示；长度过长时在下方继续排版。
  lines(ctx, displayUrl, M + 28, footerY + 184, urlWidth, 22, 16, '#8793ad');
  const qrSize = 224;
  const qrX = R - 12 - qrSize;
  const qrY = footerY + (footerH - qrSize) / 2;
  panel(ctx, qrX, qrY, qrSize, qrSize, 12, '#ffffff', '#dfc48c');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qr, qrX + 5, qrY + 5, qrSize - 10, qrSize - 10);
  ctx.imageSmoothingEnabled = true;
  const date = new Intl.DateTimeFormat(en ? 'en-GB' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(createdAt);
  text(ctx, en ? `TRADE WISHES · ${date}` : `换牌心愿 · ${date}`, M + 18, height - 39, 16, MUTED);
  ctx.textAlign = 'right'; spaced(ctx, 'MAY EVERY CARD FIND ITS HOME', R - 18, height - 39, 12, GOLD, 1.5);
  return { ...exportShareImage(canvas), width: W, height };
}
