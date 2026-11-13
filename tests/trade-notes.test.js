import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../backend/server.js';

async function withServer(run) {
  const calls = [];
  const server = createServer({
    config: { gatewayCors: true, corsOrigins: [], envId: 'test-env' },
    service: {
      authenticate: async token => ({ authId: token, accountType: token.startsWith('bili') ? 'bili' : 'anon' }),
      execute: async (...args) => { calls.push(args); return { ok: true }; },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}/api/v1`, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('匿名和 B站身份均不能绕过发布或编辑接口写入自由文本、广告及未知预设', async () => {
  await withServer(async (base, calls) => {
    for (const account of ['anon', 'bili']) {
      for (const method of ['POST', 'PATCH']) {
        for (const note of [
          { text: '普通自定义留言' }, { text: '' }, { text: '访问 https://ad.example' },
          { preset: 'anytime', text: '广告' }, { preset: '08:13–09:27' }, { preset: '__proto__' }, { preset: 'note_trade' },
        ]) {
          const response = await fetch(base + (method === 'POST' ? '/listings' : '/listings/current'), {
            method, headers: { Authorization: `Bearer ${account}-token`, 'Content-Type': 'application/json', 'Idempotency-Key': 'note-test-request' },
            body: JSON.stringify({ give: { 17: 1 }, want: [1], mode: 'quick', version: 1, note }),
          });
          assert.equal(response.status, 422);
          assert.equal((await response.json()).error.code, 'NOTE_REJECTED');
        }
      }
    }
    assert.equal(calls.length, 0);
  });
});
