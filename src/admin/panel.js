import './panel.css';
import { createAdminController } from './controller.js';
import { CARDS } from '../data/cards.js';
import { SERVERS } from '../lib/uid.js';
import { TRADE_NOTE_LABELS } from '../lib/trade-notes.js';

const STATUS = { waiting: '等待中', closed: '已关闭', matched: '已配对', confirming: '待确认', completed: '已完成',
  failed: '未完成', expired: '已超时', disputed: '有争议', pending: '待处理', resolved: '已处理' };
const TABS = { overview: '全池概览', waiting: '等待需求', matches: '配对记录', users: '用户资料', feedback: '用户反馈' };
let currentPanel;
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag); node.className = className; node.textContent = String(text ?? ''); return node;
};
const button = (text, action, className = 'admin-button') => {
  const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node;
};
const date = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value) : '—';
const card = id => CARDS.find(item => item.id === Number(id))?.name['zh-CN'] || `牌 ${id}`;
const cards = value => Array.isArray(value) ? value.map(card).join('、') || '—'
  : Object.entries(value || {}).map(([id, n]) => `${card(id)} ×${n}`).join('、') || '—';
const server = value => SERVERS[value]?.name['zh-CN'] || '未绑定区服';
const note = value => TRADE_NOTE_LABELS[value?.preset]?.['zh-CN'] || value?.text || '未选择留言';
const accountType = value => value === 'bili' ? 'B站账号' : '匿名账号';
const confirmation = value => !value ? '尚未确认' : value.result === 'completed'
  ? `声明完成：第 ${(value.completedPairs || []).map(n => n + 1).join('、')} 对`
  : `声明未完成：${value.reason || '未说明'}${value.note ? ` · ${value.note}` : ''}`;

