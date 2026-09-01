// 端判定唯一可信源（single source of truth）。
// 全项目所有「是否手机端」的判定都必须通过本模块，禁止再写 window.matchMedia(...)。
// 这样判定条件只改一处，JS 与 CSS 共用同一来源，从源头消灭「改了手机漏了 PC」的顾此失彼。

export const MOBILE_QUERY = '(max-width: 768px) and (pointer: coarse)';

const mql = window.matchMedia(MOBILE_QUERY);

// 以函数形式暴露：调用时永远读最新值（响应式 resize / 跨端切换都正确）。
export const isMobile = () => mql.matches;

// PC 端判定（与 isMobile 互补，供平台模块按需使用）。
export const isPC = () => !mql.matches;

// 暴露底层 MediaQueryList，供需要监听 change 事件的地方（如 setupMobileUI）。
export const mobileMql = mql;

// 在 <body> 上打 data-platform 属性，供 CSS 用 .mobile / .pc 类做隔离（与 JS 判定对齐）。
function applyDataPlatform() {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.setAttribute('data-platform', isMobile() ? 'mobile' : 'pc');
}
applyDataPlatform();
mql.addEventListener('change', applyDataPlatform);

// 兼容旧代码：之前大量逻辑通过 window.__isMobile() 读取端判定。
// 现统一指向本模块，避免旧引用各自 matchMedia 造成多源不一致。逐步废弃。
window.__isMobile = isMobile;
