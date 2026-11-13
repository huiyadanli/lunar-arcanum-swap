import { build } from 'esbuild';

for (const [name, entry] of [['swap-api', 'backend/index.js'], ['swap-maintenance', 'backend/maintenance.js']]) {
  await build({ entryPoints: [entry], outfile: `cloudfunctions/${name}/index.js`, bundle: true, platform: 'node',
    target: 'node20', format: 'cjs', minify: true, legalComments: 'eof', logLevel: 'info' });
}
