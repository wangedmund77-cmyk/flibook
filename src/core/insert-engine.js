// 插入 HTML 单页引擎（主线集成）。
//
// 职责（平台无关，不出现 isMobile 判定）：
//   1. loadInsertConfig()  读取 public/insert-config.json 并校验。
//   2. isPdfMatch(config)  判断当前实际打开的 PDF 与配置 pdf.path 是否一致。
//   3. buildInsertPage(url) 构造一个「插入页」.page 节点（内含全屏 iframe）。
//   4. assembleSeq(pdfPageCount, insertions) 把 PDF 页占位与插入页按 afterPage 组装成
//      最终交给 page-flip loadFromHTML 的扁平 seq。
//
// 关键约定（与主线页码模型解耦的关键）：
//   - PDF 页 .page 保留 data-page-num = 真实 PDF 页号；
//   - 插入页 .page 设 data-inserted="1" / data-noPageNumber="1"，【不含】 data-page-num；
//   - 显示层通过「读当前 .page 的 data-page-num」还原真实页码，插入页则显示为空/插入标记，
//     从而实现「插入后原 PDF 页码不变、插入页无页码」。

import { store } from './state.js';
import { resolveAppUrl } from './app-url.js';

const INSERT_CONFIG_URL = resolveAppUrl('insert-config.json?v=20260828-one-tap');
const MOBILE_ZOOM_EDGE_EPSILON = 8;

/**
 * 读取并校验 public/insert-config.json。
 * @returns {Promise<{pdfPath:string, pdfName:string, insertions:Array}>}
 * @throws 解析失败 / 校验失败时抛错（调用方决定是否禁用功能）
 */
