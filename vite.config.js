import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { zipDirectory } from './scripts/zip-dir.mjs';

// 构建完成后把 dist 同步打成 zip（output/dist.zip；online 模式为 output/dist-online.zip）。
function zipDist() {
  let config;
  return {
    name: 'zip-dist',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const suffix = config.mode === 'production' ? '' : `-${config.mode}`;
      const target = resolve(config.root, 'output', `dist${suffix}.zip`);
      const count = zipDirectory(outDir, target);
      config.logger.info(`zip: ${count} files -> ${target}`);
    },
  };
}

export default defineConfig({
  // 使用相对资源路径，同一份 dist 可以部署到域名根目录或任意子目录。
  base: './',
  build: {
    // 卡图保持为独立文件，避免小图内联后增大首屏 JavaScript。
    assetsInlineLimit: 0,
  },
  plugins: [zipDist()],
});