/** 原生独立面板；所有用户内容用 textContent 渲染，不执行服务端返回的 HTML。 */
export function openAdminPanel({ query, accountType: type, mock = false }) {
  if (currentPanel) { currentPanel.focus(); return; }
  const root = el('section', 'admin-console');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'admin-title');
  // 这里仅含固定界面文本；动态记录均通过 el/textContent 追加。
  root.innerHTML = `
    <div class="admin-wrap">
      <header class="admin-header"><div><div class="admin-eyebrow">LUNAR ARCANUM · 只读后台</div>
        <h1 id="admin-title">匹配池管理</h1><p class="admin-updated">进入或手动刷新时更新 · 时间为北京时间</p></div>
        <button type="button" class="admin-close" aria-label="关闭管理面板">关闭后台</button></header>
      <p class="admin-demo" hidden>本地模拟数据，与个人交换数据相互独立。</p>
      <form class="admin-login"><h2>管理访问</h2><p class="admin-login-note"></p>
        <label class="admin-password-label">管理密码<input type="password" name="admin-password" autocomplete="off" maxlength="512"></label>
        <button type="submit" class="admin-button admin-primary">进入后台</button></form>
      <p class="admin-message" role="status" aria-live="polite"></p>
      <div class="admin-workspace" hidden>
        <nav class="admin-tabs" aria-label="后台视图"></nav>
        <form class="admin-filters">
          <label>区服<select name="server"><option value="">全部区服</option></select></label>
          <label>账号类型<select name="accountType"><option value="">全部账号</option><option value="anon">匿名账号</option><option value="bili">B站账号</option></select></label>
          <label>状态<select name="status"><option value="">默认状态</option></select></label>
          <label class="admin-search">搜索<input name="search" maxlength="128" placeholder="游戏 UID / 交换账号 ID"></label>
          <button class="admin-button admin-primary" type="submit">查询 / 刷新</button>
        </form>
        <div class="admin-context"></div><div class="admin-content" aria-busy="false"></div>
        <footer class="admin-pagination"></footer>
      </div>
    </div>`;
  const previousFocus = document.activeElement;
  const shell = document.querySelector('.shell');
  const previousInert = shell?.inert;
  const previousOverflow = document.body.style.overflow;
  if (shell) shell.inert = true;
  document.body.style.overflow = 'hidden';
  document.body.append(root);
  const find = selector => root.querySelector(selector);
  const login = find('.admin-login');
  const passwordInput = find('[name="admin-password"]');
  const filters = find('.admin-filters');
  const content = find('.admin-content');
  const message = find('.admin-message');
  const isBili = type === 'bili';
  find('.admin-demo').hidden = !mock;
  find('.admin-password-label').hidden = isBili;
  find('.admin-login-note').textContent = isBili ? '已登记的 B站交换账号可直接免密访问。'
    : mock ? '本地演示密码：dev-admin' : '使用当前匿名会话，输入管理密码后查看。';
  for (const [key, value] of Object.entries(SERVERS)) {
    const option = el('option', '', value.name['zh-CN']); option.value = key; filters.elements.server.append(option);
  }
  const controller = createAdminController({ query, onChange: render });

  function close() {
    controller.close(); passwordInput.value = ''; root.remove();
    if (shell) shell.inert = previousInert;
    document.body.style.overflow = previousOverflow;
    document.removeEventListener('keydown', onKey, true);
    currentPanel = null;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key === 'Tab') {
      const focusable = [...root.querySelectorAll('button,input,select,[tabindex="0"]')].filter(node => !node.disabled && node.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  find('.admin-close').addEventListener('click', close);
  login.addEventListener('submit', event => {
    event.preventDefault(); const value = passwordInput.value; passwordInput.value = ''; controller.unlock(value);
  });
  filters.addEventListener('submit', event => {
    event.preventDefault(); controller.filter(Object.fromEntries(['server', 'status', 'accountType', 'search'].map(key => [key, filters.elements[key].value])));
  });
  currentPanel = { focus: () => find('.admin-close').focus(), close };

  function fields(entries) {
    const list = el('dl', 'admin-fields');
    for (const [name, value] of entries) { list.append(el('dt', '', name), el('dd', '', value)); }
    return list;
  }
  function showDetail(item) {
    controller.detail(item); find('.admin-detail-title')?.focus();
  }
  function userLink(id, uid) {
    const wrapper = el('div', 'admin-identity');
    wrapper.append(el('strong', 'admin-mono', uid || '未填写 UID'), button(id, () => controller.select('users', id), 'admin-link admin-mono'));
    return wrapper;
  }
  function renderDetail(state) {
    const item = state.detail;
    content.append(button('返回列表', () => controller.detail(null), 'admin-button admin-back'));
    const heading = el('h2', 'admin-detail-title', `${TABS[state.view]}详情`); heading.tabIndex = -1; content.append(heading);
    if (state.view === 'users') {
      content.append(fields([['交换账号 ID', item.id], ['账号类型', accountType(item.accountType)], ['完整游戏 UID', item.uid || '未填写'],
        ['区服', server(item.server)], ['信用分', item.credit], ['完成交换数', item.completedCount], ['连续失败', item.failStreak],
        ['信用冷却截止', date(item.cooldownUntil)], ['发布额度恢复', date(item.quotaResetAt)], ['注册时间', date(item.createdAt)]]));
      const links = el('div', 'admin-actions');
      for (const [view, label] of [['waiting', '查看需求'], ['matches', '查看匹配历史'], ['feedback', '查看举报与申诉']]) {
        links.append(button(label, () => controller.select(view, item.id)));
      }
      content.append(links);
    } else if (state.view === 'waiting') {
      content.append(fields([['需求 ID', item.id], ['账号 ID', item.accountId], ['完整游戏 UID', item.uid], ['区服', server(item.server)],
        ['账号类型', accountType(item.accountType)], ['模式', item.mode === 'box' ? '完整 Box 发布' : '快速交换'],
        ['状态', STATUS[item.status]], ['参与等待匹配', item.eligible ? '是' : '否（已占满、关闭或受信用限制）'],
        ['可给出', cards(item.give)], ['想要', cards(item.want)], ['占用给出', cards(item.reservedGive)], ['占用想要', cards(item.reservedWant)],
        ['留言', note(item.note)], ['信用分', item.credit], ['信用冷却截止', date(item.cooldownUntil)], ['版本', item.version],
        ['发布时间', date(item.createdAt)], ['更新时间', date(item.updatedAt)]]));
    } else if (state.view === 'matches') {
      content.append(fields([['配对 ID', item.id], ['状态', STATUS[item.status]], ['区服', server(item.partnerA.server)],
        ['A 方账号', item.accountA], ['A 方 UID', item.partnerA.uid], ['A 方留言', note(item.partnerA.note)],
        ['B 方账号', item.accountB], ['B 方 UID', item.partnerB.uid], ['B 方留言', note(item.partnerB.note)],
        ['A 方需求 ID', item.listingA], ['B 方需求 ID', item.listingB], ['主动扫描账号', item.scannedBy],
        ['A 方确认', confirmation(item.confirmA)], ['B 方确认', confirmation(item.confirmB)],
        ['A 方查看 UID 时间', date(item.revealedAtA)], ['B 方查看 UID 时间', date(item.revealedAtB)],
        ['创建时间', date(item.createdAt)], ['到期时间', date(item.expiresAt)], ['结算时间', date(item.settledAt)]]));
      content.append(el('h3', '', '逐对交换内容'));
      item.pairs.forEach((pair, i) => content.append(el('p', 'admin-pair', `${i + 1}. A 给出 ${card(pair.aGives)} ⇄ B 给出 ${card(pair.bGives)}`)));
    } else {
      content.append(fields([['反馈 ID', item.id], ['提交账号', item.reporterAccountId], ['涉及账号', item.targetAccountId], ['关联配对', item.matchId],
        ['类型', item.kind === 'appeal' ? '申诉' : '举报'], ['状态', STATUS[item.status]], ['原因', item.reason || '—'], ['说明', item.note || '—'], ['提交时间', date(item.createdAt)]]));
    }
  }
  function renderOverview(data) {
    const metrics = el('div', 'admin-metrics');
    for (const [label, value] of [['全池参与人数', data.poolUsers], ['等待人数', data.waitingUsers], ['配对中人数', data.activeUsers],
      ['进行中配对', data.activeMatches], ['待确认配对', data.confirming], ['注册账号数', data.registeredUsers]]) {
      const metric = el('div', 'admin-metric'); metric.append(el('span', '', label), el('strong', '', value)); metrics.append(metric);
    }
    content.append(metrics, el('p', 'admin-hint', '人数按交换账号去重。等待与配对中人数可能重叠；相同游戏 UID 的不同账号分别计数。'));
    const statuses = el('div', 'admin-statuses');
    for (const key of ['matched', 'confirming', 'completed', 'failed', 'expired', 'disputed']) statuses.append(el('span', 'admin-badge', `${STATUS[key]} ${data.statuses?.[key] || 0}`));
    content.append(statuses);
    if (data.overdueMatches) content.append(el('p', 'admin-hint', `${data.overdueMatches} 个配对已到期，等待现有维护任务结算。`));
    const sections = el('div', 'admin-servers');
    for (const row of data.servers || []) {
      const section = el('section', 'admin-server'); section.append(el('h2', '', `${server(row.server)} · ${row.waiting} 人等待`));
      const activeCards = CARDS.filter(c => row.supply[c.id] || row.demand[c.id]);
      if (!activeCards.length) section.append(el('p', 'admin-hint', '暂无等待中的供需。'));
      else {
        const table = el('table'); const head = el('thead'), tr = el('tr');
        for (const label of ['卡牌', '可给出张数', '想要人数']) tr.append(el('th', '', label));
        head.append(tr); table.append(head); const body = el('tbody');
        for (const c of activeCards) { const line = el('tr'); for (const value of [card(c.id), row.supply[c.id] || 0, row.demand[c.id] || 0]) line.append(el('td', '', value)); body.append(line); }
        table.append(body); section.append(table);
      }
      sections.append(section);
    }
    content.append(sections);
  }
  function renderTable(state) {
    const items = state.data?.items || [];
    if (!items.length) { content.append(el('div', 'admin-empty', '没有符合条件的记录。')); return; }
    const columns = state.view === 'waiting' ? ['用户 / UID', '区服', '给出 → 想要', '占用给出 / 想要', '状态 / 等待', '详情']
      : state.view === 'matches' ? ['A 方', 'B 方', '交换内容', '状态 / 时间', '详情']
      : state.view === 'users' ? ['用户 / UID', '账号类型 / 区服', '信用 / 完成次数', '注册时间', '详情']
      : ['提交账号', '涉及账号', '类型 / 状态', '原因 / 说明', '详情'];
    const table = el('table', 'admin-table'), head = el('thead'), header = el('tr');
    for (const label of columns) header.append(el('th', '', label)); head.append(header); table.append(head);
    const body = el('tbody');
    for (const item of items) {
      let values;
      if (state.view === 'waiting') values = [userLink(item.accountId, item.uid), server(item.server),
        `给出：${cards(item.give)}\n想要：${cards(item.want)}`, `给出：${cards(item.reservedGive)}\n想要：${cards(item.reservedWant)}`,
        `${STATUS[item.status]}${item.eligible ? ' · 可匹配' : ' · 未参与等待'}\n${item.eligible ? `等待 ${Math.max(0, Math.floor((state.data.updatedAt - item.createdAt) / 60000))} 分钟` : `创建 ${date(item.createdAt)}`}`];
      else if (state.view === 'matches') values = [userLink(item.accountA, item.partnerA.uid), userLink(item.accountB, item.partnerB.uid),
        item.pairs.map(pair => `${card(pair.aGives)} ⇄ ${card(pair.bGives)}`).join('\n'), `${STATUS[item.status]}\n${date(item.createdAt)}\n到期 ${date(item.expiresAt)}`];
      else if (state.view === 'users') values = [userLink(item.id, item.uid), `${accountType(item.accountType)}\n${server(item.server)}`,
        `${item.credit ?? '—'} 分 / ${item.completedCount ?? 0} 次`, date(item.createdAt)];
      else values = [item.reporterAccountId, item.targetAccountId, `${item.kind === 'appeal' ? '申诉' : '举报'} · ${STATUS[item.status]}`, `${item.reason || '—'}\n${item.note || ''}`];
      values.push(button('查看', () => showDetail(item), 'admin-link'));
      const row = el('tr');
      values.forEach((value, i) => { const cell = el('td'); cell.dataset.label = columns[i]; if (value instanceof Node) cell.append(value); else cell.textContent = value; row.append(cell); });
      body.append(row);
    }
    table.append(body); const scroll = el('div', 'admin-table-wrap'); scroll.append(table); content.append(scroll);
  }
  function render(state = controller.state) {
    login.hidden = state.authorized;
    find('.admin-workspace').hidden = !state.authorized;
    passwordInput.disabled = state.loading;
    login.querySelector('button').disabled = state.loading;
    message.textContent = state.error || (state.loading ? '正在读取管理数据…' : '');
    message.classList.toggle('admin-error', !!state.error);
    content.setAttribute('aria-busy', String(state.loading));
    if (!state.authorized) { passwordInput.value = ''; content.replaceChildren(); return; }
    if (state.data) find('.admin-updated').textContent = `最近更新：${date(state.data.updatedAt)}（北京时间）`;
    const tabs = find('.admin-tabs'); tabs.replaceChildren();
    for (const [key, label] of Object.entries(TABS)) {
      const tab = button(label, () => controller.select(key), `admin-tab${state.view === key ? ' is-current' : ''}`);
      tab.setAttribute('aria-pressed', String(state.view === key)); tab.disabled = state.loading; tabs.append(tab);
    }
    const statusSelect = filters.elements.status; statusSelect.replaceChildren();
    const blank = el('option', '', state.view === 'waiting' ? '等待中（含已占满）' : '全部状态'); blank.value = ''; statusSelect.append(blank);
    const choices = state.view === 'waiting' ? ['closed'] : state.view === 'matches' ? ['matched', 'confirming', 'completed', 'failed', 'expired', 'disputed'] : state.view === 'feedback' ? ['pending', 'resolved'] : [];
    for (const value of choices) { const option = el('option', '', STATUS[value]); option.value = value; statusSelect.append(option); }
    for (const key of ['server', 'status', 'accountType', 'search']) {
      filters.elements[key].value = state[key];
      filters.elements[key].disabled = state.loading || state.view === 'overview' && key !== 'server' || key === 'status' && !choices.length;
    }
    filters.querySelector('button').disabled = state.loading;
    const context = find('.admin-context'); context.replaceChildren();
    if (state.accountId) context.append(el('span', 'admin-mono', `当前用户：${state.accountId}`), button('查看全部用户', () => controller.select(state.view), 'admin-link'));
    content.replaceChildren();
    if (state.detail) renderDetail(state);
    else if (state.data && state.view === 'overview') renderOverview(state.data);
    else if (state.data) renderTable(state);
    const pagination = find('.admin-pagination'); pagination.replaceChildren();
    if (!state.detail && state.view !== 'overview' && state.data) {
      const total = state.data.total, pages = Math.max(1, Math.ceil(total / state.pageSize));
      const prev = button('上一页', () => controller.page(state.page - 1)); prev.disabled = state.loading || state.page <= 1;
      const next = button('下一页', () => controller.page(state.page + 1)); next.disabled = state.loading || state.page >= pages;
      pagination.append(el('span', '', `共 ${total} 条 · 第 ${state.page} / ${pages} 页`), prev, next);
    }
  }
  render();
  if (isBili) { find('.admin-close').focus(); controller.load(); }
  else passwordInput.focus();
}