export async function loadInsertConfig() {
    let res;
    try {
        res = await fetch(INSERT_CONFIG_URL, { cache: 'no-cache' });
    } catch (e) {
        throw new Error(`无法请求 ${INSERT_CONFIG_URL}：${e.message || e}`);
    }
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}（请确认 public/insert-config.json 存在）`);
    }
    let cfg;
    try {
        cfg = await res.json();
    } catch (e) {
        throw new Error(`insert-config.json 解析失败：${e.message || e}`);
    }
    return validateInsertConfig(cfg);
}

function validateInsertConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') {
        throw new Error('insert-config.json 根节点必须是对象');
    }
    if (!cfg.pdf || typeof cfg.pdf !== 'object') {
        throw new Error('缺少 pdf 对象');
    }
    const path = cfg.pdf.path;
    if (typeof path !== 'string' || !path.trim()) {
        throw new Error('pdf.path 必须是非空字符串（相对 public 根，例如 "sample.pdf"）');
    }
    let name = cfg.pdf.name;
    if (name == null) {
        name = String(path).split('/').pop();
    } else if (typeof name !== 'string') {
        throw new Error('pdf.name 必须是字符串');
    }
    name = name.trim() || String(path).split('/').pop();

    let insertions = cfg.insertions;
    if (insertions == null) insertions = [];
    if (!Array.isArray(insertions)) {
        throw new Error('insertions 必须是数组');
    }
    const items = [];
    insertions.forEach((ins, i) => {
        if (!ins || typeof ins !== 'object') {
            throw new Error(`insertions[${i}] 必须是对象`);
        }
        const ap = ins.afterPage;
        if (!Number.isInteger(ap) || ap < 0) {
            throw new Error(`insertions[${i}].afterPage 必须是非负整数（0 表示首页前）`);
        }
        const url = ins.htmlUrl;
        if (typeof url !== 'string' || !url.trim()) {
            throw new Error(`insertions[${i}].htmlUrl 必须是非空字符串`);
        }
        items.push({
            afterPage: ap,
            htmlUrl: resolveAppUrl(url),
            title: typeof ins.title === 'string' ? ins.title.trim() : '',
        });
    });
    items.sort((a, b) => a.afterPage - b.afterPage);
    return { pdfPath: path.trim(), pdfName: name, insertions: items };
}

/**
 * 判断当前实际打开的 PDF（store.pdfName）是否与配置指定的 PDF 匹配。
 * 仅比较文件名（去掉目录），容忍路径写法差异。
 * @param {{pdfName:string}} config  loadInsertConfig() 的返回值
 * @returns {boolean}
 */
export function isPdfMatch(config) {
    const current = store.pdfName || '';
    if (!current || !config || !config.pdfName) return false;
    const curName = String(current).split(/[\\/]/).pop().toLowerCase();
    const cfgName = String(config.pdfName).split(/[\\/]/).pop().toLowerCase();
    return curName === cfgName;
}

function getTopWindow(frameWindow) {
    let ownerWindow = frameWindow;
    try {
        while (ownerWindow.parent && ownerWindow.parent !== ownerWindow) ownerWindow = ownerWindow.parent;
    } catch (error) { /* 跨域时退回当前 iframe 窗口 */ }
    return ownerWindow;
}

function getMobileNativeZoomPanState(frameWindow) {
    const ownerWindow = getTopWindow(frameWindow);
    const viewport = ownerWindow?.visualViewport || frameWindow?.visualViewport;
    if (!viewport) return null;
    const scale = Number(viewport.scale) || 1;
    if (scale <= 1.01) return null;

    let documentWidth = 0;
    try {
        documentWidth = Number(ownerWindow.document?.documentElement?.clientWidth) || 0;
    } catch (error) { /* 跨域时使用 viewport 尺寸兜底 */ }
    const layoutWidth = Math.max(
        documentWidth,
        Number(ownerWindow.innerWidth) || 0,
        (Number(viewport.width) || 0) * scale,
    );
    const viewportWidth = Number(viewport.width) || (layoutWidth > 0 ? layoutWidth / scale : 0);
    const maxLeft = Math.max(0, layoutWidth - viewportWidth);
    const rawLeft = Math.max(
        Number(viewport.offsetLeft) || 0,
        Number(viewport.pageLeft) || 0,
        Number(ownerWindow.scrollX) || 0,
    );
    const left = Math.min(maxLeft, Math.max(0, rawLeft));
    return {
        atLeft: left <= MOBILE_ZOOM_EDGE_EPSILON,
        atRight: maxLeft - left <= MOBILE_ZOOM_EDGE_EPSILON,
    };
}

function shouldTurnAtMobileNativeZoom(gesture, dx, dy, frameWindow) {
    const zoomState = gesture?.nativeZoom || getMobileNativeZoomPanState(frameWindow);
    if (!zoomState) return true;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX < 10 || absX <= absY * 1.2) return false;
    // 手指左滑会把视觉视口推向右边；手指右滑会把视觉视口推向左边。
    return dx < 0 ? zoomState.atRight : zoomState.atLeft;
}

function injectMobileGestureBridge(iframe, doc) {
    if (!doc || doc.__insertGestureBridgeInstalled) return;
    doc.__insertGestureBridgeInstalled = true;
    // 保留旧标记，兼容现有诊断脚本。
    doc.__swipeInjected = true;

    const frameWindow = doc.defaultView || iframe.contentWindow;
    if (!frameWindow) return;
    const root = doc.documentElement;
    const ownerWindow = getTopWindow(frameWindow);
    const syncTouchAction = () => {
        root.style.touchAction = getMobileNativeZoomPanState(frameWindow)
            ? 'pan-x pan-y pinch-zoom'
            : 'pan-y pinch-zoom';
    };
    syncTouchAction();
    ownerWindow.visualViewport?.addEventListener('resize', syncTouchAction, { passive: true });
    ownerWindow.visualViewport?.addEventListener('scroll', syncTouchAction, { passive: true });
    const interactiveSelector = 'a, button, input, textarea, select, video, audio, iframe, [contenteditable="true"], [data-no-page-swipe]';
    const textSelectableSelector = 'p, h1, h2, h3, h4, h5, h6, li, td, th, dt, dd, label, span, [contenteditable="true"]';
    let gesture = null;

    const isInteractive = (target) => !!(target?.closest && target.closest(interactiveSelector));
    const isTextSelectable = (target) => {
        const element = target?.nodeType === 3 ? target.parentElement : target;
        const candidate = element?.closest?.(textSelectableSelector);
        if (!candidate) return false;
        try {
            const style = frameWindow.getComputedStyle(candidate);
            return style.userSelect !== 'none' && style.webkitUserSelect !== 'none';
        } catch (error) {
            return true;
        }
    };
    const begin = (x, y, target, pointerId = null) => {
        gesture = {
            x,
            y,
            startedAt: Date.now(),
            target,
            pointerId,
            interactive: isInteractive(target),
            textSelectable: isTextSelectable(target),
            selectionActive: !!(doc.getSelection?.() && !doc.getSelection().isCollapsed),
            nativeZoom: getMobileNativeZoomPanState(frameWindow),
        };
    };
    const cancel = () => { gesture = null; };
    doc.addEventListener('selectionchange', () => {
        const selection = doc.getSelection?.();
        if (gesture && selection && !selection.isCollapsed) gesture.selectionActive = true;
    }, { capture: true, passive: true });
    const postTurn = (message) => {
        try {
            frameWindow.parent?.postMessage(message, '*');
        } catch (error) {
            console.warn('[insert] 自定义页翻页消息发送失败:', error);
        }
    };
    const finish = (x, y, target, event) => {
        const start = gesture;
        gesture = null;
        if (!start) return;
        const dx = x - start.x;
        const dy = y - start.y;
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        const selection = doc.getSelection?.();
        if (start.selectionActive || (selection && !selection.isCollapsed)) return;

        // 视频、音频和嵌套 iframe 保留自身横向拖动；放大态未到边缘时也保留原生平移。
        const blockedSwipe = !!(start.target?.closest
            && start.target.closest('video, audio, iframe, [data-no-page-swipe]'))
            || (start.textSelectable && Date.now() - start.startedAt >= 350);
        if (!blockedSwipe && adx >= 30 && adx > ady * 1.2
            && shouldTurnAtMobileNativeZoom(start, dx, dy, frameWindow)) {
            if (event?.cancelable) event.preventDefault();
            event?.stopPropagation?.();
            postTurn({ type: 'insert-swipe', direction: dx < 0 ? 'next' : 'prev' });
            return;
        }

        const width = root?.clientWidth || doc.body?.clientWidth || 0;
        const height = root?.clientHeight || doc.body?.clientHeight || 0;
        const cornerSize = Math.hypot(width, height) / 6;
        const inCorner = x >= 0 && x <= width && y >= 0 && y <= height
            && (x < cornerSize || x > width - cornerSize)
            && (y < cornerSize || y > height - cornerSize);
        if (adx <= 10 && ady <= 10 && Date.now() - start.startedAt < 600
            && inCorner && !start.interactive && !start.textSelectable && !isInteractive(target)) {
            if (event?.cancelable) event.preventDefault();
            event?.stopPropagation?.();
            postTurn({
                type: 'insert-corner-tap',
                direction: x < width / 2 ? 'prev' : 'next',
                corner: y < height / 2 ? 'top' : 'bottom',
            });
        }
    };

    // Pointer Events 在现代 Android/iOS/微信 WebView 中更稳定，并覆盖触控笔；
    // touch-action 只接管横向手势，继续保留纵向与双指缩放。
    if (typeof frameWindow.PointerEvent === 'function') {
        if (root?.style) root.style.touchAction = 'pan-y pinch-zoom';
        const activePointers = new Set();
        doc.addEventListener('pointerdown', (event) => {
            if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
            activePointers.add(event.pointerId);
            if (!event.isPrimary || activePointers.size !== 1) {
                cancel();
                return;
            }
            syncTouchAction();
            begin(event.clientX, event.clientY, event.target, event.pointerId);
        }, { capture: true, passive: true });
        doc.addEventListener('pointermove', (event) => {
            if (!gesture || gesture.pointerId !== event.pointerId || activePointers.size !== 1) return;
            const dx = event.clientX - gesture.x;
            const dy = event.clientY - gesture.y;
            if (gesture.textSelectable && (gesture.selectionActive || Date.now() - gesture.startedAt >= 350)) {
                cancel();
                return;
            }
            const blockedSwipe = !!(gesture.target?.closest
                && gesture.target.closest('video, audio, iframe, [data-no-page-swipe]'));
            if (!gesture.textSelectable && !blockedSwipe
                && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2
                && shouldTurnAtMobileNativeZoom(gesture, dx, dy, frameWindow)
                && event.cancelable) event.preventDefault();
        }, { capture: true, passive: false });
        doc.addEventListener('pointerup', (event) => {
            activePointers.delete(event.pointerId);
            if (!gesture || gesture.pointerId !== event.pointerId || activePointers.size !== 0) return;
            finish(event.clientX, event.clientY, event.target, event);
        }, { capture: true, passive: false });
        doc.addEventListener('pointercancel', (event) => {
            activePointers.delete(event.pointerId);
            if (gesture?.pointerId === event.pointerId) cancel();
        }, { capture: true, passive: true });
        return;
    }

    // 旧版 Safari / WebView 回退到 Touch Events。
    let multiTouch = false;
    doc.addEventListener('touchstart', (event) => {
        if (event.touches.length !== 1) {
            multiTouch = true;
            cancel();
            return;
        }
        if (multiTouch) return;
        const touch = event.touches[0];
        syncTouchAction();
        begin(touch.clientX, touch.clientY, event.target);
    }, { capture: true, passive: true });
    doc.addEventListener('touchmove', (event) => {
        if (event.touches.length !== 1) {
            multiTouch = true;
            cancel();
            return;
        }
        if (!gesture || multiTouch) return;
        const touch = event.touches[0];
        const dx = touch.clientX - gesture.x;
        const dy = touch.clientY - gesture.y;
        if (gesture.textSelectable && (gesture.selectionActive || Date.now() - gesture.startedAt >= 350)) {
            cancel();
            return;
        }
        const blockedSwipe = !!(gesture.target?.closest
            && gesture.target.closest('video, audio, iframe, [data-no-page-swipe]'));
        if (!gesture.textSelectable && !blockedSwipe
            && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2
            && shouldTurnAtMobileNativeZoom(gesture, dx, dy, frameWindow)
            && event.cancelable) event.preventDefault();
    }, { capture: true, passive: false });
    doc.addEventListener('touchend', (event) => {
        if (multiTouch) {
            if (event.touches.length === 0) multiTouch = false;
            cancel();
            return;
        }
        if (event.changedTouches.length !== 1) return;
        const touch = event.changedTouches[0];
        finish(touch.clientX, touch.clientY, event.target, event);
    }, { capture: true, passive: false });
    doc.addEventListener('touchcancel', () => {
        multiTouch = false;
        cancel();
    }, { capture: true, passive: true });
}

function prepareMobileGestureBridge(iframe) {
    if (typeof window === 'undefined' || !window.__isMobile?.()) return;
    if (iframe.__mobileGestureBridgePolling) return;
    iframe.__mobileGestureBridgePolling = true;
    let attempts = 0;
    const attempt = () => {
        if (!iframe.isConnected) {
            iframe.__mobileGestureBridgePolling = false;
            return;
        }
        try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            // src 刚赋值时 contentDocument 仍可能是初始 about:blank；不能把桥接装到即将被替换的文档。
            if (doc && doc.URL !== 'about:blank' && doc.documentElement) {
                injectMobileGestureBridge(iframe, doc);
                iframe.__mobileGestureBridgePolling = false;
                return;
            }
        } catch (error) {
            // 跨域自定义页无法注入；load 阶段会输出一次明确告警。
            iframe.__mobileGestureBridgePolling = false;
            return;
        }
        if (++attempts < 200) {
            setTimeout(attempt, 50);
        } else {
            iframe.__mobileGestureBridgePolling = false;
            console.warn('[insert] 自定义页手势桥接等待超时:', iframe.src);
        }
    };
    attempt();
}

/**
 * 构造一个「插入页」.page 节点（内含 iframe）。
 *
 * 关键：待插入 HTML 通常有自己的设计尺寸（如 viewport width=760、内容可能超出单屏），
 * 直接塞进 PDF 单页大小的 iframe（100% 宽高）会因宽高比不一致导致内容被裁剪/溢出，
 * 表现为「HTML 比 PDF 页大、部分不可见」。因此这里对 iframe 内容做【等比缩放适配】：
 *   - 读取 iframe 内部文档的实际内容宽高（contentW × contentH）；
 *   - 按「适合 PDF 页」的 contain 策略计算 scale = min(pageW/contentW, pageH/contentH)；
 *   - 把 iframe 元素尺寸设为内容尺寸、应用 transform: scale()，并在插入页内居中。
 * 内容被整体等比缩小以完整落入 PDF 页大小内（可能留白边，但不再被裁剪）。
 *
 * @param {string} htmlUrl  插入页 HTML 的 URL（相对站点根，如 /data/v19_single_pages/xxx.html）
 * @param {string} [title]  可选标题，写入 dataset.insertTitle 供调试
 * @returns {HTMLElement}
 */
export function buildInsertPage(htmlUrl, title = '') {
    const div = document.createElement('div');
    div.className = 'page page-insert';
    div.dataset.inserted = '1';
    div.dataset.noPageNumber = '1';
    if (title) div.dataset.insertTitle = title;

    const loading = document.createElement('div');
    loading.className = 'page-insert-loading';
    loading.setAttribute('aria-live', 'polite');
    loading.textContent = '内容加载中…';
    div.appendChild(loading);

    const iframe = document.createElement('iframe');
    // 不设置 src：浏览器的 loading="lazy" 对 page-flip 的绝对定位页面并不可靠，
    // 会在首屏阶段下载数 MB 的插入页并占满 HTTP/1.1 连接。由翻页逻辑按需激活。
    iframe.dataset.src = htmlUrl;
    iframe.setAttribute('allow', 'autoplay; fullscreen');
    iframe.setAttribute('title', title || '自定义页面');
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.transformOrigin = 'top left';
    // 默认先填满插入页；fit() 成功时会被覆盖为「内容设计尺寸 × scale」
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.setAttribute('scrolling', 'no'); // 内容由 transform 缩放，不允许 iframe 内部滚动
    // 关键优化：初始透明，待 fit() 完成缩放后再淡入显示，避免「先以满尺寸显示、再缩小」的可见跳变。
    iframe.style.opacity = '0';
    iframe.style.transition = 'opacity .4s ease-out';
    div.appendChild(iframe);

    const reveal = () => {
        iframe.dataset.insertReady = '1';
        iframe.style.opacity = '1';
        div.classList.add('is-ready');
    };

    // 等比缩放 iframe 内容以适配插入页（PDF 页）大小。
    // 优先读取 iframe 内部 HTML 自带的设计尺寸（--page-w / --page-h，如 760×1074.86，
    // 即 v19 单页固定画布；其内部 .v19-export-viewport 为 overflow:hidden 固定画布尺寸），
    // 用设计尺寸而非 scrollHeight 作为缩放目标——后者会随大图/视频资源加载而变化，
    // 导致 scale 反复重算、出现可见的「大→小」跳变。设计尺寸稳定，首次 fit 即得终值。
    // contain 策略：scale = min(pageW/contentW, pageH/contentH)。
    const fit = () => {
        let contentW = 0, contentH = 0;
        try {
            const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
            if (!doc) return;
            const root = doc.documentElement || doc.body;
            const cs = doc.defaultView.getComputedStyle(root);
            const pw = parseFloat(cs.getPropertyValue('--page-w'));
            const ph = parseFloat(cs.getPropertyValue('--page-h'));
            if (pw > 0 && ph > 0) {
                contentW = pw; contentH = ph;          // 精确设计画布尺寸
            } else {
                contentW = root.scrollWidth || root.clientWidth || 760;
                contentH = root.scrollHeight || root.clientHeight || 1074;
            }
        } catch (e) {
            return; // 跨域或文档未就绪，暂不缩放（保持隐藏，降级由 load 后逻辑兜底）
        }
        let pageW = div.clientWidth;
        let pageH = div.clientHeight;
        // PageFlip hides non-current pages with display:none, so their client size is zero.
        // Use the already-settled renderer bounds to fit a prefetched iframe before it enters
        // the turn animation; otherwise ResizeObserver changes its scale while it is visible.
        if (pageW <= 0 || pageH <= 0) {
            try {
                const bounds = store.pageFlip && store.pageFlip.getBoundsRect
                    ? store.pageFlip.getBoundsRect()
                    : null;
                if (pageW <= 0 && bounds && bounds.pageWidth > 0) pageW = bounds.pageWidth;
                if (pageH <= 0 && bounds && bounds.height > 0) pageH = bounds.height;
            } catch (e) { /* Retry on the next frame if PageFlip is not ready yet. */ }
        }
        // 宿主（插入页 .page）尚未分配到尺寸：先不显示，等尺寸就绪再 fit，避免中间态闪现
        if (pageW <= 0 || pageH <= 0 || contentW <= 0 || contentH <= 0) return;
        // contain：完整容纳内容，等比缩放
        const scale = Math.min(pageW / contentW, pageH / contentH);
        iframe.style.width = contentW + 'px';
        iframe.style.height = contentH + 'px';
        iframe.style.transform = `scale(${scale})`;
        iframe.dataset.fitScale = String(scale);
        return scale; // 返回 scale 供调用方判断是否已稳定
    };

    // load 后立即尝试 fit；若宿主尺寸当时尚未就绪（page-flip 还没给 .page 设尺寸），
    // 用至多 10 帧的 rAF 重试，直到 fit 成功且 scale 稳定（连续两帧一致）才淡入显示，
    // 彻底消除「首次满尺寸→缩小」的可见跳变。
    iframe.addEventListener('load', () => {
        // 手机端：向 iframe 内部注入滑动检测，区分「左右滑动(翻页)」与「点击(点链接)」。
        // iframe 是独立文档会吞掉 touch 事件使翻页器收不到手势；这里在 iframe 内检测滑动，
        // 通过 postMessage 通知父窗口翻页；点击（位移小）不拦截，让 iframe 内链接正常跳转。
        if (typeof window !== 'undefined' && window.__isMobile && window.__isMobile()) {
            try {
                prepareMobileGestureBridge(iframe);
            } catch (err) {
                console.warn('[insert] 自定义页移动手势注入失败:', err);
            }
        }
        // PC：iframe 是独立文档，双击事件不会冒泡到外层 #flipbook；在同源文档内监听后
        // 转发给父窗口，使插入页与普通 PDF Canvas 一样支持双击 100%/200% 切换。
        if (typeof window !== 'undefined' && (!window.__isMobile || !window.__isMobile())) {
            try {
                const doc = iframe.contentDocument || iframe.contentWindow.document;
                // PC 放大态：插入页运行在独立 iframe 中，父页面的抓手光标与 pointer 事件
                // 无法自然穿透进来。对同源插入页注入等价的空白区拖拽，并直接平移父级书本容器。
                // 交互元素始终排除，避免影响链接、按钮、视频及表单控件。
                if (doc && !doc.__pcPanInjected) {
                    doc.__pcPanInjected = true;
                    const parentContainer = document.querySelector('.book-container');
                    const root = doc.documentElement;
                    if (parentContainer && root) {
                        const panStyle = doc.createElement('style');
                        panStyle.setAttribute('data-insert-pan-style', '1');
                        panStyle.textContent = `
                            html[data-insert-pan-enabled="1"],
                            html[data-insert-pan-enabled="1"] body {
                                cursor: grab !important;
                            }
                            html[data-insert-pan-grabbing="1"],
                            html[data-insert-pan-grabbing="1"] body,
                            html[data-insert-pan-grabbing="1"] body * {
                                cursor: grabbing !important;
                                user-select: none !important;
                                -webkit-user-select: none !important;
                            }
                        `;
                        (doc.head || root).appendChild(panStyle);

                        const interactiveSelector = [
                            'a', 'button', 'input', 'textarea', 'select', 'option', 'label',
                            'video', 'audio', 'iframe', '[contenteditable="true"]',
                            '[role="button"]', '[data-no-pan]'
                        ].join(', ');
                        let activePointerId = null;
                        let activePointerTarget = null;
                        let dragged = false;
                        let startX = 0, startY = 0;
                        let startScrollLeft = 0, startScrollTop = 0;
                        let scaleX = 1, scaleY = 1;
                        let suppressClickUntil = 0;

                        const finishPan = (event = null) => {
                            if (activePointerId == null) return;
                            if (event && event.pointerId != null && event.pointerId !== activePointerId) return;
                            const pointerId = activePointerId;
                            const pointerTarget = activePointerTarget;
                            const didDrag = dragged;
                            activePointerId = null;
                            activePointerTarget = null;
                            dragged = false;
                            delete root.dataset.insertPanGrabbing;
                            parentContainer.classList.remove('grabbing');
                            try {
                                if (pointerTarget?.hasPointerCapture?.(pointerId)) {
                                    pointerTarget.releasePointerCapture(pointerId);
                                }
                            } catch (err) { /* pointer capture 已自动释放时无需处理 */ }
                            if (!didDrag) return;
                            suppressClickUntil = performance.now() + 450;
                            const selection = doc.getSelection && doc.getSelection();
                            if (selection && !selection.isCollapsed) selection.removeAllRanges();
                            if (event?.cancelable) event.preventDefault();
                            event?.stopPropagation?.();
                        };

                        const syncPanEnabled = () => {
                            const enabled = store.currentZoom > 1 && parentContainer.classList.contains('zoomed');
                            if (enabled) root.dataset.insertPanEnabled = '1';
                            else {
                                delete root.dataset.insertPanEnabled;
                                finishPan();
                            }
                        };

                        const classObserver = new MutationObserver(syncPanEnabled);
                        classObserver.observe(parentContainer, { attributes: true, attributeFilter: ['class'] });
                        syncPanEnabled();

                        doc.addEventListener('pointerdown', (event) => {
                            if (root.dataset.insertPanEnabled !== '1') return;
                            if (event.pointerType !== 'mouse' || event.button !== 0) return;
                            if (event.target?.closest?.(interactiveSelector)) return;

                            const frameRect = iframe.getBoundingClientRect();
                            const frameWidth = iframe.offsetWidth || parseFloat(iframe.style.width) || frameRect.width;
                            const frameHeight = iframe.offsetHeight || parseFloat(iframe.style.height) || frameRect.height;
                            scaleX = frameWidth > 0 ? frameRect.width / frameWidth : 1;
                            scaleY = frameHeight > 0 ? frameRect.height / frameHeight : 1;
                            activePointerId = event.pointerId;
                            activePointerTarget = event.target;
                            dragged = false;
                            startX = event.clientX;
                            startY = event.clientY;
                            startScrollLeft = parentContainer.scrollLeft;
                            startScrollTop = parentContainer.scrollTop;
                            root.dataset.insertPanGrabbing = '1';
                            parentContainer.classList.add('grabbing');
                            try { event.target?.setPointerCapture?.(event.pointerId); } catch (err) { /* 降级为文档内拖拽 */ }
                        }, { capture: true });

                        doc.addEventListener('pointermove', (event) => {
                            if (activePointerId == null || event.pointerId !== activePointerId) return;
                            const dx = (event.clientX - startX) * scaleX;
                            const dy = (event.clientY - startY) * scaleY;
                            if (!dragged && Math.hypot(dx, dy) >= 5) dragged = true;
                            if (!dragged) return;
                            parentContainer.scrollLeft = startScrollLeft - dx;
                            parentContainer.scrollTop = startScrollTop - dy;
                            if (event.cancelable) event.preventDefault();
                            event.stopPropagation();
                        }, { capture: true, passive: false });

                        doc.addEventListener('pointerup', finishPan, { capture: true });
                        doc.addEventListener('pointercancel', finishPan, { capture: true });
                        doc.addEventListener('lostpointercapture', finishPan, { capture: true });
                        doc.addEventListener('click', (event) => {
                            if (performance.now() >= suppressClickUntil) return;
                            if (event.cancelable) event.preventDefault();
                            event.stopImmediatePropagation();
                        }, true);
                        doc.addEventListener('dblclick', (event) => {
                            if (performance.now() >= suppressClickUntil) return;
                            if (event.cancelable) event.preventDefault();
                            event.stopImmediatePropagation();
                        }, true);
                        iframe.contentWindow?.addEventListener('blur', () => finishPan());
                        iframe.contentWindow?.addEventListener('pagehide', () => {
                            finishPan();
                            classObserver.disconnect();
                        }, { once: true });
                    }
                }
                if (doc && !doc.__doubleClickZoomInjected) {
                    doc.__doubleClickZoomInjected = true;
                    doc.addEventListener('dblclick', (event) => {
                        const target = event.target;
                        if (target?.closest
                            && target.closest('a, button, input, textarea, select, [contenteditable="true"]')) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const selection = doc.getSelection && doc.getSelection();
                        if (selection && !selection.isCollapsed) selection.removeAllRanges();
                        // iframe 内的 clientX/clientY 属于子文档坐标系。结合 iframe 的实际
                        // 显示矩形换算为父页面视口坐标，外层才能以用户双击的位置为中心放大。
                        // rect/offset 的比例同时包含插入页 fit scale 与当前书本缩放倍率。
                        const frameRect = iframe.getBoundingClientRect();
                        const frameWidth = iframe.offsetWidth || parseFloat(iframe.style.width) || frameRect.width;
                        const frameHeight = iframe.offsetHeight || parseFloat(iframe.style.height) || frameRect.height;
                        const scaleX = frameWidth > 0 ? frameRect.width / frameWidth : 1;
                        const scaleY = frameHeight > 0 ? frameRect.height / frameHeight : 1;
                        window.postMessage({
                            type: 'insert-double-click-zoom',
                            clientX: frameRect.left + event.clientX * scaleX,
                            clientY: frameRect.top + event.clientY * scaleY,
                        }, '*');
                    }, true);
                }
            } catch (err) { /* 跨域插入页无法注入时保持原行为 */ }
        }
        // 插入页 iframe 是独立文档，链接点击不会冒泡到父页面；仅观察并转发埋点，
        // 不阻止默认跳转行为，避免改变插入页现有交互。
        try {
            const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
            if (doc && !doc.__linkTrackInjected) {
                doc.__linkTrackInjected = true;
                doc.addEventListener('click', (event) => {
                    const el = event.target && event.target.closest ? event.target.closest('a, button') : null;
                    if (!el) return;
                    const linkUrl = el.getAttribute('href') || el.dataset.url || el.dataset.linkUrl || '';
                    let linkText = (el.textContent || '').trim().slice(0, 200);
                    if (!linkText && el.dataset.linkUrl) linkText = el.dataset.linkUrl.slice(0, 200);
                    if (!linkUrl && !linkText) return;
                    if (window.parent && window.parent.postMessage) {
                        window.parent.postMessage({
                            type: 'insert-link-click',
                            link_url: linkUrl,
                            link_text: linkText,
                            link_type: el.dataset.linkType || 'insert-html',
                        }, '*');
                    }
                }, true);
            }
        } catch (err) { /* 跨域插入页无法注入时保持原行为 */ }
        let tries = 0;
        let lastScale = -1;
        const attempt = () => {
            const scale = fit();
            if (scale === undefined) { // 未就绪（尺寸为 0 / 跨域），继续等待
                if (tries++ > 10) { reveal(); return; }
                requestAnimationFrame(attempt);
                return;
            }
            // scale 稳定（与上次一致）才淡入；否则继续等稳定（避免内容/尺寸变化引起的跳变）
            if (scale === lastScale) {
                reveal();
                return;
            }
            lastScale = scale;
            if (tries++ > 10) { reveal(); return; }
            requestAnimationFrame(attempt);
        };
        requestAnimationFrame(attempt);
    });
    iframe.addEventListener('error', () => {
        loading.textContent = '内容加载失败，请稍后重试';
        div.classList.add('is-load-error');
    });
    // 宿主（插入页 .page）尺寸变化时重新适配（如翻页器 resize / 布局切换）
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => requestAnimationFrame(fit));
        ro.observe(div);
    }
    return div;
}

/**
 * 激活指定物理页附近的插入页 iframe。未激活前 iframe 没有 src，不产生网络请求。
 * @param {number} physicalIndex page-flip 的物理页索引
 * @param {number} radius 同时预取前后多少页
 */
export function activateInsertFramesNear(physicalIndex, radius = 0) {
    const flipbook = document.getElementById('flipbook');
    if (!flipbook) return;
    const pages = flipbook.querySelectorAll('.page');
    const start = Math.max(0, physicalIndex - radius);
    const end = Math.min(pages.length - 1, physicalIndex + radius);
    for (let i = start; i <= end; i++) {
        const iframe = pages[i] && pages[i].querySelector
            ? pages[i].querySelector('iframe[data-src]')
            : null;
        if (!iframe || !iframe.dataset.src) continue;
        iframe.src = iframe.dataset.src;
        delete iframe.dataset.src;
        // 不等待大图、字体或第三方脚本全部完成；文档节点一可访问就安装移动端手势。
        prepareMobileGestureBridge(iframe);
    }
}

/**
 * 把「PDF 原始页码」换算为「最终翻页序列的物理索引」(page-flip 的 flip(index) 用)。
 *
 * 最终序列 = PDF 页 1,2,… 中间按 afterPage 插入若干插入页。排在目标 PDF 页之前的
 * 插入页会把它往后挤，故偏移 = 排在目标页之前的插入页数（仅当插入页可见时计入）。
 *
 * 该函数供「插入页 iframe 内链接」通过 postMessage 跳转到 PDF 章节时使用：
 *   iframe 内 <a data-goto-page="12"> → 父窗口换算 → store.pageFlip.flip(idx)。
 *
 * @param {number} pdfPage  PDF 原始页码（从 1 开始）
 * @returns {number}  page-flip 物理索引（从 0 开始），可直接传给 flip()
 */
export function pdfPageToFlipIndex(pdfPage) {
    const p = Math.max(1, Math.floor(pdfPage) || 1);
    // 插入页不可见时，序列里没有插入页，偏移为 0
    if (!store.insertVisible || !store.insertedPages || store.insertedPages.length === 0) {
        return p - 1;
    }
    let ahead = 0;
    for (const it of store.insertedPages) {
        // afterPage < p 的插入页排在目标 PDF 页之前，产生 +1 偏移
        if (it.afterPage < p) ahead++;
    }
    return (p - 1) + ahead;
}

/**
 * 把「PDF 页占位数组」与「插入页配置」按 afterPage 组装成最终扁平 seq。
 * - afterPage === 0      → 插入页排在最前（首页之前）。
 * - afterPage === N (N≥1) → 插入页排在 PDF 第 N 页之后。
 * 同一 afterPage 有多个插入项时，按它们在 insertions 中的顺序依次插入。
 * 返回的 seq 元素顺序即最终翻页顺序；PDF 页占位对象被原样保留（data-page-num 不变）。
 *
 * @param {HTMLElement[]} pdfPages   PDF 页占位 .page 数组（第 i 个对应 PDF 第 i+1 页）
 * @param {Array<{afterPage:number, htmlUrl:string, title:string}>} insertions
 * @returns {HTMLElement[]}  组装后的最终 .page 序列
 */
export function assembleSeq(pdfPages, insertions) {
    const seq = [];
    // afterPage === 0 的插入项排在最前
    insertions.filter((it) => it.afterPage === 0).forEach((it) => {
        seq.push(buildInsertPage(it.htmlUrl, it.title));
    });
    pdfPages.forEach((p, idx) => {
        seq.push(p);
        const pageNum = idx + 1;
        insertions.filter((it) => it.afterPage === pageNum).forEach((it) => {
            seq.push(buildInsertPage(it.htmlUrl, it.title));
        });
    });
    return seq;
}
