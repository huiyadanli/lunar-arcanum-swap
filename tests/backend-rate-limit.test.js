import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

let db;
const rateKeys = ['device:shared-device', 'ip:shared-proxy'];
async function call(action, data = {}) {
  const fingerprint = createHash('sha256').update(JSON.stringify({ action, data })).digest('hex');
  const result = await db.query('SELECT public.swap_dispatch($1,$2,$3::jsonb,NULL,$4,$5,$6::text[]) AS data',
    ['rate-limit-test', action, JSON.stringify(data), randomUUID(), fingerprint, rateKeys]);
  return result.rows[0].data;
}

describe('解除设备 / IP 请求限流', { concurrency: false }, () => {
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

  it('已有设备和 IP 计数超过旧阈值仍可写入，不再增加计数', async () => {
    await db.query("INSERT INTO swap_private.rate_limits(bucket,window_start,used) SELECT key,date_trunc('hour',now()),1000000 FROM unnest($1::text[]) key", [rateKeys]);
    const before = (await db.query('SELECT * FROM swap_private.rate_limits ORDER BY bucket')).rows;
    const result = await call('profile', { uid: '812345678', server: 'asia', region: 'asia' });
    assert.equal(result.me.uid, '812345678');
    assert.deepEqual((await db.query('SELECT * FROM swap_private.rate_limits ORDER BY bucket')).rows, before);
  });

  it('共享设备和 IP 连续建立超过 30 个会话，不产生限流记录', async () => {
    await db.query("SELECT public.swap_bili_session(NULL,'test-bili-'||n,'test-credential-'||n,$1::text[]) FROM generate_series(1,100) n", [rateKeys]);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.accounts')).rows[0].count, 100);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM swap_private.rate_limits')).rows[0].count, 0);
  });

  it('兼容旧限流入口的显式阈值调用，不再计数或拦截', async () => {
    await db.query('SELECT swap_private.rate_limit($1::text[],0)', [rateKeys]);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM swap_private.rate_limits')).rows[0].count, 0);
  });

  it('发布冷却与信用处罚继续按业务规则生效', async () => {
    await call('profile', { uid: '812345678', server: 'asia', region: 'asia' });
    await call('publish', { give: { 17: 1 }, want: [1], mode: 'quick', note: null });
    await assert.rejects(call('rematch'), /DAILY_LIMIT/);
    await db.exec("UPDATE public.players SET cooldown_until=now()+interval '1 hour' WHERE account_id='anon:rate-limit-test'");
    await assert.rejects(call('rematch'), /COOLDOWN/);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM swap_private.rate_limits')).rows[0].count, 0);
  });
});
