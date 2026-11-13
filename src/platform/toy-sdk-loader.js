const SDK_URL = 'https://s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js';
const pendingLoads = new WeakMap();

/** 只接受 B站主域名及子域名，避免误认 bilibili.com.example.com 等地址。 */
export function isBilibiliHost(hostname) {
  return /(^|\.)bilibili\.com$/i.test(hostname);
}

/** 在平台初始化前等待真实 SDK；独立站不下载、不启用真实 Toy SDK。 */
export async function loadToySdk({ win = window, doc = document, timeoutMs = 10000 } = {}) {
  if (!isBilibiliHost(win.location.hostname)) return null;
  if (win.toy && !win.toy.__mock) return win.toy;
  if (pendingLoads.has(win)) return pendingLoads.get(win);

  const loading = new Promise((resolve) => {
    const script = doc.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    let finished = false;
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      script.onload = script.onerror = null;
      const toy = !reason && win.toy && !win.toy.__mock ? win.toy : null;
      if (!toy) {
        script.remove();
        console.warn('[Toy SDK] 加载失败，使用独立站能力：', reason || '脚本未提供 window.toy');
      }
      resolve(toy);
    };
    const timer = setTimeout(() => finish('加载超时'), timeoutMs);
    script.onload = () => finish();
    script.onerror = () => finish('网络错误');
    doc.head.appendChild(script);
  });
  pendingLoads.set(win, loading);
  return loading;
}
