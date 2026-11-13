// 只返回维护任务数量、下一次到期时间与是否访问数据库，不输出凭据或内部对象路径。
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { maintenanceSignature } from '../backend/maintenance-scheduler.js';

const action = process.argv.includes('--run') ? 'run' : process.argv.includes('--tick') ? 'tick' : 'inspect';
const env = JSON.parse(readFileSync(new URL('../.secrets/backend.runtime.json', import.meta.url), 'utf8'));
const issuedAt = Date.now();
const nonce = randomUUID();
const response = await fetch(`https://${env.TCB_ENV}.api.tcloudbasegateway.com/v1/functions/swap-maintenance`, {
  method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDBASE_APIKEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action, issuedAt, nonce, signature: maintenanceSignature(env.SWAP_HMAC_SECRET, action, nonce, issuedAt) }),
  signal: AbortSignal.timeout(25000),
});
const result = await response.json();
if (!response.ok || typeof result.databaseAccessed !== 'boolean') throw new Error(`MAINTENANCE_CHECK_FAILED:${response.status}`);
console.log(JSON.stringify(result, null, 2));
