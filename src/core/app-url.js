// 所有随应用部署的静态资源都相对于 Vite BASE_URL 解析。
// 当前生产构建部署在 Nginx /pdf/ 下，避免以 / 开头的资源错误地请求到站点根目录。
const APP_BASE_URL = new URL(import.meta.env.BASE_URL, window.location.origin);

export function resolveAppUrl(path) {
    const value = String(path || '').trim();
    if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) {
        return new URL(value, window.location.href).href;
    }
    return new URL(value.replace(/^\/+/, ''), APP_BASE_URL).href;
}

export const appBasePath = APP_BASE_URL.pathname;
