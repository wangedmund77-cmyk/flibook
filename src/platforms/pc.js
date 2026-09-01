// 平台模块：PC 端专属逻辑。
// 只承接「仅 PC 相关」的差异点：左侧图标栏、PC 抽屉（目录/缩略图/搜索）、
// 文字选择守卫（阻止从文字层拖拽触发翻页）。
// 两端共用逻辑（搜索结果跳页、翻页、目录渲染、缩放计算）保留在 core / app 编排层，不在此重复。
//
// 设计约定：平台模块只暴露「装配函数」，由 app.js 在合适时机调用；
// 模块内部依赖的共享状态/工具从 ../core/state.js 与 ../main.js 的共享导出取得。

import { store } from '../core/state.js';

// PC 抽屉视图配置（互斥切换）
const PC_DRAWER_VIEWS = {
    toc:   { el: 'pcViewToc',    title: '目录' },
    thumb: { el: 'pcViewThumb',  title: '缩略图' },
    search:{ el: 'pcViewSearch', title: '搜索' },
};

// 打开 PC 抽屉并切到指定视图
export function openPcDrawer(view) {
    const drawer = document.getElementById('pcDrawer');
    const backdrop = document.getElementById('pcBackdrop');
    const titleEl = document.getElementById('pcDrawerTitle');
    const cfg = PC_DRAWER_VIEWS[view];
    if (!drawer || !cfg) return;

    // 切换视图（互斥）
    document.querySelectorAll('.pc-view').forEach(v => v.classList.remove('active'));
    document.getElementById(cfg.el).classList.add('active');
    if (titleEl) titleEl.textContent = cfg.title;

    // 高亮对应图标
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
    const railBtn = document.getElementById(view === 'thumb' ? 'thumbBtn'
        : view === 'search' ? 'searchBtn'
        : view === 'toc' ? 'tocBtn' : null);
    if (railBtn) railBtn.classList.add('active');

    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.classList.add('open');

    // 按 PDF 内容左缘自适应抽屉宽度，避免遮挡正文
    fitDrawerToPdf();

    // 搜索视图自动聚焦输入框
    if (view === 'search') {
        const input = document.getElementById('searchInput');
        if (input) setTimeout(() => input.focus(), 280);
    }
}

// 计算抽屉宽度 = PDF 内容左缘 − 图标栏宽(50px)，
// 使抽屉正好抵达 PDF 左侧边缘而不遮挡正文。基于 100% 布局宽计算，不受缩放影响。
// 边界：最小 200px（PDF 很宽/窗口很窄时仍有可用宽度），最大 360px。
const PC_RAIL_W = 50;
function fitDrawerToPdf() {
    const drawer = document.getElementById('pcDrawer');
    const container = document.querySelector('.book-container');
    const flip = document.getElementById('flipbook');
    if (!drawer || !container || !flip) return;
    const contLeft = container.getBoundingClientRect().left;
    // flip.offsetWidth 是 page-flip 设定的 layout 宽（不受 transform:scale 影响）= PDF 实际渲染宽
    const pdfLeft = contLeft + (container.clientWidth - flip.offsetWidth) / 2;
    const w = Math.max(200, Math.min(pdfLeft - PC_RAIL_W, 360));
    drawer.style.width = w + 'px';
    drawer.style.setProperty('--pc-drawer-w', w + 'px');
}

// 窗口尺寸变化（含全屏切换）时，若抽屉已打开则重算宽度
let _resizeRaf = null;
window.addEventListener('resize', () => {
    if (_resizeRaf) cancelAnimationFrame(_resizeRaf);
    _resizeRaf = requestAnimationFrame(() => {
        const drawer = document.getElementById('pcDrawer');
        if (drawer && drawer.classList.contains('open')) fitDrawerToPdf();
    });
});

// 关闭 PC 抽屉
export function closePcDrawer() {
    const drawer = document.getElementById('pcDrawer');
    const backdrop = document.getElementById('pcBackdrop');
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.classList.remove('open');
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.remove('active'));
}

// ========== 文字选择拦截守卫 ==========
// 在 document 捕获阶段拦截"从文本层文字开始的"交互，阻止传播到 page-flip 的翻页监听，
// 从而用户拖拽选择文字时不会触发翻页/折角动画。仅 PC 端需要（手机端不渲染 TextLayer）。
// 仅 stopPropagation（不 preventDefault），保留浏览器原生文字选择能力。
let selectingInTextLayer = false;

function isTextLayerTarget(e) {
    return !!(e.target && e.target.closest && e.target.closest('.textLayer'));
}

export function setupTextSelectionGuard() {
    // --- 鼠标 ---
    document.addEventListener('mousedown', (e) => {
        if (isTextLayerTarget(e)) {
            selectingInTextLayer = true;
            e.stopPropagation();
        }
    }, true);
    document.addEventListener('mousemove', (e) => {
        if (selectingInTextLayer) e.stopPropagation();
    }, true);
    document.addEventListener('mouseup', (e) => {
        if (selectingInTextLayer) {
            selectingInTextLayer = false;
            e.stopPropagation();
        }
    }, true);

    // --- 指针（覆盖触控板 / 部分浏览器） ---
    document.addEventListener('pointerdown', (e) => {
        if (isTextLayerTarget(e)) {
            selectingInTextLayer = true;
            e.stopPropagation();
        }
    }, true);
    document.addEventListener('pointermove', (e) => {
        if (selectingInTextLayer) e.stopPropagation();
    }, true);
    document.addEventListener('pointerup', (e) => {
        if (selectingInTextLayer) {
            selectingInTextLayer = false;
            e.stopPropagation();
        }
    }, true);
}
