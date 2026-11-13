import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

let db;
const uid = '812345678';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function call(actor, action, data = {}, key = randomUUID(), customId = null) {
  const result = await db.query('SELECT public.swap_dispatch($1,$2,$3::jsonb,$4,$5,$6,$7::text[]) AS data',
    [actor, action, JSON.stringify(data), customId, key, hash({ action, data }), []]);
  return result.rows[0].data;
}
const state = actor => call(actor, 'state');
const bind = (actor, gameUid = uid, server = 'asia', region = 'asia') => call(actor, 'profile', { uid: gameUid, server, region });
const publish = (actor, give, want, key) => call(actor, 'publish', { give, want, mode: 'quick', note: null }, key);
async function matchTwo({ give = { 17: 1 }, want = [1], partnerGive = { 1: 1 }, partnerWant = [17] } = {}) {
  await bind('alice'); await bind('bob');
  await publish('alice', give, want);
  const result = await publish('bob', partnerGive, partnerWant);
  return result.matches[0].id;
}
const confirm = (actor, id, confirmation) => call(actor, 'confirm', { matchId: id, ...confirmation });
async function scalar(sql, args = []) { return (await db.query(sql, args)).rows[0]; }

describe('PostgreSQL 真实事务与业务约束', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite();
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    const folder = new URL('../cloudbase/migrations/', import.meta.url);
    for (const name of (await readdir(folder)).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(name, folder), 'utf8'));
    }
  });
  beforeEach(async () => { await db.exec('TRUNCATE public.accounts CASCADE; TRUNCATE swap_private.rate_limits;'); });
  after(async () => { await db?.close(); });

  it('允许两个账号填写同一 UID，分别发布且直接正常匹配，不泄露 UID 或账号类型', async () => {
    const id = await matchTwo();
    const alice = await state('alice');
    const bob = await state('bob');
    assert.equal(alice.me.uid, bob.me.uid);
    assert.notEqual(alice.me.accountId, bob.me.accountId);
    assert.equal(alice.matches[0].id, id);
    assert.deepEqual(alice.matches[0].pairs, [{ give: 17, get: 1 }]);
    assert.equal(alice.matches[0].partner.uid, undefined);
    assert.equal(alice.matches[0].partner.accountType, undefined);
    assert.equal(alice.quota.left, 0);
    assert.equal(bob.quota.left, 0);
    assert.equal(Object.hasOwn(alice.me, 'duplicateUid'), false);
  });

  it('主动扫描累计最多 3 对，正确占用双方供给和想要名额', async () => {
    await matchTwo({ give: { 17: 1, 18: 1, 19: 1, 20: 1 }, want: [1, 2, 3, 4],
      partnerGive: { 1: 1, 2: 1, 3: 1, 4: 1 }, partnerWant: [17, 18, 19, 20] });
    const alice = await state('alice');
    assert.equal(alice.matches[0].pairs.length, 3);
    assert.equal(alice.listing.want.length, 1);
    assert.equal(alice.listing.reservedWant.length, 3);
    assert.equal(Object.values(alice.listing.reservedGive).reduce((a, b) => a + b, 0), 3);
  });

  it('被动方可被多个账号匹配超过 3 对，已占用的想要名额不会重复分配', async () => {
    await bind('alice'); await publish('alice', { 17: 4 }, [1, 2, 3, 4]);
    for (let i = 1; i <= 4; i++) {
      await bind(`partner${i}`);
      assert.equal((await publish(`partner${i}`, { [i]: 1 }, [17])).matches.length, 1);
    }
    await bind('late');
    assert.equal((await publish('late', { 1: 1 }, [17])).matches.length, 0);
    assert.equal((await state('alice')).matches.length, 4);
    assert.deepEqual((await state('alice')).listing.give, {});
  });

  it('请求幂等按账号隔离，重复重试不重复发布、扣额度，改内容复用键被拒绝', async () => {
    await bind('alice'); await bind('bob');
    const key = randomUUID();
    const first = await publish('alice', { 17: 1 }, [1], key);
    assert.deepEqual(await publish('alice', { 17: 1 }, [1], key), first);
    await assert.rejects(publish('alice', { 18: 1 }, [1], key), /IDEMPOTENCY_CONFLICT/);
    await publish('bob', { 18: 1 }, [2], key);
    assert.equal((await scalar('SELECT count(*)::int AS count FROM public.listings')).count, 2);
    await assert.rejects(call('alice', 'rematch'), /DAILY_LIMIT/);
  });

  it('账号配额独立；修改相同服务器 UID 不能清空已用次数', async () => {
    await bind('alice');
    await publish('alice', { 17: 1 }, [1]); await call('alice', 'withdraw');
    await bind('alice', '812345679');
    assert.equal((await state('alice')).quota.left, 0);
    await bind('bob'); assert.equal((await state('bob')).quota.left, 1);
    await db.exec("UPDATE public.players SET quota_reset_at=now()-interval '1 second' WHERE account_id='anon:alice'");
    assert.equal((await state('alice')).quota.left, 1);
  });

  it('同 UID 的第三方没有查看、确认或举报别人匹配的权限', async () => {
    const id = await matchTwo(); await bind('outsider');
    await assert.rejects(call('outsider', 'reveal', { matchId: id }), /NOT_FOUND/);
    await assert.rejects(confirm('outsider', id, { result: 'completed', completedPairs: [0] }), /NOT_FOUND/);
    await assert.rejects(call('outsider', 'feedback', { matchId: id, kind: 'report', reason: 'fake_uid' }), /NOT_FOUND/);
    assert.equal((await state('outsider')).matches.length, 0);
  });

  it('UID 只向自己已 reveal 的有效匹配展示，结束后即使重放原请求也不泄露', async () => {
    const id = await matchTwo(); const key = randomUUID();
    assert.equal((await call('alice', 'reveal', { matchId: id }, key)).uid, uid);
    assert.equal((await state('alice')).matches[0].partner.uid, uid);
    assert.equal((await state('bob')).matches[0].partner.uid, undefined);
    await confirm('alice', id, { result: 'completed', completedPairs: [0] });
    await confirm('bob', id, { result: 'completed', completedPairs: [0] });
    assert.equal((await state('alice')).history[0].partner.uid, undefined);
    assert.equal((await call('alice', 'state', { historyCursor: null })).history.length, 1);
    await assert.rejects(call('alice', 'reveal', { matchId: id }, key), /MATCH_CLOSED/);
    assert.equal((await state('alice')).me.completedCount, 1);
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:alice'")).credit, 106);
    assert.equal((await state('alice')).listing, null);
    assert.deepEqual((await scalar("SELECT reserved_give FROM public.listings WHERE account_id='anon:alice'")).reserved_give, {});
  });

  it('部分完成必须双方同意；本轮需求结束，未完成部分不自动重新匹配', async () => {
    const id = await matchTwo({ give: { 17: 1, 18: 1 }, want: [1, 2], partnerGive: { 1: 1, 2: 1 }, partnerWant: [17, 18] });
    await confirm('alice', id, { result: 'completed', completedPairs: [0] });
    assert.equal((await state('alice')).listing, null);
    assert.equal((await scalar("SELECT cardinality(reserved_want) AS count FROM public.listings WHERE account_id='anon:alice'")).count, 2);
    await confirm('bob', id, { result: 'completed', completedPairs: [0] });
    const alice = await state('alice');
    assert.equal(alice.listing, null);
    const listing = await scalar("SELECT status,give,want,reserved_give FROM public.listings WHERE account_id='anon:alice'");
    assert.equal(listing.status, 'closed');
    assert.deepEqual(listing.give, {});
    assert.deepEqual(listing.want, []);
    assert.deepEqual(listing.reserved_give, {});
  });

  it('一张给出、多张想要：单方确认即结束双方需求，未 reveal 的对方仍可查看并确认', async () => {
    const id = await matchTwo({ want: [1, 2] });
    await call('alice', 'reveal', { matchId: id });
    await confirm('alice', id, { result: 'completed', completedPairs: [0] });
    const alice = await state('alice');
    const bob = await state('bob');
    assert.equal(alice.listing, null);
    assert.equal(bob.listing, null);
    assert.equal(bob.matches[0].status, 'confirming');
    assert.equal(bob.matches[0].myConfirm, null);
    assert.equal(bob.matches[0].partnerConfirm.result, 'completed');
    assert.equal(bob.matches[0].partner.uid, undefined);
    assert.equal(alice.me.completedCount, 0);
    assert.deepEqual((await scalar("SELECT reserved_give FROM public.listings WHERE account_id='anon:alice'")).reserved_give, { 17: 1 });
    assert.equal((await call('bob', 'reveal', { matchId: id })).uid, uid);
    assert.equal((await confirm('bob', id, { result: 'completed' })).outcome, 'completed');
    assert.equal((await state('alice')).me.completedCount, 1);
  });

  it('剩余牌不自动匹配；单方确认不恢复次数，双方成功后可立即重新发布', async () => {
    const id = await matchTwo({ give: { 17: 2 }, want: [1, 2] });
    await confirm('alice', id, { result: 'completed' });
    await bind('carol');
    assert.equal((await publish('carol', { 2: 1 }, [17])).matches.length, 0);
    assert.equal((await state('alice')).quota.left, 0);
    assert.equal((await state('bob')).quota.left, 0);
    await assert.rejects(publish('alice', { 17: 1 }, [2]), /DAILY_LIMIT/);
    await confirm('bob', id, { result: 'completed' });
    assert.equal((await state('alice')).quota.left, 1);
    assert.equal((await state('bob')).quota.left, 1);
    const next = await publish('alice', { 17: 1 }, [2]);
    assert.equal(next.matches.length, 1);
    assert.notEqual(next.matches[0].id, id);
    await confirm('alice', next.matches[0].id, { result: 'completed' });
    await confirm('carol', next.matches[0].id, { result: 'completed' });
    assert.equal((await state('alice')).quota.left, 1);
    assert.equal((await state('carol')).quota.left, 1);
    await publish('alice', { 17: 1 }, [3]);
    await assert.rejects(call('alice', 'rematch'), /DAILY_LIMIT/);
  });

  it('成功奖励只发放一次：重复确认及重复结算不清除下一轮已消耗的冷却', async () => {
    const id = await matchTwo();
    await confirm('alice', id, { result: 'completed' });
    await confirm('bob', id, { result: 'completed' });
    await publish('alice', { 18: 1 }, [2]);
    await confirm('alice', id, { result: 'completed' });
    await scalar("SELECT swap_private.settle($1,'completed',ARRAY[0],6,6,false,false,1,1)", [id]);
    assert.equal((await state('alice')).quota.left, 0);
    assert.equal((await state('bob')).quota.left, 1);
    assert.equal((await state('alice')).me.completedCount, 1);
  });

  it('双方选择不同的完成牌进入争议，不恢复任一方次数', async () => {
    const id = await matchTwo({ give: { 17: 1, 18: 1 }, want: [1, 2], partnerGive: { 1: 1, 2: 1 }, partnerWant: [17, 18] });
    await confirm('alice', id, { result: 'completed', completedPairs: [0] });
    await confirm('bob', id, { result: 'completed', completedPairs: [1] });
    assert.equal((await state('alice')).history[0].status, 'disputed');
    assert.equal((await state('alice')).quota.left, 0);
    assert.equal((await state('bob')).quota.left, 0);
  });

  it('关闭需求保留其他已有匹配；后续完成或失败都不会重新激活本轮需求', async () => {
    const first = await matchTwo({ give: { 17: 2 }, want: [1, 2] });
    await bind('carol');
    const second = (await publish('carol', { 2: 1 }, [17])).matches[0].id;
    await confirm('alice', first, { result: 'completed' });
    assert.equal((await state('alice')).matches.length, 2);
    await confirm('bob', first, { result: 'completed' });
    await assert.rejects(publish('alice', { 18: 1 }, [3]), /ACTIVE_EXCHANGE/);
    await confirm('carol', second, { result: 'failed', reason: 'self' });
    assert.equal((await state('alice')).listing, null);
    assert.deepEqual((await scalar("SELECT reserved_give FROM public.listings WHERE account_id='anon:alice'")).reserved_give, {});
  });

  it('编辑使用版本号；被占用的想要名额不能覆盖，失败事务不留下部分改动', async () => {
    const id = await matchTwo();
    const current = (await state('alice')).listing;
    await assert.rejects(call('alice', 'edit', { give: { 18: 1 }, want: [2], note: null, version: current.version - 1 }), /VERSION_CONFLICT/);
    await assert.rejects(call('alice', 'edit', { give: { 18: 1 }, want: [1], note: null, version: current.version }), /CARDS_LOCKED/);
    const edited = await call('alice', 'edit', { give: { 18: 1 }, want: [2], note: null, version: current.version });
    assert.equal(edited.listing.reservedWant.length, 1);
    await confirm('bob', id, { result: 'failed', reason: 'self' });
    assert.deepEqual((await state('alice')).listing.give, { 17: 1, 18: 1 });
  });

  it('撤回后已有匹配继续有效，失败释放不会重新激活已撤回需求', async () => {
    const id = await matchTwo(); await call('alice', 'withdraw');
    assert.equal((await state('alice')).listing, null);
    await confirm('bob', id, { result: 'failed', reason: 'self' });
    assert.equal((await state('alice')).listing, null);
    const listing = await scalar("SELECT reserved_give, give, status FROM public.listings WHERE account_id='anon:alice'");
    assert.deepEqual(listing.reserved_give, {});
    assert.deepEqual(listing.give, {});
    assert.equal(listing.status, 'closed');
  });

  it('失败只影响责任账号；相同 UID 的其他账号不被扣分或屏蔽', async () => {
    const id = await matchTwo(); await bind('outsider');
    await confirm('alice', id, { result: 'failed', reason: 'no_card' });
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:bob'")).credit, 90);
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:outsider'")).credit, 100);
    assert.equal((await scalar('SELECT count(*)::int AS count FROM public.pair_blocks')).count, 1);
    await publish('outsider', { 1: 1 }, [17]);
    assert.equal((await state('alice')).matches.length, 1);
  });

  it('失败申诉冲正原扣分；同一次结算反复执行不重复释放或加分', async () => {
    const id = await matchTwo();
    await confirm('alice', id, { result: 'failed', reason: 'no_card' });
    const data = { matchId: id, kind: 'appeal', note: '已经完成' };
    await call('bob', 'feedback', data); await call('bob', 'feedback', data);
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:bob'")).credit, 100);
    assert.deepEqual((await state('alice')).listing.give, { 17: 1 });
    assert.equal((await state('alice')).history[0].status, 'disputed');
    assert.equal((await scalar('SELECT count(*)::int AS count FROM public.feedback')).count, 1);
  });

  it('首次确认启动双方共享的 10 分钟期限，重复确认不延长，期限内不自动结算', async () => {
    const id = await matchTwo();
    const original = (await state('alice')).matches[0];
    assert.equal(original.expiresAt - original.createdAt, 48 * 3600e3);
    await confirm('alice', id, { result: 'completed' });
    const first = (await state('alice')).matches[0];
    assert.ok(Math.abs(first.expiresAt - first.myConfirm.at - 10 * 60e3) <= 1);
    assert.equal((await state('bob')).matches[0].expiresAt, first.expiresAt);
    await confirm('alice', id, { result: 'completed' });
    assert.equal((await state('alice')).matches[0].expiresAt, first.expiresAt);
    assert.equal((await scalar('SELECT public.swap_maintenance() AS data')).data.processed, 0);
    assert.equal((await state('bob')).matches[0].status, 'confirming');
    assert.equal((await state('alice')).quota.left, 0);
    assert.equal((await state('bob')).quota.left, 0);
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:alice'")).credit, 100);
  });

  it('首次确认临近原有效期时仍给予完整的 10 分钟，双方主动完成各加 6 分', async () => {
    const id = await matchTwo();
    await db.query("UPDATE public.matches SET expires_at=now()+interval '1 second' WHERE id=$1", [id]);
    const first = (await confirm('bob', id, { result: 'completed' })).match;
    assert.ok(Math.abs(first.expiresAt - first.myConfirm.at - 10 * 60e3) <= 1);
    await confirm('alice', id, { result: 'completed' });
    await confirm('bob', id, { result: 'completed' });
    for (const actor of ['alice', 'bob']) {
      assert.equal((await scalar('SELECT credit FROM public.players WHERE account_id=$1', [`anon:${actor}`])).credit, 106);
      assert.equal((await state(actor)).me.completedCount, 1);
    }
  });

  it('升级迁移按已有首次确认时间调整期限，历史已结算的奖励保持不变', async () => {
    const finished = await matchTwo();
    await confirm('alice', finished, { result: 'completed' });
    await confirm('bob', finished, { result: 'completed' });
    await scalar("SELECT swap_private.settle($1,'completed',ARRAY[0],2,2,false,false,1,1)", [finished]);
    await bind('carol'); await bind('dave');
    await publish('carol', { 18: 1 }, [2]);
    const waiting = (await publish('dave', { 2: 1 }, [18])).matches[0].id;
    await confirm('carol', waiting, { result: 'completed' });
    const at = (await state('carol')).matches[0].myConfirm.at;
    await db.query("UPDATE public.matches SET expires_at=now()+interval '48 hours' WHERE id=$1", [waiting]);
    await db.exec(await readFile(new URL('../cloudbase/migrations/20261114030000_ten_minute_confirmation.sql', import.meta.url), 'utf8'));
    assert.ok(Math.abs((await state('carol')).matches[0].expiresAt - at - 10 * 60e3) <= 1);
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:alice'")).credit, 102);
    // 本用例回放旧迁移后恢复当前实现，避免影响后续业务用例。
    await db.exec(await readFile(new URL('../cloudbase/migrations/20261114040000_idle_maintenance.sql', import.meta.url), 'utf8'));
  });

  it('自动完成恢复双方次数，重复维护不重复奖励；主动加 6 分、自动加 2 分且 UID 隐藏', async () => {
    const id = await matchTwo();
    await confirm('alice', id, { result: 'completed', completedPairs: [0] });
    await db.query("UPDATE public.matches SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    await assert.rejects(call('bob', 'reveal', { matchId: id }), /MATCH_CLOSED/);
    assert.equal((await scalar('SELECT public.swap_maintenance() AS data')).data.processed, 1);
    assert.equal((await scalar('SELECT public.swap_maintenance() AS data')).data.processed, 0);
    assert.equal((await state('alice')).history[0].status, 'completed');
    assert.equal((await state('bob')).me.completedCount, 1);
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:alice'")).credit, 106);
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:bob'")).credit, 102);
    await assert.rejects(confirm('bob', id, { result: 'completed' }), /MATCH_CLOSED/);
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:bob'")).credit, 102);
    assert.equal((await state('alice')).quota.left, 1);
    assert.equal((await state('bob')).quota.left, 1);
    await publish('alice', { 18: 1 }, [2]);
    await publish('bob', { 19: 1 }, [3]);
    assert.equal((await scalar('SELECT public.swap_maintenance() AS data')).data.processed, 0);
    await confirm('alice', id, { result: 'completed', completedPairs: [0] });
    await scalar("SELECT swap_private.settle($1,'completed',ARRAY[0],6,2,false,false,1,1)", [id]);
    for (const actor of ['alice', 'bob']) {
      assert.equal((await state(actor)).quota.left, 0);
      assert.equal((await state(actor)).me.completedCount, 1);
    }
  });

  it('交换双方颠倒仍按主动和自动确认分别加 6 / 2 分，超时后不能抢先补交取得主动奖励', async () => {
    const id = await matchTwo({ give: { 17: 1, 18: 1 }, want: [1, 2], partnerGive: { 1: 1, 2: 1 }, partnerWant: [17, 18] });
    await confirm('bob', id, { result: 'completed', completedPairs: [0] });
    await db.query('UPDATE public.matches SET expires_at=now() WHERE id=$1', [id]);
    await assert.rejects(confirm('alice', id, { result: 'completed', completedPairs: [0] }), /MATCH_CLOSED/);
    assert.equal((await scalar('SELECT public.swap_maintenance() AS data')).data.processed, 1);
    assert.equal((await scalar('SELECT public.swap_maintenance() AS data')).data.processed, 0);
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:bob'")).credit, 106);
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:alice'")).credit, 102);
    for (const actor of ['alice', 'bob']) {
      assert.equal((await state(actor)).me.completedCount, 1);
      assert.equal((await state(actor)).quota.left, 1);
      assert.deepEqual((await scalar('SELECT reserved_give FROM public.listings WHERE account_id=$1', [`anon:${actor}`])).reserved_give, {});
    }
  });

  it('双方未操作则超时释放占用并扣分，JSON 响应不包含内部账号、凭据或流水', async () => {
    const id = await matchTwo();
    await db.query("UPDATE public.matches SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    await scalar('SELECT public.swap_maintenance() AS data');
    const alice = await state('alice');
    assert.equal(alice.history[0].status, 'expired');
    assert.equal(alice.quota.left, 0);
    assert.equal((await state('bob')).quota.left, 0);
    assert.deepEqual(alice.listing.give, { 17: 1 });
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:alice'")).credit, 95);
    assert.doesNotMatch(JSON.stringify(alice), /credential_hash|auth_user_id|anon:bob|credit_events/);
  });

  it('业务表和内部 RPC 对 PUBLIC 默认禁止，不依赖前端隐藏操作', async () => {
    const rows = await db.query("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('accounts','players','listings','matches','pair_blocks','feedback','request_records')");
    assert.equal(rows.rows.length, 7);
    assert.ok(rows.rows.every(row => row.relrowsecurity));
    assert.equal((await scalar("SELECT has_function_privilege('authenticated','public.swap_dispatch(text,text,jsonb,text,text,text,text[])','EXECUTE') AS allowed")).allowed, false);
    assert.equal((await scalar("SELECT has_function_privilege('service_role','public.swap_dispatch(text,text,jsonb,text,text,text,text[])','EXECUTE') AS allowed")).allowed, true);
    assert.equal((await scalar("SELECT has_table_privilege('authenticated','public.matches','SELECT') AS allowed")).allowed, false);
    // 同时检查未向 PUBLIC 授予 EXECUTE。
    const acl = await scalar("SELECT proacl::text AS acl FROM pg_proc WHERE proname='swap_dispatch'");
    assert.doesNotMatch(acl.acl, /(?:\{|,)=X/);
  });

  it('省略完成索引时默认全部完成；一致的失败陈述保持原结算', async () => {
    const id = await matchTwo();
    await confirm('alice', id, { result: 'failed', reason: 'no_card' });
    await confirm('bob', id, { result: 'failed', reason: 'self' });
    assert.equal((await state('alice')).history[0].status, 'failed');
    assert.equal((await scalar("SELECT credit FROM public.players WHERE account_id='anon:bob'")).credit, 90);
    await bind('c'); await bind('d');
    await publish('c', { 18: 1 }, [2]);
    const match = (await publish('d', { 2: 1 }, [18])).matches[0].id;
    await confirm('c', match, { result: 'completed' });
    await confirm('d', match, { result: 'completed' });
    assert.equal((await state('c')).me.completedCount, 1);
  });

  it('历史分页保留微秒精度，不重复或漏掉相邻记录，冷却账号从供需统计排除', async () => {
    await bind('alice');
    const cards = Array.from({ length: 22 }, (_, i) => i + 1).filter(i => i !== 17);
    await publish('alice', { 17: 21 }, cards);
    for (const card of cards) { await bind(`p${card}`); await publish(`p${card}`, { [card]: 1 }, [17]); }
    await db.exec("UPDATE public.matches SET expires_at=now()-interval '1 second',created_at='2026-11-13T01:00:00.000400Z'::timestamptz + ((get_byte(uuid_send(id),0)::text)||' microseconds')::interval;");
    await scalar('SELECT public.swap_maintenance() AS data');
    const first = await state('alice');
    assert.equal(first.history.length, 20);
    assert.equal(typeof first.nextHistoryCursor.at, 'string');
    const next = await call('alice', 'state', { historyCursor: first.nextHistoryCursor });
    assert.equal(next.history.length, 1);
    assert.equal(next.nextHistoryCursor, null);
    assert.equal(new Set([...first.history, ...next.history].map(m => m.id)).size, 21);
    assert.ok(first.me.cooldownUntil > Date.now());
    assert.equal(first.stats.waiting, 21);
  });

  it('轻量轮询省略历史和全池统计，仍返回本人当前交换、额度和完成数', async () => {
    const id = await matchTwo();
    const light = await call('alice', 'state', { light: true });
    assert.equal(light.matches[0].id, id);
    assert.equal(light.history, null);
    assert.equal(light.stats, null);
    assert.equal(light.quota.left, 0);
    assert.equal((await state('alice')).stats.waiting, 0);
  });

  it('过期维护租约拒绝业务写入，下一次到期时间包含交换和信用恢复', async () => {
    await bind('alice');
    await assert.rejects(call('alice', 'publish', { give: { 17: 1 }, want: [1], mode: 'quick',
      _maintenanceLeaseUntil: Date.now() - 1 }), /MAINTENANCE_LEASE_EXPIRED/);
    assert.equal((await state('alice')).listing, null);
    assert.equal((await state('alice')).quota.left, 1);
    const id = await matchTwo();
    await confirm('alice', id, { result: 'completed' });
    const deadline = (await state('alice')).matches[0].expiresAt;
    assert.equal((await scalar('SELECT public.swap_maintenance() AS data')).data.nextDueAt, deadline);
    await db.query('UPDATE public.matches SET expires_at=now() WHERE id=$1', [id]);
    const complete = (await scalar('SELECT public.swap_maintenance() AS data')).data;
    assert.equal(complete.processed, 1);
    assert.ok(complete.nextDueAt > Date.now());
  });
});
