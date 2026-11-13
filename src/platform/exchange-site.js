/** 分享地址只携带站点路由，不携带 UID、身份凭据或本地调试参数。 */
export function standaloneSiteUrl(href, publicUrl = '') {
  const url = publicUrl ? new URL(publicUrl) : new URL('./', href);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_site_url');
  url.search = '';
  url.hash = '/welcome';
  return url.href;
}

/** B站地址必须属于 Toy 页面，不能意外使用自部署域名或其他 B站页面。 */
export function biliToyPageUrl(href, path = 'index.html#/welcome') {
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
