/** 保留画布尺寸，以适合转发的 JPEG 导出；编码不支持时按实际格式命名。 */
export function exportShareImage(canvas) {
  const targetBytes = 600 * 1024;
  let dataUrl;
  let bytes;
  for (const quality of [0.86, 0.78, 0.7]) {
    dataUrl = canvas.toDataURL('image/jpeg', quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    bytes = Math.floor(base64.length * 3 / 4) - padding;
    if (bytes <= targetBytes || !dataUrl.startsWith('data:image/jpeg;')) break;
  }
  const jpeg = dataUrl.startsWith('data:image/jpeg;');
  return { dataUrl, bytes, mimeType: jpeg ? 'image/jpeg' : 'image/png', extension: jpeg ? 'jpg' : 'png' };
}
