// 仅用于非 online 构建的独立演示，不读取或写入 mockdb/localStorage。
const timestamp = Date.UTC(2026, 10, 14, 12);
const users = [
  { id: 'demo-anon-a', accountType: 'anon', uid: '812345678', server: 'asia', credit: 100, completedCount: 2 },
  { id: 'demo-bili-b', accountType: 'bili', uid: '898765432', server: 'asia', credit: 106, completedCount: 5 },
  { id: 'demo-anon-c', accountType: 'anon', uid: '598765432', server: 'irminsul', credit: 94, completedCount: 1 },
].map(user => ({ ...user, createdAt: timestamp - 86400000, failStreak: 0, cooldownUntil: null, quotaResetAt: null }));
const waiting = [
  { id: '00000000-0000-4000-8000-000000000001', accountId: users[0].id, accountType: 'anon', uid: users[0].uid,
    server: 'asia', status: 'waiting', give: { 17: 1 }, want: [2], reservedGive: { 17: 1 }, reservedWant: [1],
    mode: 'quick', note: { preset: 'anytime' }, version: 2, eligible: true, credit: 100, createdAt: timestamp - 7200000, updatedAt: timestamp },
  { id: '00000000-0000-4000-8000-000000000002', accountId: users[2].id, accountType: 'anon', uid: users[2].uid,
    server: 'irminsul', status: 'waiting', give: { 3: 1 }, want: [4], reservedGive: {}, reservedWant: [],
    mode: 'box', note: null, version: 1, eligible: true, credit: 94, createdAt: timestamp - 3600000, updatedAt: timestamp },
];
const matches = [{ id: '00000000-0000-4000-8000-000000000003', accountA: users[0].id, accountB: users[1].id,
  accountTypeA: 'anon', accountTypeB: 'bili', partnerA: { uid: users[0].uid, server: 'asia', note: { preset: 'anytime' } },
  partnerB: { uid: users[1].uid, server: 'asia', note: null }, listingA: waiting[0].id,
  listingB: '00000000-0000-4000-8000-000000000004', pairs: [{ aGives: 17, bGives: 1 }], status: 'confirming',
  scannedBy: users[1].id, confirmA: { result: 'completed', completedPairs: [0] }, confirmB: null,
  revealedAtA: timestamp, revealedAtB: timestamp, createdAt: timestamp, expiresAt: Date.now() + 600000, settledAt: null }];
const feedback = [{ id: '00000000-0000-4000-8000-000000000005', reporterAccountId: users[0].id, targetAccountId: users[1].id,
  matchId: matches[0].id, kind: 'report', reason: 'no_response', note: '演示反馈内容', status: 'pending', createdAt: timestamp }];

/** 与线上管理接口形状一致，演示查询只返回克隆，不改变个人数据。 */
export function createMockAdminQuery(accountType) {
  return async query => {
    if (accountType !== 'bili' && query.password !== 'dev-admin') throw Object.assign(new Error('ADMIN_FORBIDDEN'), { code: 'ADMIN_FORBIDDEN', status: 403 });
    const updatedAt = Date.now();
    if (query.view === 'overview') {
      const servers = ['celestia', 'irminsul', 'asia', 'america', 'europe', 'tw'].filter(s => !query.server || query.server === s);
      const listings = waiting.filter(l => !query.server || query.server === l.server);
      const active = matches.filter(m => !query.server || query.server === m.partnerA.server);
      const participants = new Set([...listings.map(l => l.accountId), ...active.flatMap(m => [m.accountA, m.accountB])]);
      return { poolUsers: participants.size, waitingUsers: listings.length, activeUsers: new Set(active.flatMap(m => [m.accountA, m.accountB])).size,
        activeMatches: active.length, confirming: active.length, overdueMatches: 0,
        registeredUsers: users.filter(u => !query.server || query.server === u.server).length, statuses: { confirming: active.length }, updatedAt,
        servers: servers.map(server => {
          const rows = listings.filter(l => l.server === server), supply = {}, demand = {};
          for (const row of rows) { for (const [id, n] of Object.entries(row.give)) supply[id] = (supply[id] || 0) + n; for (const id of row.want) demand[id] = (demand[id] || 0) + 1; }
          return { server, waiting: rows.length, supply, demand };
        }) };
    }
    const dataset = { waiting, matches, users, feedback }[query.view] || [];
    const items = dataset.filter(row => {
      const ids = [row.id, row.accountId, row.accountA, row.accountB, row.reporterAccountId, row.targetAccountId];
      const uids = [row.uid, row.partnerA?.uid, row.partnerB?.uid];
      const rowServer = row.server || row.partnerA?.server || 'asia';
      return (!query.server || query.server === rowServer) && (!query.status || query.status === row.status)
        && (!query.accountId || ids.includes(query.accountId)) && (!query.id || row.id === query.id)
        && (!query.accountType || [row.accountType, row.accountTypeA, row.accountTypeB,
          ...users.filter(user => [row.reporterAccountId, row.targetAccountId].includes(user.id)).map(user => user.accountType)].includes(query.accountType))
        && (!query.search || [...ids, ...uids].some(id => id?.includes(query.search)));
    });
    const page = query.page || 1, pageSize = query.pageSize || 50;
    return structuredClone({ items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize, updatedAt });
  };
}
