import { defineConfig } from 'vite';

export default defineConfig({
  // 生产环境由 Nginx 挂载在 /pdf/，构建产物中的 JS/CSS/Worker/公共资源均带此前缀。
  base: '/pdf/',
  assetsInclude: ['**/*.pdf'],
  preview: {
    allowedHosts: ['fat-eel-96.loca.lt', '.trycloudflare.com'],
  },
});
