import { readFile } from 'node:fs/promises';
import { createServer } from './server.js';
import { createCloudBaseService, loadConfig } from './cloudbase.js';

const runtime = JSON.parse(await readFile(new URL('../.secrets/backend.runtime.json', import.meta.url), 'utf8'));
const config = loadConfig(runtime);
const server = createServer({ config, service: createCloudBaseService(config) });
server.listen(9000, '127.0.0.1', () => console.log('后端已启动：http://127.0.0.1:9000/api/v1/config'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
