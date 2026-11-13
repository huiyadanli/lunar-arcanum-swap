// 发布配置仅写入 .secrets；凭据直接读取文件，不经过命令行参数或日志转写。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const runtime = JSON.parse(await readFile(new URL('.secrets/backend.runtime.json', root), 'utf8'));
const keyIndex = process.argv.indexOf('--key-file');
if (keyIndex >= 0) {
  const original = JSON.parse(await readFile(process.argv[keyIndex + 1], 'utf8'));
  if (original.env_id !== runtime.TCB_ENV) throw new Error('私钥所属环境与发布环境不一致');
  runtime.SWAP_CUSTOM_LOGIN_KEY = JSON.stringify(original);
  await writeFile(new URL('.secrets/backend.runtime.json', root), JSON.stringify(runtime, null, 2) + '\n');
}
const manifest = JSON.parse(await readFile(new URL('cloudbaserc.json', root), 'utf8'));
if (manifest.envId !== runtime.TCB_ENV) throw new Error('发布配置所属环境不一致');
manifest.functionRoot = fileURLToPath(new URL('cloudfunctions/', root));
// CLI 会解析 JSON 形态的配置字符串；PEM 与 key ID 分开注入，保证云函数环境变量仍为字符串。
const signingKey = JSON.parse(runtime.SWAP_CUSTOM_LOGIN_KEY);
const apiRuntime = { ...runtime, SWAP_CUSTOM_LOGIN_PRIVATE_KEY: signingKey.private_key,
  SWAP_CUSTOM_LOGIN_KEY_ID: signingKey.private_key_id, SWAP_GATEWAY_CORS: 'enabled', SWAP_TRUST_PROXY: 'enabled' };
delete apiRuntime.SWAP_CUSTOM_LOGIN_KEY;
manifest.functions = manifest.functions.map(func => ({ ...func, installDependency: false,
  envVariables: func.name === 'swap-api' ? apiRuntime : {
    TCB_ENV: runtime.TCB_ENV, CLOUDBASE_APIKEY: runtime.CLOUDBASE_APIKEY, SWAP_HMAC_SECRET: runtime.SWAP_HMAC_SECRET,
  },
}));
await mkdir(new URL('.secrets/', root), { recursive: true });
await writeFile(new URL('.secrets/cloudbaserc.deploy.json', root), JSON.stringify(manifest, null, 2) + '\n');
const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
console.log(JSON.stringify({ envId: runtime.TCB_ENV, functions: manifest.functions.map(func => func.name),
  config: '.secrets/cloudbaserc.deploy.json',
  fingerprints: { serverKey: fingerprint(runtime.CLOUDBASE_APIKEY), customKey: fingerprint(JSON.parse(runtime.SWAP_CUSTOM_LOGIN_KEY).private_key) } }));
