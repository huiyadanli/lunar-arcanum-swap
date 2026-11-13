import { createServer } from './server.js';
import { createCloudBaseService, loadConfig } from './cloudbase.js';

const config = loadConfig();
const server = createServer({ service: createCloudBaseService(config), config });
server.listen(9000, '0.0.0.0', () => console.log(JSON.stringify({ message: 'swap-api ready', port: 9000 })));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
