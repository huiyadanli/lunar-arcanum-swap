import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

test('跨服修复撤销错误处罚和冷却，保留正常同服处罚，重复执行不重复返还', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    const init = await readFile(new URL('../cloudbase/migrations/20261115010000_init_swap.sql', import.meta.url), 'utf8');
    await db.exec(init);
    // 只在测试库还原旧扫描条件，构造线上历史错误数据。
    const start = init.indexOf('CREATE FUNCTION swap_private.scan(');
    const end = init.indexOf('END $$;', start) + 'END $$;'.length;
    await db.exec(init.slice(start, end).replace('CREATE FUNCTION ', 'CREATE OR REPLACE FUNCTION ')
      .replace(' AND l.server=a.server', ''));
    const call = async (actor, action, data = {}) => (await db.query(
      'SELECT public.swap_dispatch($1,$2,$3::jsonb,NULL,$4,$5,$6::text[]) AS data',
      [actor, action, JSON.stringify(data), randomUUID(), createHash('sha256').update(JSON.stringify({ action, data })).digest('hex'), []],
    )).rows[0].data;
    const bind = (actor, uid, server) => call(actor, 'profile', { uid, server, region: 'cn' });
    const publish = (actor, give, want) => call(actor, 'publish', { give, want, mode: 'quick', note: null });
    const fail = (actor, matchId) => call(actor, 'confirm', { matchId, result: 'failed', reason: 'no_friend' });
    await bind('target', '598765432', 'irminsul');
    await bind('normal', '598765433', 'irminsul');
    await publish('target', { 17: 1 }, [1, 2, 3]);
    const normalMatch = (await publish('normal', { 1: 1 }, [17])).matches[0].id;
    await fail('normal', normalMatch);
    const wrongMatches = [];
    for (let i = 2; i <= 3; i++) {
      const actor = `wrong-${i}`;
      await bind(actor, `19876543${i}`, 'celestia');
      const id = (await publish(actor, { [i]: 1 }, [17])).matches[0].id;
      wrongMatches.push(id);
      await fail(actor, id);
    }
    const row = async () => (await db.query("SELECT to_jsonb(p) AS data FROM public.players p WHERE account_id='anon:target'")).rows[0].data;
    const old = await row();
    assert.equal(old.credit, 55);
    assert.equal(old.fail_streak, 3);
    assert.ok(old.cooldown_until);
    const repair = await readFile(new URL('../scripts/repair-cn-server-matches.sql', import.meta.url), 'utf8');
    await db.exec(repair);
    const repaired = await row();
    assert.equal(repaired.credit, 85);
    assert.equal(repaired.fail_streak, 1);
    assert.equal(repaired.cooldown_until, null);
    assert.equal(repaired.quota_reset_at, null);
    assert.equal(repaired.region, 'cn_bili');
    assert.equal((await db.query('SELECT status FROM public.matches WHERE id=$1', [normalMatch])).rows[0].status, 'failed');
    for (const id of wrongMatches) {
      assert.equal((await db.query('SELECT status FROM public.matches WHERE id=$1', [id])).rows[0].status, 'disputed');
    }
    const listing = async () => (await db.query("SELECT to_jsonb(l) AS data FROM public.listings l WHERE account_id='anon:target'")).rows[0].data;
    const restored = await listing();
    assert.equal(restored.status, 'waiting');
    assert.deepEqual(restored.give, { 17: 1 });
    assert.deepEqual(restored.reserved_give, {});
    assert.deepEqual([...restored.want].sort(), [1, 2, 3]);
    await db.exec(repair);
    assert.deepEqual(await row(), repaired);
    assert.deepEqual(await listing(), restored);
  } finally { await db.close(); }
});
