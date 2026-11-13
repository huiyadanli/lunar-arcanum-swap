import { defineConfig } from 'vite';

export default defineConfig({
  // 使用相对资源路径，同一份 dist 可以部署到域名根目录或任意子目录。
  base: './',
  build: {
    // 卡图保持为独立文件，避免小图内联后增大首屏 JavaScript。
    assetsInlineLimit: 0,
  },
});
