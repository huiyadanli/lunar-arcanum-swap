/** 分享地址只指向站点主页，不携带路由、UID、身份凭据或本地调试参数。 */
export function standaloneSiteUrl(href, publicUrl = '') {
  const url = publicUrl ? new URL(publicUrl) : new URL('./', href);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_site_url');
  url.search = '';
  url.hash = '';
  return url.href;
}

/** B站地址必须属于 Toy 页面，不能意外使用自部署域名或其他 B站页面。 */
export function biliToyPageUrl(href, path = '') {
  try {
    const url = new URL(href);
    const root = url.pathname.match(/^\/toy\/[^/]+(?:\/|$)/)?.[0];
    if (url.protocol !== 'https:' || !/(^|\.)bilibili\.com$/.test(url.hostname) || !root || url.username || url.password) return null;
    url.pathname = root.replace(/\/$/, '') + '/';
    url.search = '';
    url.hash = '';
    if (typeof path !== 'string' || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path)) return null;
    const page = new URL(path, url);
    if (page.origin !== url.origin || !page.pathname.startsWith(url.pathname)) return null;
    return page.href;
  } catch {
    return null;
  }
}

export function isBiliToyUrl(href) {
  return !!biliToyPageUrl(href);
}

/** SDK 返回的 Toy 链接可能带 #/welcome 等路由；名片只需要 Toy 页面本身。 */
export function stripToyUrlHash(href) {
  try {
    const url = new URL(href);
    if (!url.hash) return href;
    url.hash = '';
    return url.href;
  } catch {
    return href;
  }
}
