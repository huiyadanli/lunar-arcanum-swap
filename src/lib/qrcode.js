import qrcode from 'qrcode-generator';

/** 本地生成真正可扫描的二维码；不向第三方发送站点地址。 */
export function createQrDataUrl(url, size = 320) {
  const qr = qrcode(0, 'M');
  qr.addData(new URL(url).href);
  qr.make();
  const modules = qr.getModuleCount();
  const cell = Math.max(1, Math.floor(size / (modules + 8)));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (modules + 8) * cell;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111827';
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (qr.isDark(y, x)) ctx.fillRect((x + 4) * cell, (y + 4) * cell, cell, cell);
    }
  }
  return canvas.toDataURL('image/png');
}
