// 编排层（步骤4）：App 负责把 core（平台无关）与 platforms（端专属）装配起来。
// 本文件包含「两端共用」的共享逻辑：PDF 加载编排、搜索、缩放、居中、全屏、分享、
// 缩略图、响应式单/双页同步、事件绑定。PC/手机差异点分别委托给 platforms/pc.js / mobile.js。
//
// 入口 main.js 仅做：import './app.js'（本文件自启动）。

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';

import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
// Keep an explicit revision so clients do not reuse a previously cached worker
// response with an incorrect MIME type after an Nginx configuration update.
pdfjsLib.GlobalWorkerOptions.workerSrc = `${pdfWorkerUrl}?v=20260826`;

import { isMobile as isMobileFn, MOBILE_QUERY, mobileMql } from './platform-detect.js';
import { store } from './core/state.js';
import {
    resolveTOC, renderTOC, updateActiveTOC
} from './core/toc.js';
import {
    loadPrebuiltTextIndex, setTextIndex, searchIndex,
    highlightSearchOnPage, highlightSearchOnVisiblePages, clearAllSearchHighlights
} from './core/text-index.js';
import {
    loadPdf, renderAllPages, createPageFlip, refillPages, buildPagePlaceholders,
    rerenderVisiblePagesForZoom, cancelZoomRerenders, restoreBaseCanvasesAfterZoom,
    requestPriorityPageCanvas
} from './core/pdf-engine.js';
import { loadInsertConfig, isPdfMatch, pdfPageToFlipIndex, activateInsertFramesNear } from './core/insert-engine.js';
import {
    initTracker, track, setupLifecycleTracking, trackPdfPageView,
    markPageStayStart, updatePageStayVisibility, measurePrevPageStayMs,
    setJumpTrigger, peekJumpTrigger, clearJumpTrigger, setCommonTitle
} from './core/tracker.js';
import { resolveAppUrl } from './core/app-url.js';

import { openPcDrawer, closePcDrawer, setupTextSelectionGuard } from './platforms/pc.js';
import { setupMobileUI, hideFlipHint } from './platforms/mobile.js';

const ZOOM_STEP = 0.15;
const MIN_ZOOM = 1.0;
const MAX_ZOOM = 3.0;
const DOUBLE_CLICK_ZOOM = 2.0;
const ZOOM_RENDER_DEBOUNCE_MS = 220;
const NORMAL_QUALITY_CSS_PIXEL_RATIO = 2;
const NORMAL_QUALITY_RATIO_TOLERANCE = 0.05;
const DOUBLE_CLICK_DELAY = 280;
const MOBILE_SWIPE_DISTANCE = 30;
const MOBILE_LONG_PRESS_DELAY = 450;
const MOBILE_GESTURE_MOVE_TOLERANCE = 10;
const MOBILE_ZOOM_EDGE_EPSILON = 8;
const INSERT_BOOTSTRAP_WAIT_MS = 250;
const FIRST_INSERT_SEQUENCE_WAIT_MS = 3000;
const FIRST_INSERT_CONTENT_WAIT_MS = 1200;
const DEFAULT_PDF_NAME = '“化”解之道-赢得化工企业绿色竞争力转型.pdf';
const DEFAULT_DOWNLOAD_URL = 'https://nsma-web.schneider-electric.cn/platform/file/attachment/previewByUrl/eda08d684b1944bda08cbac02f128da0';
const DEFAULT_DOWNLOAD_FILE_NAME = '“化”解之道-赢得化工企业绿色竞争力转型.pdf';
// 放大态以 52px 翻页按钮条作为左右边界：按钮紧贴页面外侧，不额外留白。
const PC_ZOOM_EDGE_GUTTER = 52;
const PC_ZOOM_ARROW_GAP = 0;
let zoomRenderTimer = null;
let pageTurnZoomRenderTimer = null;
let baseCanvasRestoreTimer = null;
let normalQualityRenderTimer = null;
const normalQualityPendingPages = new Set();

const firstPagePreview = document.getElementById('firstPagePreview');
const firstPagePreviewImage = document.getElementById('firstPagePreviewImage');
let pendingPreviewNext = !!window.__flipbookPreviewNextRequested;
let pendingPreviewCorner = window.__flipbookPreviewNextCorner === 'top' ? 'top' : 'bottom';
let firstPageInteractiveReady = false;
let previewAdvanceRetryTimer = null;
let insertSequenceReady = false;
let firstInsertSequenceWaitStartedAt = 0;
let firstInsertContentWaitStartedAt = 0;
let firstInsertSequenceTimeoutWarned = false;
let pendingPcFirstTurn = false;
let pcFirstTurnRetryTimer = null;

function isFirstInsertTurnReady({ waitForContent = true } = {}) {
    if (!insertSequenceReady) {
        if (!firstInsertSequenceWaitStartedAt) firstInsertSequenceWaitStartedAt = performance.now();
        if (performance.now() - firstInsertSequenceWaitStartedAt < FIRST_INSERT_SEQUENCE_WAIT_MS) return false;
        if (!firstInsertSequenceTimeoutWarned) {
            firstInsertSequenceTimeoutWarned = true;
            console.warn('[insert] 首个翻页等待配置超时，继续使用当前页面序列');
        }
        return true;
    }

    firstInsertSequenceWaitStartedAt = 0;
    const pages = Array.from(document.querySelectorAll('#flipbook .page'));
    const firstInsertIndex = pages.findIndex((page) => page.dataset.inserted === '1');
    // 仅当自定义页紧跟封面时才等待；位于正文后方的自定义页不影响首次翻页。
    if (firstInsertIndex !== 1) return true;
    // PC 封面首次翻页会重建为双页实例；旧实例中的 iframe 会被销毁，不能提前请求。
    // 新实例创建后由 rebuildTo() 激活目标附近自定义页，并由加载占位承接慢网等待。
    if (!waitForContent) return true;

    activateInsertFramesNear(firstInsertIndex, 0);
    const frame = pages[firstInsertIndex]?.querySelector('iframe');
    if (frame?.dataset.insertReady === '1') {
        firstInsertContentWaitStartedAt = 0;
        return true;
    }
    if (!firstInsertContentWaitStartedAt) firstInsertContentWaitStartedAt = performance.now();
    // 慢网下不无限阻塞用户：超时后进入自定义页，由页内加载占位承接等待。
    return performance.now() - firstInsertContentWaitStartedAt >= FIRST_INSERT_CONTENT_WAIT_MS;
}

function queuePcFirstTurn() {
    pendingPcFirstTurn = true;
    firstPagePreview?.classList.add('is-queued');
    if (pcFirstTurnRetryTimer != null) return;
    const retry = () => {
        pcFirstTurnRetryTimer = null;
        if (!pendingPcFirstTurn) return;
        if (!store.pageFlip || store.isRebuilding
            || !isFirstInsertTurnReady({ waitForContent: false })) {
            pcFirstTurnRetryTimer = window.setTimeout(retry, 50);
            return;
        }
        pendingPcFirstTurn = false;
        turnPcPageByArrow('next', { skipInsertReadyGate: true });
    };
    pcFirstTurnRetryTimer = window.setTimeout(retry, 50);
}

function isPointInPageCorner(clientX, clientY, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const cornerSize = Math.hypot(rect.width, rect.height) / 6;
    return x >= 0 && x <= rect.width && y >= 0 && y <= rect.height
        && (x < cornerSize || x > rect.width - cornerSize)
        && (y < cornerSize || y > rect.height - cornerSize);
}

function queuePreviewNext(corner = 'bottom') {
    pendingPreviewNext = true;
    pendingPreviewCorner = corner === 'top' ? 'top' : 'bottom';
    window.__flipbookPreviewNextRequested = true;
    window.__flipbookPreviewNextCorner = pendingPreviewCorner;
    firstPagePreview?.classList.add('is-queued');
    // PageFlip 在占位页创建完成后即可接管手势；不再等待第一页 Canvas。
    scheduleAdvanceToNextFromCover();
}

// 首屏手势可能早于 PDF.js/PageFlip 初始化；在短时间内重试，避免单次 RAF 恰好落在初始化空档。
function scheduleAdvanceToNextFromCover() {
    if (previewAdvanceRetryTimer != null) return;
    const retry = () => {
        previewAdvanceRetryTimer = null;
        advanceToNextFromCover();
        if ((pendingPreviewNext || window.__flipbookPreviewNextRequested)
            && firstPagePreview?.isConnected) {
            previewAdvanceRetryTimer = window.setTimeout(() => {
                requestAnimationFrame(retry);
            }, 50);
        }
    };
    requestAnimationFrame(retry);
}

function advanceToNextFromCover() {
    if (window.__flipbookPreviewNextRequested) pendingPreviewNext = true;
    if (!pendingPreviewNext || !store.pageFlip) return;
    if (store.isRebuilding || !isFirstInsertTurnReady()) return;
    const liveFlipbook = document.getElementById('flipbook');
    const rect = liveFlipbook?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || (store.pageFlip.getPageCount?.() || 0) < 2) return;
    pendingPreviewNext = false;
    window.__flipbookPreviewNextRequested = false;
    window.__flipbookFirstTurnStartedBeforeCanvas = !firstPageInteractiveReady;
    window.__flipbookFirstTurnUsedPreviewPlaceholder = !!liveFlipbook.querySelector(
        '.page[data-page-num="1"] .page-preview-placeholder'
    );
    if (isMobileFn()) {
        const corner = pendingPreviewCorner;
        window.__flipbookLastPreviewCorner = corner;
        window.__flipbookPreviewNextCorner = null;
        // 真实翻页开始时静态封面必须立即让出，否则其淡出层会遮住动画前段，
        // 中途才露出第二页会产生从上方突然掉落的错觉。
        hideFirstPagePreview({ immediate: true });
        const before = store.pageFlip.getCurrentPageIndex?.() ?? 0;
        try { store.pageFlip.flipNext(corner); } catch (error) { /* fallback below */ }
        setTimeout(() => {
            if (!store.pageFlip || store.isRebuilding) return;
            const current = store.pageFlip.getCurrentPageIndex?.() ?? before;
            if (current !== before) return;
            const pageCount = store.pageFlip.getPageCount?.() || 1;
            const target = Math.min(before + 1, Math.max(0, pageCount - 1));
            if (store.pageFlip.turnToPage) store.pageFlip.turnToPage(target);
            else if (store.pageFlip.flip) store.pageFlip.flip(target, false);
        }, 900);
        return;
    }
    handleFlipClick({
        clientX: rect.right - 1,
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {},
    });
}

// PageFlip 的占位页先于 PDF.js Canvas 创建。把静态封面克隆到真实第一页，
// 让首个翻页动画有可见的页面内容，不必等远程 PDF 首片段绘制完成。
function seedFirstPagePlaceholder(flipbookEl) {
    const preview = firstPagePreview;
    const previewImage = firstPagePreviewImage;
    if (!flipbookEl || !preview?.isConnected || preview.classList.contains('is-hidden')
        || !previewImage?.naturalWidth || !previewImage.naturalHeight) return;
    const page = flipbookEl.querySelector('.page[data-page-num="1"]');
    if (!page || page.querySelector('canvas, .page-preview-placeholder')) return;

    const image = previewImage.cloneNode(false);
    image.removeAttribute('id');
    image.className = 'page-preview-placeholder';
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.setAttribute('draggable', 'false');
    const textLayer = page.querySelector('.textLayer');
    if (textLayer) page.insertBefore(image, textLayer);
    else page.appendChild(image);
}
const reportPreviewReady = () => {
    const resourceUrl = firstPagePreviewImage?.currentSrc || firstPagePreviewImage?.src;
    const resource = resourceUrl ? performance.getEntriesByName(resourceUrl).at(-1) : null;
    console.info(`[perf] First page preview ready: ${Math.round(resource?.responseEnd || performance.now())} ms`);
};
if (firstPagePreviewImage) {
    if (firstPagePreviewImage.complete && firstPagePreviewImage.naturalWidth > 0) reportPreviewReady();
    else firstPagePreviewImage.addEventListener('load', reportPreviewReady, { once: true });
}

// 预览图比 PDF.js 交互层更早出现。用户此时点击封面右半侧时先记住操作，
// 等 PageFlip 占位页就绪后自动执行，避免“看得见但点不动”；真实 Canvas 随后补齐。
if (firstPagePreview) {
    firstPagePreview.addEventListener('click', (event) => {
        if (!isMobileFn()) return;
        const imageRect = firstPagePreviewImage?.getBoundingClientRect();
        if (!imageRect || imageRect.width <= 0) return;
        // The preview behaves like the real mobile page: taps only turn from a corner.
        // The cover has no previous page, so its two left corners intentionally do nothing.
        if (!isPointInPageCorner(event.clientX, event.clientY, imageRect)) return;
        if (event.clientX < imageRect.left + imageRect.width / 2) return;
        // 手机端从封面进入第二页始终用 bottom 轨迹，避免点击右上角时出现向下坠落感。
        queuePreviewNext('bottom');
    });

    // The preview can remain visible while PDF.js initializes. Preserve the mobile swipe
    // interaction during that interval and replay it as soon as the real flipbook is ready.
    let previewTouchStart = null;
    firstPagePreview.addEventListener('touchstart', (event) => {
        if (!isMobileFn() || event.touches.length !== 1) return;
        const touch = event.touches[0];
        previewTouchStart = { x: touch.clientX, y: touch.clientY, swiping: false };
    }, { passive: true });
    firstPagePreview.addEventListener('touchmove', (event) => {
        if (!isMobileFn() || !previewTouchStart || event.touches.length !== 1) return;
        const touch = event.touches[0];
        const dx = touch.clientX - previewTouchStart.x;
        const dy = touch.clientY - previewTouchStart.y;
        if (Math.abs(dx) > MOBILE_GESTURE_MOVE_TOLERANCE && Math.abs(dx) > Math.abs(dy) * 1.2) {
            previewTouchStart.swiping = true;
            firstPagePreview.classList.add('is-swiping');
            event.preventDefault();
        }
    }, { passive: false });
    firstPagePreview.addEventListener('touchend', (event) => {
        if (!isMobileFn() || !previewTouchStart || event.changedTouches.length !== 1) return;
        const touch = event.changedTouches[0];
        const dx = touch.clientX - previewTouchStart.x;
        const dy = touch.clientY - previewTouchStart.y;
        previewTouchStart = null;
        firstPagePreview.classList.remove('is-swiping');
        if (dx < -MOBILE_SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.2) {
            event.preventDefault();
            event.stopPropagation();
            // 横向滑动不应被重放成顶角翻页，否则首屏会出现从上往下落的轨迹。
            queuePreviewNext('bottom');
        }
    }, { passive: false });
    firstPagePreview.addEventListener('touchcancel', () => {
        previewTouchStart = null;
        firstPagePreview.classList.remove('is-swiping');
    }, { passive: true });
}

function hideFirstPagePreview({ immediate = false } = {}) {
    if (!firstPagePreview) return;
    if (immediate) {
        firstPagePreview.remove();
        return;
    }
    firstPagePreview.classList.add('is-hidden');
    window.setTimeout(() => firstPagePreview.remove(), 220);
}

// 延迟引用 performSearch，供 platforms/mobile.js 在运行时调用（避免初始化期循环依赖求值问题）。
export function performSearchRef() {
    return performSearch;
}

class App {
    constructor() {
        this.isMobile = isMobileFn();
        this.CURRENT_PDF_NAME = DEFAULT_PDF_NAME;
        this.flipbookEl = null;
        this.stopPropFinal = (e) => { e.stopPropagation(); };
        window.__app = this; // 供模块级共享函数（rebuildTo 等）访问实例
    }

    async start() {
        await this.init();
    }

    async init() {
        const isMobile = this.isMobile;
        this.flipbookEl = document.getElementById('flipbook');

        // 先绑定移动端工具栏，避免 PDF 异步加载期间按钮已显示但尚未具备交互能力。
        try {
            setupMobileUI();
        } catch (e) {
            console.error('移动端 UI 初始化失败:', e);
        }

        // 手机端双保险：直接隐藏 PC 专属元素
        if (isMobile) {
            const leftRail = document.querySelector('.left-rail');
            if (leftRail) leftRail.style.display = 'none';
            const pcDrawer = document.getElementById('pcDrawer');
            if (pcDrawer) pcDrawer.style.display = 'none';
            const pcBackdrop = document.getElementById('pcBackdrop');
            if (pcBackdrop) pcBackdrop.style.display = 'none';
        }

        const flipbookEl = this.flipbookEl;

        try {
            const urlParams = new URLSearchParams(window.location.search);
            const pdfName = urlParams.get('file') || this.CURRENT_PDF_NAME;
            const requestedSharePage = parseInt(urlParams.get('page'), 10);
            const hasRequestedSharePage = Number.isInteger(requestedSharePage) && requestedSharePage >= 1;
            // 分享到正文页时不要继续显示首页静态预览，否则目标页加载期间会先闪出封面。
            // page=1 仍保留封面预览，确保首页分享链接维持原有首屏体验。
            if (hasRequestedSharePage && requestedSharePage > 1) {
                hideFirstPagePreview({ immediate: true });
            }
            store.pdfName = pdfName; // 存入 store，供 PC/手机分享共用
            if (pdfName.replaceAll(String.fromCharCode(92), '/').split('/').pop().toLowerCase() !== DEFAULT_PDF_NAME.toLowerCase()) {
                hideFirstPagePreview();
            }
            // 配置与 PDF 并行加载，但不再阻塞首屏翻页器。微信 WebView/慢网下配置请求
            // 可能比 PDF 首片段晚到；若在这里 await，首屏只能显示预览层，手势无法真正翻页。
            const insertConfigPromise = loadInsertConfig().catch((err) => {
                console.warn('[insert] 插入功能配置加载失败：', err && err.message ? err.message : err);
                return null;
            });

            // 1. 加载 PDF
            const { pdf, totalPages, fileSize } = await loadPdf();
            store.pdf = pdf; // 供居中重建（refillPages）复用，缺失会导致重建被永久拦截
            store.pdfFileSize = fileSize;

            // 移动端目录只依赖 chapters.json / PDF outline，不必等待整本 PDF 的 Canvas 渲染。
            // 先并行解析，令目录抽屉在页面后台渲染期间即可打开。
            let earlyMobileTocPromise = null;
            if (isMobile) {
                earlyMobileTocPromise = resolveTOC(pdf, true, [])
                    .then((tocResult) => {
                        renderTOC(tocResult);
                        return tocResult;
                    })
                    .catch((error) => {
                        console.warn('[TOC] 移动端提前解析失败:', error);
                        return { items: [], source: 'empty' };
                    });
            }

            // 2. 文本索引非首屏必需，等第一页 Canvas 可见后再开始请求，避免与 PDF 分片抢带宽。
            let textIndexStarted = false;
            const startTextIndexLoad = () => {
                if (textIndexStarted) return;
                textIndexStarted = true;
                loadPrebuiltTextIndex()
                    .then((data) => { if (data) setTextIndex(data); return data; })
                    .catch((e) => { console.warn('[text-index] 预建索引加载失败（后台加载）:', e); return null; });
            };
            let deferredFeaturesStarted = false;
            let deferredFeaturesFallback = null;
            let insertConfig = null;
            let insertConfigReady = false;
            let initialBatchReady = false;
            let pageFlipReady = false;
            let insertConfigApplied = false;
            let insertApplyRetryTimer = null;
            let insertApplyDone = false;
            let shareLinkTrackerReady = false;
            let shareLinkTracked = false;

            // 深链首屏不是用户翻页，首次 flip 会被初始化帧过滤；待埋点与插入页
            // 初始化完成后补发一次，确保 share_link 能记录真实物理页码。
            const maybeTrackInitialShareLink = () => {
                if (!hasRequestedSharePage || requestedSharePage <= 1
                    || shareLinkTracked || !shareLinkTrackerReady
                    || !pageFlipReady || !insertApplyDone || !store.pageFlip) return;

                const index = store.pageFlip.getCurrentPageIndex?.();
                if (!Number.isInteger(index) || isInsertedPageAt(index)) return;
                const total = store.renderedPageCount || store.pageFlip.getPageCount?.()
                    || store.totalPages || 1;
                const isSingleMode = isMobileFn() || store.currentOrientation === 'single';
                const leftIdx = isSingleMode ? index
                    : (store.coverCentered
                        ? (index % 2 === 1 ? index : index - 1)
                        : (index % 2 === 0 ? index : index - 1));
                const rightIdx = isSingleMode ? null : leftIdx + 1;
                const hasRight = rightIdx != null && rightIdx < total;
                const leftPageNum = leftIdx + 1;
                const rightPageNum = hasRight ? rightIdx + 1 : null;
                const leftFrom = lastScreenLeftPageNum ?? leftPageNum;
                const rightFrom = lastScreenRightPageNum ?? leftFrom;
                const duration = measurePrevPageStayMs();
                const trigger = 'share_link';
                setCommonTitle(rightPageNum != null ? `${leftPageNum}_${rightPageNum}` : String(leftPageNum));
                trackPdfPageView({ pageNum: leftPageNum, fromPageNum: leftFrom, toPageNum: leftPageNum, trigger, durationMs: duration });
                if (rightPageNum != null) {
                    trackPdfPageView({ pageNum: rightPageNum, fromPageNum: rightFrom, toPageNum: rightPageNum, trigger, durationMs: duration });
                }
                clearJumpTrigger();
                lastScreenLeftPageNum = leftPageNum;
                lastScreenRightPageNum = rightPageNum;
                markPageStayStart();
                shareLinkTracked = true;
            };

            const setInsertConfigState = (showInsertions) => {
                const matched = !!insertConfig && isPdfMatch(insertConfig);
                store.insertEnabled = matched;
                store.insertedPages = matched ? (insertConfig.insertions || []) : [];
                store.insertVisible = matched && showInsertions && store.insertedPages.length > 0;
                updateInsertIconState();
                return { matched, hasInsertions: store.insertedPages.length > 0 };
            };

            // 配置正常情况下会在 PDF 文档解析期间完成，首次建书直接带上自定义页占位，
            // 避免用户快速翻页时先进入纯 PDF 序列。仅配置异常晚到时才走后台安全重建。
            const applyInsertConfigWhenReady = () => {
                if (insertConfigApplied || !insertConfigReady || !pageFlipReady || !initialBatchReady) return;
                const pendingMobileTurn = isMobileFn() && !!store.__mobileTurnPending;
                const pendingFirstTurn = pendingPreviewNext || pendingPcFirstTurn;
                const idleWindow = pendingMobileTurn || pendingFirstTurn
                    ? 0
                    : isMobileFn()
                    ? (store.__hasUserInteracted ? 500 : 800)
                    : (store.__hasUserInteracted ? 1500 : 1800);
                const idleWaitMs = (store.__lastUserInteractionAt || 0) + idleWindow - performance.now();
                if (idleWaitMs > 0) {
                    if (insertApplyRetryTimer == null) {
                        insertApplyRetryTimer = setTimeout(() => {
                            insertApplyRetryTimer = null;
                            applyInsertConfigWhenReady();
                        }, idleWaitMs);
                    }
                    return;
                }
                const liveFlipbook = document.getElementById('flipbook');
                const flipState = liveFlipbook?.dataset?.flipState || '';
                if (store.isRebuilding || flipState === 'flipping') {
                    if (insertApplyRetryTimer == null) {
                        insertApplyRetryTimer = setTimeout(() => {
                            insertApplyRetryTimer = null;
                            applyInsertConfigWhenReady();
                        }, 120);
                    }
                    return;
                }
                insertConfigApplied = true;
                const resolved = setInsertConfigState(false);
                if (!resolved.matched) {
                    insertSequenceReady = true;
                    insertApplyDone = true;
                    maybeTrackInitialShareLink();
                    console.log('[insert] 当前 PDF 与 insert-config.json 不匹配（或无配置），插入功能禁用');
                    return;
                }

                if (!resolved.hasInsertions) {
                    insertSequenceReady = true;
                    insertApplyDone = true;
                    maybeTrackInitialShareLink();
                    console.log('[insert] 配置匹配，但没有插入项');
                    return;
                }
                console.log('[insert] 后台配置已就绪，两端统一开始应用插入项：', store.insertedPages.length);
                // toggleInsertedPages() 会记录当前真实 PDF 页并重建物理序列。
                void toggleInsertedPages().then(() => {
                    insertApplyDone = true;
                    maybeTrackInitialShareLink();
                });
            };

            const insertConfigReadyPromise = insertConfigPromise.then((cfg) => {
                insertConfig = cfg;
                insertConfigReady = true;
                if (initialBatchReady) applyInsertConfigWhenReady();
                return cfg;
            });

            const startDeferredFeatures = () => {
                if (deferredFeaturesStarted) return;
                deferredFeaturesStarted = true;
                if (deferredFeaturesFallback) clearTimeout(deferredFeaturesFallback);
                startTextIndexLoad();
                initTracker().then((ok) => {
                    if (ok) {
                        setupLifecycleTracking();
                        shareLinkTrackerReady = true;
                        maybeTrackInitialShareLink();
                    }
                });
            };
            const scheduleDeferredFeatures = () => {
                if (deferredFeaturesStarted) return;
                // 先给第 2/3 页和 O2/C3 一个完整的网络与绘制窗口，再启动搜索索引和埋点。
                setTimeout(() => {
                    if (typeof window.requestIdleCallback === 'function') {
                        window.requestIdleCallback(startDeferredFeatures, { timeout: 2000 });
                    } else {
                        startDeferredFeatures();
                    }
                }, 500);
            };
            const handleInitialBatchFilled = () => {
                console.info('[perf] Initial 3-page batch ready');
                initialBatchReady = true;
                applyInsertConfigWhenReady();
                scheduleDeferredFeatures();
                scheduleNormalQualityRender(300);
            };
            store.onInitialBatchFilled = handleInitialBatchFilled;

            flipbookEl.innerHTML = '';

            // 3. 渐进渲染：先建全部占位页（瞬间）→ onPlaceholdersReady 建翻页器 → 后台逐页填充
            store.totalPages = totalPages;
            // Mobile also needs the transparent PDF.js text layer for native long-press selection.
            // Canvas visibility is still reported before text extraction, so this does not delay first paint.
            store.renderTextLayer = true;

            // 先建立预览图占位，避免缩略图入口被整本 PDF 渲染阻塞；每页 Canvas 完成后增量填充。
            this.generateThumbnails(totalPages);

            // 给并行请求一个很短的收口窗口。正常同源配置通常早已完成，不增加等待；
            // 慢网最多让出 250ms，静态封面仍保持可见，不让配置无限阻塞首屏。
            if (!insertConfigReady) {
                await Promise.race([
                    insertConfigReadyPromise,
                    new Promise((resolve) => setTimeout(resolve, INSERT_BOOTSTRAP_WAIT_MS)),
                ]);
            }
            if (insertConfigReady) {
                const resolved = setInsertConfigState(true);
                insertConfigApplied = true;
                insertApplyDone = true;
                insertSequenceReady = true;
                if (resolved.matched && resolved.hasInsertions) {
                    console.log('[insert] 配置已参与首次建书：', store.insertedPages.length);
                } else if (!resolved.matched) {
                    console.log('[insert] 当前 PDF 与 insert-config.json 不匹配（或无配置），插入功能禁用');
                }
            } else {
                // 配置晚到时先建立纯 PDF 占位；首批完成后由上面的安全回退一次性重建。
                store.insertEnabled = false;
                store.insertedPages = [];
                store.insertVisible = false;
                insertSequenceReady = false;
            }

            // 分享页码是 PDF 真实页码；若首次序列已含插入页，这里同步换算物理索引。
            // 首次创建 PageFlip 时直接使用该索引，避免先显示首页再二次跳转。
            const initialPdfPage = hasRequestedSharePage
                ? Math.min(requestedSharePage, totalPages)
                : 1;
            const initialPhysicalIndex = pdfPageToFlipIndex(initialPdfPage);
            store.currentPageIndex = initialPhysicalIndex;

            // 分享深链在 PC 双页模式下，目标页与其同屏对页都需要优先绘制；
            // 否则 PageFlip 已经定位到 spread 后，另一侧仍会在普通队列中等待，短暂显示空白。
            // 这里按最终物理序列（含插入页）反查同一 spread 内的真实 PDF 页号，
            // 插入页/透明补位不会被加入优先队列。目标页始终排在第一位，保证预览层只由目标页回调关闭。
            const initialPriorityPages = (() => {
                if (!hasRequestedSharePage || isMobile) return [initialPdfPage];

                const initIsFirst = initialPdfPage === 1;
                const initIsLast = initialPdfPage === totalPages;
                const hasInsertionBeforeLast = store.insertVisible
                    && store.insertedPages.some((item) => item.afterPage === totalPages - 1);
                const initShouldCenter = initIsFirst || (initIsLast && !hasInsertionBeforeLast);
                if (store.coverCentered && initShouldCenter) return [initialPdfPage];

                // showCover=true 的 PC 双页序列为 [0]、[1,2]、[3,4]……；
                // 按物理索引定位目标 spread，再将其中的 PDF 页映射回真实页码。
                const spreadStart = initialPhysicalIndex === 0
                    ? 0
                    : 1 + (2 * Math.floor((initialPhysicalIndex - 1) / 2));
                const physicalToPdf = new Map();
                for (let page = 1; page <= totalPages; page++) {
                    physicalToPdf.set(pdfPageToFlipIndex(page), page);
                }
                const sameSpreadPages = [spreadStart, spreadStart + 1]
                    .map((index) => physicalToPdf.get(index))
                    .filter((page) => Number.isInteger(page));
                return [initialPdfPage, ...sameSpreadPages.filter((page) => page !== initialPdfPage)];
            })();

            await renderAllPages(pdf, totalPages, {
                renderTextLayer: store.renderTextLayer,
                flipbookEl,
                // 分享深链优先渲染目标页及其 PC 同屏页；普通首页继续走静态预览的快速路径。
                priorityPage: hasRequestedSharePage ? initialPdfPage : 1,
                priorityPages: hasRequestedSharePage ? initialPriorityPages : [],
                onPriorityFilled: (pageNumber) => {
                    if (hasRequestedSharePage && pageNumber === initialPdfPage) {
                        hideFirstPagePreview({ immediate: true });
                    }
                },
                onFirstFilled: () => {
                    firstPageInteractiveReady = true;
                    // PC 的静态封面与第一页 Canvas 尺寸一致，直接无缝换层，避免淡出层遮住
                    // 首次 PageFlip 动画的前半段；手机端继续保留原有淡出效果。
                    // 手机端若已有极早翻页意图，保留预览层到首个自定义页就绪或进入加载占位，
                    // 避免等待期间先露出空白的真实书页。
                    if (!isMobileFn() || !pendingPreviewNext) {
                        hideFirstPagePreview({ immediate: !isMobileFn() });
                    }
                    // 两帧后浏览器已经真正显示第一页，再启动所有非首屏请求。
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        // 第二、第三屏是 O2/C3 插入页：第一页可见后立即预取，优先于搜索和埋点。
                        // PC 封面首次右翻必然从 single 重建为 double；旧实例预取会随重建取消并重复下载。
                        // 手机端或已是双页/深链页面时没有这次销毁，可直接预取附近自定义页。
                        const pcCoverWillRebuild = !isMobileFn()
                            && store.currentOrientation === 'single'
                            && initialPhysicalIndex === 0;
                        if (!pcCoverWillRebuild) activateInsertFramesNear(initialPhysicalIndex, 2);
                        // 先让第二屏资源开始加载，再重放首屏期间排队的翻页；避免翻完后内容二次出现。
                        scheduleAdvanceToNextFromCover();
                        // 极慢设备兜底：即使前三个 PDF Canvas 未完成，8 秒后也启动埋点/索引。
                        if (!deferredFeaturesFallback) {
                            deferredFeaturesFallback = setTimeout(startDeferredFeatures, 8000);
                        }
                    }));
                },
                onPageCanvasFilled: handlePageCanvasFilled,
                onInitialBatchFilled: handleInitialBatchFilled,
                onPlaceholdersReady: async () => {
                    // 占位就绪即可建立翻页器（认识全部页，翻页不越界）
                    const initContainerW = (() => {
                        const bc = document.querySelector('.book-container');
                        return bc ? Math.round(bc.getBoundingClientRect().width) : window.innerWidth;
                    })();
                    const initUseFixed = isMobileFn() && initContainerW < 1100;
                    store.currentModeIsFixed = initUseFixed;
                    // 初始 orientation 同时覆盖分享链接的首/尾页；尾页前存在插入页时仍保持双页展开。
                    const initIsFirst = initialPdfPage === 1;
                    const initIsLast = initialPdfPage === totalPages;
                    const hasInsertionBeforeLast = store.insertVisible
                        && store.insertedPages.some((item) => item.afterPage === totalPages - 1);
                    const initShouldCenter = initIsFirst || (initIsLast && !hasInsertionBeforeLast);
                    const initOrientation = (!isMobile && store.coverCentered && initShouldCenter) ? 'single' : 'double';
                    console.log('[center] 首次建翻页器 orientation:', initOrientation, 'currentPageIndex:', store.currentPageIndex, 'coverCentered:', store.coverCentered);
                    createPageFlip(
                        flipbookEl,
                        initUseFixed ? 'fixed' : 'stretch',
                        this.stopPropFinal,
                        initOrientation,
                        initialPhysicalIndex
                    );
                    pageFlipReady = true;
                    maybeTrackInitialShareLink();
                    const liveFlipbook = document.getElementById('flipbook') || flipbookEl;
                    seedFirstPagePlaceholder(liveFlipbook);

                    // 绑定翻页事件（首次建立；重建实例后由 rebuildTo 再次绑定，防止事件丢失）
                    bindFlipEvents();
                    // 绑定「插入页 iframe 内链接」跨文档跳转（postMessage -> flip）
                    bindInsertPageLinks();

                    // PC 端文字选择守卫
                    if (!isMobile) setupTextSelectionGuard();
                    // 绑定各种控件事件
                    this.bindEvents();
                    // 分享功能
                    setupShareFeature();
                    // 埋点在第一页 Canvas 绘制后异步初始化，不占用首屏关键路径。
                    // 翻页滑块初始化
                    this.setupPageSlider();
                    // 放大后鼠标拖拽平移初始化
                    setupPan();
                    // 自定义页只建立无 src 占位；无用户操作时等首页 Canvas 可见后再加载，
                    // 避免 800KB+ 的 HTML 与 PDF 首屏 Range/Canvas 抢带宽和主线程。
                    scheduleAdvanceToNextFromCover();
                }
            });
            // 若配置较晚返回，首批完成或全量渲染完成后均可在空闲时后台重建。
            applyInsertConfigWhenReady();

            // 文本索引已在第一页 Canvas 可见后启动后台加载，不在这里同步等待。

            // 移动端目录已在 PDF 文档就绪后并行解析；PC 保留原有完整索引回退逻辑。
            if (earlyMobileTocPromise) {
                await earlyMobileTocPromise;
            } else {
                const tocResult = await resolveTOC(pdf, false, store.textIndex);
                renderTOC(tocResult);
            }

        } catch (error) {
            hideFirstPagePreview();
            console.error("PDF 解析失败:", error);
            console.error('Error details:', error.message, error.stack);
            flipbookEl.innerHTML = `<p style="color:red; text-align:center; padding: 2rem;">
                PDF 加载失败，请确保 public 目录下存在 ${DEFAULT_PDF_NAME} 文件<br>
                <span style="font-size: 0.9rem; color: #666; display:block; word-break:break-all;">
                    name: ${error?.name || '未知'}<br>
                    message: ${error?.message || '未知'}<br>
                    stack: ${(error?.stack || '').slice(0, 300)}<br>
                    workerSrc: ${pdfjsLib.GlobalWorkerOptions.workerSrc}
                </span>
            </p>`;
        }

    }

    // ========== 缩略图 ==========
    generateThumbnails(totalPages = store.totalPages) {
        const thumbnailList = document.getElementById('thumbnailList');
        if (!thumbnailList) return;
        thumbnailList.innerHTML = '';

        const thumbWidth = isMobileFn() ? 180 : 200;
        const thumbHeight = Math.round(thumbWidth * (store.pdfBaseHeight || 841.89) / (store.pdfBaseWidth || 595.276));
        const fragment = document.createDocumentFragment();

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            const div = document.createElement('div');
            div.className = 'thumbnail-item';
            div.dataset.page = pageNum;
            div.innerHTML = `
                <canvas width="${thumbWidth}" height="${thumbHeight}"></canvas>
                <div class="thumb-page-num">第 ${pageNum} 页</div>
            `;

            div.addEventListener('click', () => {
                flipToIndex(pageNum - 1, 'thumbnail');
            });
            fragment.appendChild(div);
        }
        thumbnailList.appendChild(fragment);

        // 重建翻页器时已有 Canvas 仍可立即复用；尚未完成的页面由回调增量填充。
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) updateThumbnailForPage(pageNum);
    }

    updateActiveThumbnail(currentPage) {
        const thumbItems = document.querySelectorAll('.thumbnail-item');
        let activeItem = null;
        thumbItems.forEach(item => {
            item.classList.remove('active');
            if (parseInt(item.dataset.page) === currentPage) {
                item.classList.add('active');
                activeItem = item;
            }
        });
        if (activeItem) {
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // ========== 事件绑定 ==========
    bindEvents() {
        // 左侧图标栏按钮（PC）
        document.getElementById('homeBtn').addEventListener('click', () => {
            if (store.pageFlip) flipToIndex(0);
        });
        document.getElementById('tocBtn').addEventListener('click', () => { closeZoomBar(); closeGotoBar(); openPcDrawer('toc'); });
        document.getElementById('thumbBtn').addEventListener('click', () => { closeZoomBar(); closeGotoBar(); openPcDrawer('thumb'); });
        document.getElementById('searchBtn').addEventListener('click', () => { closeZoomBar(); closeGotoBar(); openPcDrawer('search'); });
        document.getElementById('zoomBtn').addEventListener('click', toggleZoomBar);
        document.getElementById('gotoBtn').addEventListener('click', toggleGotoBar);

        // PC 书本两侧独立翻页箭头（移动端由 CSS 隐藏，继续使用滑动/四角点击）。
        const pcPrevPageBtn = document.getElementById('pcPrevPageBtn');
        const pcNextPageBtn = document.getElementById('pcNextPageBtn');
        if (pcPrevPageBtn) pcPrevPageBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.blur();
            turnPcPageByArrow('prev');
        });
        if (pcNextPageBtn) pcNextPageBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.blur();
            turnPcPageByArrow('next');
        });

        // 抽屉关闭
        document.getElementById('pcDrawerClose').addEventListener('click', closePcDrawer);
        document.getElementById('pcBackdrop').addEventListener('click', closePcDrawer);

        // 抽屉内搜索触发
        const searchBtnInner = document.getElementById('searchBtnInner');
        if (searchBtnInner) searchBtnInner.addEventListener('click', performSearch);
        document.getElementById('searchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') performSearch();
        });

        // ESC 关闭 PC 抽屉
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const drawer = document.getElementById('pcDrawer');
                if (drawer && drawer.classList.contains('open')) closePcDrawer();
            }
        });

        // 缩放事件（顶部缩放条，替代原抽屉缩放视图，更轻盈）
        document.getElementById('zoomInBtnBar').addEventListener('click', () => applyZoom(ZOOM_STEP));
        document.getElementById('zoomOutBtnBar').addEventListener('click', () => applyZoom(-ZOOM_STEP));
        const zoomRange = document.getElementById('zoomRangeBar');
        if (zoomRange) {
            zoomRange.addEventListener('input', () => {
                const target = parseInt(zoomRange.value, 10) / 100;
                applyZoom(target - store.currentZoom);
            });
        }
        document.getElementById('zoomBarClose').addEventListener('click', closeZoomBar);

        // 跳页气泡：确定 / 回车跳转
        const gotoGo = document.getElementById('gotoGo');
        const gotoInput = document.getElementById('gotoInput');
        if (gotoGo) gotoGo.addEventListener('click', () => { goToPage(gotoInput.value); closeGotoBar(); });
        if (gotoInput) gotoInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); goToPage(gotoInput.value); closeGotoBar(); }
        });

        // 点击页面其他区域（含抽屉）时收起缩放条 / 跳页气泡
        document.addEventListener('click', (e) => {
            const bar = document.getElementById('zoomBar');
            if (bar && bar.classList.contains('open') && !bar.contains(e.target) && !e.target.closest('#zoomBtn')) {
                closeZoomBar();
            }
            const pop = document.getElementById('gotoPopover');
            if (pop && pop.classList.contains('open') && !pop.contains(e.target) && !e.target.closest('#gotoBtn')) {
                closeGotoBar();
            }
        });
        // ESC 收起
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { closeZoomBar(); closeGotoBar(); }
        });

        // 全屏事件
        document.getElementById('fullscreenBtn').addEventListener('click', toggleFullscreen);

        // 下载当前 PDF
        const downloadBtn = document.getElementById('downloadBtn');
        if (downloadBtn) downloadBtn.addEventListener('click', downloadPdf);

        document.addEventListener('fullscreenchange', () => {
            const bookContainer = document.querySelector('.book-container');
            const btn = document.getElementById('fullscreenBtn');
            if (!document.fullscreenElement) {
                bookContainer.classList.remove('fullscreen-mode');
                btn.title = '全屏';
            } else {
                bookContainer.classList.add('fullscreen-mode');
                btn.title = '退出全屏';
            }
            setTimeout(syncAfterLayoutChange, 120);
            setTimeout(centerOverflow, 260);
        });

        // PC 单/双页自适应
        let resizeTimer = null;
        const getResponsiveLayoutKey = () => {
            const bc = document.querySelector('.book-container');
            const vv = window.visualViewport;
            return [
                window.innerWidth,
                window.innerHeight,
                Math.round(vv?.width || 0),
                Math.round(vv?.height || 0),
                bc?.clientWidth || 0,
                bc?.clientHeight || 0,
            ].join(':');
        };
        let lastResponsiveLayoutKey = getResponsiveLayoutKey();
        const applyResponsiveMode = () => {
            // 重建中（rebuildTo 或自身触发的连锁重建）一律跳过，避免「重建改 DOM → 触发 resize
            // → 再重建」的死循环把页面重建到白屏。重建完成后由对应逻辑自行重算尺寸。
            if (store.isRebuilding) return;

            // 缩放态下窗口尺寸变化：先复位缩放，避免 flipbook 的 transform 尺寸与单/双页
            // 形态（page-flip 重建后 layout 尺寸改变）冲突，导致双页→单页切换失灵。
            if (store.currentZoom !== 1) {
                applyZoom(1 - store.currentZoom); // 内部恢复 transform/尺寸/class 并 pageFlip.update + centerOverflow
            }
            const bc = document.querySelector('.book-container');
            const fb = document.getElementById('flipbook');
            let containerW = null;
            if (fb) {
                const parent = fb.querySelector('.stf__parent');
                if (parent) containerW = parent.offsetWidth;
                else if (bc) containerW = Math.round(bc.getBoundingClientRect().width);
            } else if (bc) {
                containerW = Math.round(bc.getBoundingClientRect().width);
            }
            const settings = store.pageFlip && store.pageFlip.getSettings ? store.pageFlip.getSettings() : null;
            const minW = settings ? settings.minWidth : 550;
            const doubleThreshold = minW * 2;
            const SCROLL_THRESHOLD = 600;
            const wantSingle = containerW !== null ? containerW < doubleThreshold : false;
            const wantScrollLock = containerW !== null ? containerW < SCROLL_THRESHOLD : false;
            if (bc) {
                bc.classList.toggle('single-page-mode', wantSingle);
                bc.classList.toggle('scroll-locked', wantScrollLock);
            }

            const wantFixed = isMobileFn() && wantSingle;
            if (wantFixed !== store.currentModeIsFixed) {
                const savedPage = store.currentPageIndex;
                store.currentModeIsFixed = wantFixed;
                rebuildTo(wantFixed ? 'double' : 'double', savedPage)
                    .catch(err => console.error('[center] fixed 模式切换重建失败:', err));
                return;
            }

            // PC 单页居中态（orientation==='single'）下，窗口尺寸变化可能改变单页版芯宽度，
            // 需重建 single 以重算尺寸（仍走 flipToIndex 语义保持首/尾页居中）。
            // 关键修复：仅在「实际算出的单页宽 ≠ 当前基准宽」时才重建，避免无变化的 resize
            // （如重建 DOM 触发的伪 resize）反复重建导致白屏。
            if (store.currentOrientation === 'single' && !isMobileFn()) {
                const padX = bc ? (parseFloat(getComputedStyle(bc).paddingLeft) || 0) * 2 : 0;
                const padY = bc ? (parseFloat(getComputedStyle(bc).paddingTop) || 0) * 2 : 0;
                const availW = (bc ? bc.clientWidth : window.innerWidth) - padX;
                const availH = (bc ? bc.clientHeight : window.innerHeight) - padY - 16;
                const ratio = store.pdfBaseHeight / store.pdfBaseWidth;
                const newW = Math.max(200, Math.round(Math.min(720, availW, availH / ratio)));
                if (newW === store.basePageWidth) {
                    // 尺寸无变化，无需重建，仅更新即可
                    if (store.pageFlip && store.pageFlip.update) { try { store.pageFlip.update(); } catch (e) {} }
                    positionPcPageArrows();
                    return;
                }
                const savedPage = store.currentPageIndex;
                // 重建前更新基准宽，避免 resize 在重建完成前再次触发导致连环重建
                rebuildTo('single', savedPage)
                    .catch(err => console.error('[center] 单页尺寸重建失败:', err));
                return;
            }

            // 双页态纯尺寸变化：page-flip 内部 update() 即可自适应，无需重建（重建会清空 canvas 致空白）。
            if (store.pageFlip && store.pageFlip.update) {
                try { store.pageFlip.update(); } catch (e) { /* update 失败忽略 */ }
            }
            positionPcPageArrows();
        };
        // 关键修复：resize 防抖（120ms），避免打开/关闭 F12 控制台等连续 resize 触发多次重建，
        // 旧 canvas 已清空、新 canvas 未就绪时再次重建 → 永久空白。
        const onResize = () => {
            lastResponsiveLayoutKey = getResponsiveLayoutKey();
            if (resizeTimer) clearTimeout(resizeTimer);
            lastPcArrowBounds = null;
            lastPcArrowLayoutKey = '';
            resizeTimer = setTimeout(() => {
                resizeTimer = null;
                applyResponsiveMode();
                // DevTools 切换后部分浏览器会先恢复容器尺寸，再异步恢复页面层尺寸；
                // 用双帧测量确保按钮不会停留在打开 F12 前的旧坐标。
                schedulePcPageArrowPosition({ reset: true });
            }, 120);
        };
        const onPossibleLayoutChange = () => {
            const nextLayoutKey = getResponsiveLayoutKey();
            if (nextLayoutKey !== lastResponsiveLayoutKey) {
                onResize();
                return;
            }
            // iframe 内双击后再点击父页面按钮也会触发 window.focus，但视口并未变化。
            // 这种焦点切换只需重新定位箭头，不能进入响应式流程把当前缩放复位为 100%。
            lastPcArrowBounds = null;
            lastPcArrowLayoutKey = '';
            schedulePcPageArrowPosition({ reset: true });
        };
        window.addEventListener('resize', onResize);
        // 关闭/切回 DevTools 时不一定触发 window.resize，但书本容器通常会产生尺寸变化。
        // 监听容器本身可以覆盖停靠式 DevTools、浏览器缩放和布局恢复等场景。
        const arrowRelayoutObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => onPossibleLayoutChange())
            : null;
        const bookContainer = document.querySelector('.book-container');
        if (arrowRelayoutObserver && bookContainer) arrowRelayoutObserver.observe(bookContainer);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', onResize, { passive: true });
        }
        // 浏览器从开发者工具返回后可能只恢复窗口焦点，不派发 resize。
        window.addEventListener('focus', onPossibleLayoutChange, { passive: true });
        setTimeout(applyResponsiveMode, 400);
    }
}

// ========== 模块级共享函数（与 App 实例状态无关，供 App 方法与普通回调共用） ==========

// 共享翻页逻辑保留给首屏队列等显式调用；PC 页面本体普通点击不再触发该逻辑。
function handleFlipClick(e) {
    if (!store.pdf) return;
    if (window.__app && window.__app.isMobile) return; // 移动端交回库手势处理
    // 文本选择（拖选文字）结束时也会触发 click，避免误翻页
    if (window.getSelection && window.getSelection().toString().length > 0) return;
    const fb = document.getElementById('flipbook');
    if (!fb || !store.pageFlip) return;
    const rect = fb.getBoundingClientRect();
    if (!rect.width) return;
    const x = e.clientX - rect.left;
    const midX = rect.width / 2;
    const cur = store.pageFlip.getCurrentPageIndex ? store.pageFlip.getCurrentPageIndex() : 0;
    // 物理索引上界：当前翻页器实际 .page 总数 - 1（含插入页/补位）。
    const lastIdx = (store.renderedPageCount || (store.pageFlip.getPageCount ? store.pageFlip.getPageCount() : store.totalPages) || 0) - 1;
    // 边界屏蔽：以「当前 spread 左/右页自身是否真为 PDF 首/尾页」判定。
    // 注意：插入页无 data-page-num，pdfPageAt 会返回其前序 PDF 页号（如 O2 继承首页=1），
    // 若用页号比对会把"紧跟首页的插入页"误判成首页，导致点插入页左侧无法翻回首页。
    // 故直接读页自身 dataset.pageNum，只有真实 PDF 边界页（带对应页号）才屏蔽。
    const pages = fb.querySelectorAll('.page');
    const curNum = pages[cur] && pages[cur].dataset ? pages[cur].dataset.pageNum : undefined;
    const firstShown = (curNum === '1');                              // 左页是真实 PDF 首页
    // 物理序列尾部可能还有插入页，因此以当前 spread 是否覆盖最后一个非补位页为准。
    const lastNavigableIdx = getLastNavigablePhysicalIndex();
    const lastShown = cur + getPcVisiblePageStep() - 1 >= lastNavigableIdx;
    if (firstShown && x < midX) return;                              // 首页左侧
    if (lastShown && x > midX) {                                     // 尾页右侧
        try { e.stopImmediatePropagation(); e.preventDefault(); e.stopPropagation(); } catch (e2) {}
        return;
    }

    const target = (x > midX) ? cur + 1 : cur - 1;
    if (target < 0 || target > lastIdx) return;
    // 跨单/双页重建后的首个 flip 也是用户真实翻页，不能被初始化帧过滤。
    hasUserFlipIntent = true;
    setJumpTrigger(x > midX ? 'touch' : 'touch');

    const wantSingle = isCenteredIndex(target);
    const curSingle = store.currentOrientation === 'single';
    const targetMode = wantSingle ? 'single' : 'double';
    if (curSingle !== (targetMode === 'single')) {
        // 需要切换 orientation：预判式重建，落位在 createPageFlip 的 init 内完成，库不执行错误翻页
        // 仅「单页 → 双页」（如首页翻出到第2/3页）启用翻页动画，其余跨 orientation 重建保持无动画。
        const withAnim = (curSingle && targetMode === 'double') ? { animateToPage: target, startFrom: cur } : {};
        rebuildTo(targetMode, target, withAnim);
    } else {
        // 无需重建时可直接预取；需要重建的路径会在新 DOM 建好后再激活，避免请求被取消重发。
        activateInsertFramesNear(target, 1);
        // 同 orientation 内翻页：用库自带的 flipNext/flipPrev，步长由库按当前模式自动处理
        // （单页 +1、双页 +2），并带翻页动画，避免直接用 flip(cur+1) 在双页里只跳到右页导致"无响应"。
        hasUserFlipIntent = true;
        try {
            if (x > midX) store.pageFlip.flipNext();
            else store.pageFlip.flipPrev();
        } catch (e2) { /* ignore */ }
    }
}

function getLastNavigablePhysicalIndex() {
    const fb = document.getElementById('flipbook');
    const pages = fb ? Array.from(fb.querySelectorAll('.page')) : [];
    for (let index = pages.length - 1; index >= 0; index--) {
        if (pages[index]?.dataset?.blank !== '1') return index;
    }
    return Math.max(0, (store.renderedPageCount || 1) - 1);
}

function getPcVisiblePageStep() {
    // PageFlip can switch a PC double-page instance to portrait layout when the window is
    // narrow. Its runtime orientation, rather than our configured shell orientation, tells
    // us whether one or two physical pages are currently advanced per screen.
    return store.pageFlip?.getOrientation?.() === 'landscape' ? 2 : 1;
}

let lastPcArrowBounds = null;
let lastPcArrowLayoutKey = '';
let pcArrowPositionRaf = null;
let pcArrowScrollRaf = null;
const PC_PAGE_ARROW_WIDTH = 52;

function schedulePcPageArrowPosition({ reset = false } = {}) {
    if (isMobileFn()) return;
    const container = document.querySelector('.book-container');
    const prev = document.getElementById('pcPrevPageBtn');
    const next = document.getElementById('pcNextPageBtn');
    container?.classList.add('pc-arrows-relayout');
    // 定位完成前按钮仍处于默认的小尺寸占位位置；保持禁用，避免强制刷新后
    // 用户在两帧布局窗口内点到“看似可用、实际被 relayout 层拦截”的箭头。
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    if (reset) {
        lastPcArrowBounds = null;
        lastPcArrowLayoutKey = '';
    }
    if (pcArrowPositionRaf != null) cancelAnimationFrame(pcArrowPositionRaf);
    // PageFlip 重建后需等两帧，确保单/双页容器及可见页的最终尺寸均已落定。
    pcArrowPositionRaf = requestAnimationFrame(() => {
        pcArrowPositionRaf = requestAnimationFrame(() => {
            pcArrowPositionRaf = null;
            positionPcPageArrows({ force: true });
            container?.classList.remove('pc-arrows-relayout');
            updatePcPageArrowState();
        });
    });
}

function clampPcArrowValue(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function positionPcPageArrows({ force = false } = {}) {
    const container = document.querySelector('.book-container');
    const flipbook = document.getElementById('flipbook');
    if (!container || !flipbook || isMobileFn()) return;
    const containerRect = container.getBoundingClientRect();
    const pageCandidates = Array.from(flipbook.querySelectorAll('.page'))
        .map((page) => ({ display: getComputedStyle(page).display, rect: page.getBoundingClientRect() }))
        .filter(({ display, rect }) => display !== 'none' && rect.width > 20 && rect.height > 20);
    const visiblePages = pageCandidates.filter(({ rect }) => (
        rect.right > containerRect.left && rect.left < containerRect.right
        && rect.bottom > containerRect.top && rect.top < containerRect.bottom
    ));
    const pages = visiblePages.length ? visiblePages : pageCandidates;
    if (!pages.length) return;
    const pageLeft = Math.min(...pages.map(({ rect }) => rect.left)) - containerRect.left;
    const pageRight = Math.max(...pages.map(({ rect }) => rect.right)) - containerRect.left;
    const pageTop = Math.min(...pages.map(({ rect }) => rect.top)) - containerRect.top;
    const pageBottom = Math.max(...pages.map(({ rect }) => rect.bottom)) - containerRect.top;
    if (![pageLeft, pageRight, pageTop, pageBottom].every(Number.isFinite)) return;
    // 100% 下同一模式只采样一次，避免插入页 iframe 的亚像素变化导致箭头跳动。
    // 放大态必须随滚动实时测量，确保按钮始终位于当前可视区域内。
    const layoutKey = `${store.currentOrientation || ''}|${store.currentZoom || 1}`;
    const isZoomed = store.currentZoom > 1;
    if (!force && !isZoomed && lastPcArrowBounds && lastPcArrowLayoutKey === layoutKey) return;

    const viewportWidth = container.clientWidth;
    const viewportHeight = container.clientHeight;
    const maxArrowLeft = Math.max(0, viewportWidth - PC_PAGE_ARROW_WIDTH);
    const visibleTop = clampPcArrowValue(pageTop, 0, viewportHeight);
    const visibleBottom = clampPcArrowValue(pageBottom, 0, viewportHeight);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    if (visibleHeight < 20) return;

    // 按钮是滚动容器内的 absolute 子元素：视口坐标需加 scroll 偏移转为内容坐标。
    // 页边仍在视口中时紧贴页边；页边移出视口后钉在对应视口边缘，始终保持可操作。
    const arrowGap = isZoomed ? PC_ZOOM_ARROW_GAP : 0;
    const prevViewportLeft = clampPcArrowValue(pageLeft - PC_PAGE_ARROW_WIDTH - arrowGap, 0, maxArrowLeft);
    const nextViewportLeft = clampPcArrowValue(pageRight + arrowGap, 0, maxArrowLeft);
    const scrollLeft = container.scrollLeft;
    const scrollTop = container.scrollTop;
    const bounds = {
        left: pageLeft,
        right: pageRight,
        top: visibleTop,
        height: visibleHeight,
        prevLeft: prevViewportLeft + scrollLeft,
        nextLeft: nextViewportLeft + scrollLeft,
        contentTop: visibleTop + scrollTop,
    };
    lastPcArrowBounds = bounds;
    lastPcArrowLayoutKey = layoutKey;
    container.style.setProperty('--pc-arrow-prev-left', `${Math.round(bounds.prevLeft)}px`);
    container.style.setProperty('--pc-arrow-next-left', `${Math.round(bounds.nextLeft)}px`);
    container.style.setProperty('--pc-page-top', `${Math.round(bounds.contentTop)}px`);
    container.style.setProperty('--pc-page-height', `${Math.round(bounds.height)}px`);
}

function schedulePcPageArrowScrollSync() {
    if (isMobileFn() || store.currentZoom <= 1 || pcArrowScrollRaf != null) return;
    pcArrowScrollRaf = requestAnimationFrame(() => {
        pcArrowScrollRaf = null;
        positionPcPageArrows({ force: true });
    });
}

function updatePcPageArrowState() {
    const prev = document.getElementById('pcPrevPageBtn');
    const next = document.getElementById('pcNextPageBtn');
    if (!prev || !next) return;
    positionPcPageArrows();
    const container = document.querySelector('.book-container');
    const unavailable = isMobileFn() || !store.pageFlip || store.isRebuilding
        || !lastPcArrowBounds || container?.classList.contains('pc-arrows-relayout');
    const current = store.pageFlip?.getCurrentPageIndex?.() ?? 0;
    const last = getLastNavigablePhysicalIndex();
    const visibleEnd = current + getPcVisiblePageStep() - 1;
    prev.disabled = unavailable || current <= 0;
    next.disabled = unavailable || visibleEnd >= last;
}

function turnPcPageByArrow(direction, options = {}) {
    if (isMobileFn() || !store.pdf || !store.pageFlip) return;
    if (store.isRebuilding) {
        setTimeout(() => turnPcPageByArrow(direction, options), 180);
        return;
    }
    store.__lastUserInteractionAt = performance.now();
    store.__hasUserInteracted = true;
    const current = store.pageFlip.getCurrentPageIndex?.() ?? 0;
    if (direction === 'next' && current === 0
        && !options.skipInsertReadyGate
        && !isFirstInsertTurnReady({ waitForContent: false })) {
        queuePcFirstTurn();
        return;
    }
    const last = getLastNavigablePhysicalIndex();
    // 单页封面切换到 PC 双页时：纯 PDF 序列沿用索引 2 作为首个 spread 的定位目标；
    // 若索引 1 是首页后的自定义页，则它本身就是新 spread 左页，首次目标必须为 1，
    // 否则动画尾帧会落到索引 2 并把自定义页排除。双页稳定后仍按运行时步长推进。
    const step = direction === 'next' && store.currentOrientation === 'single'
        ? (isInsertedPageAt(1) ? 1 : 2)
        : getPcVisiblePageStep();
    const target = direction === 'next'
        ? Math.min(last, current + step)
        : Math.max(0, current - step);
    if (target === current) return;
    // 跨单/双页重建后的首个 flip 也是用户真实翻页，不能被初始化帧过滤。
    hasUserFlipIntent = true;

    // 强制刷新后箭头可能先于第一页 Canvas 就绪。此时保留静态封面并显示排队提示；
    // 动画起始页填充完成后再无缝移除，避免提前隐藏产生空白，也避免遮住动画。
    if (direction === 'next' && !firstPageInteractiveReady) {
        firstPagePreview?.classList.add('is-queued');
    }

    const targetOrientation = isCenteredIndex(target) ? 'single' : 'double';
    setJumpTrigger('arrow');
    if (targetOrientation !== store.currentOrientation) {
        // 单页封面进入双页时从当前页播放到目标页；双页回到单页时直接落到目标页，
        // 避免把首页后的插入页按当前索引重建成单页。
        const animateCross = direction === 'next' && targetOrientation === 'double';
        const rebuildPromise = rebuildTo(
            targetOrientation,
            animateCross ? current : target,
            animateCross ? { animateToPage: target, startFrom: current } : {}
        );
        rebuildPromise
            .catch((error) => console.error('[pc-arrow] rebuild failed:', error))
            .finally(updatePcPageArrowState);
    } else {
        activateInsertFramesNear(target, store.currentOrientation === 'double' ? 1 : 0);
        const before = current;
        hasUserFlipIntent = true;
        setJumpTrigger('arrow');
        try {
            if (direction === 'next') store.pageFlip.flipNext();
            else store.pageFlip.flipPrev();
        } catch (error) {
            safeFlip(target);
        }
        // A few browser/page-flip combinations can ignore a programmatic animation while
        // their renderer is settling. Guarantee that the requested destination still wins.
        setTimeout(() => {
            if (!store.pageFlip || store.isRebuilding) return;
            const settled = store.pageFlip.getCurrentPageIndex?.() ?? before;
            if (settled === before) safeFlip(target);
            updatePcPageArrowState();
        }, 900);
    }
    updatePcPageArrowState();
}

let pendingPcFlipClickTimer = null;
let suppressPcFlipClickUntil = 0;

function cancelPendingPcFlipClick() {
    if (!pendingPcFlipClickTimer) return;
    clearTimeout(pendingPcFlipClickTimer);
    pendingPcFlipClickTimer = null;
}

function isInteractiveBookTarget(target) {
    if (!(target instanceof Element)) return false;
    // iOS 外置文字层需要 contenteditable 才能触发 WKWebView 原生选区，但它的空白区域
    // 仍应交给页面翻页热区；只有命中文字 span 时才视为文字交互。
    if (target.closest(`#${IOS_NATIVE_TEXT_OVERLAY_ID}`)) {
        return !!target.closest(`#${IOS_NATIVE_TEXT_OVERLAY_ID} .textLayer span`);
    }
    return !!target.closest('a, button, input, textarea, select, [contenteditable="true"]');
}

let mobileTurnTouchStart = null;
let mobileMultiTouchActive = false;
let mobilePinchGesture = null;
let mobileZoomPanX = 0;
let mobileZoomPanY = 0;

const IOS_NATIVE_TEXT_OVERLAY_ID = 'iosNativeTextSelectionOverlay';
const MOBILE_TEXT_LAYER_SELECTOR = `#flipbook .textLayer, #${IOS_NATIVE_TEXT_OVERLAY_ID} .textLayer`;
const MOBILE_TEXT_SPAN_SELECTOR = `#flipbook .textLayer span, #${IOS_NATIVE_TEXT_OVERLAY_ID} .textLayer span`;
let iosNativeTextOverlayObserver = null;
let iosNativeTextOverlayObservedFlipbook = null;
let iosNativeTextOverlayFrame = null;
let iosNativeTextOverlayTimer = null;
let iosNativeTextOverlayEventsBound = false;
const IOS_TEXT_SELECTION_MODE_CLASS = 'ios-native-text-selection-enabled';

function setIosNativeTextSelectionAncestorState(active) {
    document.documentElement?.classList.toggle(IOS_TEXT_SELECTION_MODE_CLASS, active);
    document.body?.classList.toggle(IOS_TEXT_SELECTION_MODE_CLASS, active);
    document.querySelector('.book-container')?.classList.toggle(IOS_TEXT_SELECTION_MODE_CLASS, active);
}

function hideIosNativeTextSelectionOverlay() {
    const overlay = document.getElementById(IOS_NATIVE_TEXT_OVERLAY_ID);
    if (!overlay) return;
    overlay.hidden = true;
    overlay.replaceChildren();
}

function findVisibleIosTextLayer(flipbook, containerRect) {
    const candidates = Array.from(flipbook.querySelectorAll('.page .textLayer'));
    let best = null;
    let bestScore = 0;
    candidates.forEach((layer) => {
        if (!layer.querySelector('span')) return;
        const page = layer.closest('.page');
        const style = page ? getComputedStyle(page) : null;
        if (!page || style?.display === 'none' || style?.visibility === 'hidden') return;
        const rect = layer.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return;
        const visibleWidth = Math.max(0,
            Math.min(rect.right, containerRect.right) - Math.max(rect.left, containerRect.left));
        const visibleHeight = Math.max(0,
            Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top));
        const score = visibleWidth * visibleHeight;
        if (score > bestScore) {
            best = { layer, rect };
            bestScore = score;
        }
    });
    return best;
}

function syncIosNativeTextSelectionOverlay() {
    iosNativeTextOverlayFrame = null;
    if (!isIOSMobileInteraction()) {
        setIosNativeTextSelectionAncestorState(false);
        hideIosNativeTextSelectionOverlay();
        return;
    }
    if (hasActiveMobileTextSelection()) return;

    const flipbook = document.getElementById('flipbook');
    const container = document.querySelector('.book-container');
    const overlay = document.getElementById(IOS_NATIVE_TEXT_OVERLAY_ID);
    if (!flipbook || !container || !overlay) return;
    if (isMobilePageFlipAnimating()) {
        overlay.hidden = true;
        scheduleIosNativeTextSelectionOverlay(180);
        return;
    }

    const containerRect = container.getBoundingClientRect();
    const visible = findVisibleIosTextLayer(flipbook, containerRect);
    if (!visible) {
        hideIosNativeTextSelectionOverlay();
        return;
    }

    const clone = visible.layer.cloneNode(true);
    clone.classList.add('ios-native-text-layer');
    clone.removeAttribute('id');
    // iOS 微信对普通绝对定位文本仍可能不建立系统选区；contenteditable 会走
    // WKWebView 的原生选择路径。通过 beforeinput 阻止编辑，只保留选择/复制能力。
    clone.setAttribute('contenteditable', 'true');
    clone.setAttribute('spellcheck', 'false');
    clone.addEventListener('beforeinput', (event) => event.preventDefault());
    clone.addEventListener('paste', (event) => event.preventDefault());
    clone.querySelectorAll('[role]').forEach((node) => node.removeAttribute('role'));
    // 不复用 PDF.js textLayer 的 transform：WKWebView 在 contenteditable + transform
    // 组合下仍可能拒绝建立选区。把每个文字 span 展平成容器坐标，保持文字顺序不变。
    clone.style.setProperty('position', 'absolute', 'important');
    clone.style.setProperty('left', '0px', 'important');
    clone.style.setProperty('top', '0px', 'important');
    clone.style.setProperty('right', 'auto', 'important');
    clone.style.setProperty('bottom', 'auto', 'important');
    clone.style.setProperty('inset', '0px auto auto 0px', 'important');
    clone.style.setProperty('width', `${containerRect.width}px`, 'important');
    clone.style.setProperty('height', `${containerRect.height}px`, 'important');
    clone.style.setProperty('transform', 'none', 'important');
    clone.style.setProperty('transform-origin', 'top left', 'important');

    const sourceSpans = Array.from(visible.layer.querySelectorAll('span'));
    const clonedSpans = Array.from(clone.querySelectorAll('span'));
    sourceSpans.forEach((sourceSpan, index) => {
        const targetSpan = clonedSpans[index];
        if (!targetSpan) return;
        const rect = sourceSpan.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            targetSpan.style.display = 'none';
            return;
        }
        const sourceStyle = getComputedStyle(sourceSpan);
        targetSpan.style.position = 'absolute';
        targetSpan.style.left = `${rect.left - containerRect.left + container.scrollLeft}px`;
        targetSpan.style.top = `${rect.top - containerRect.top + container.scrollTop}px`;
        targetSpan.style.width = `${Math.max(rect.width, 4)}px`;
        targetSpan.style.height = `${Math.max(rect.height, 10)}px`;
        targetSpan.style.fontFamily = sourceStyle.fontFamily;
        targetSpan.style.fontWeight = sourceStyle.fontWeight;
        targetSpan.style.fontStyle = sourceStyle.fontStyle;
        targetSpan.style.fontSize = `${Math.max(8, rect.height * 0.9)}px`;
        targetSpan.style.lineHeight = `${Math.max(10, rect.height)}px`;
        targetSpan.style.whiteSpace = 'pre';
        targetSpan.style.transform = 'none';
    });
    clone.querySelectorAll('br').forEach((br) => {
        br.style.position = 'absolute';
        br.style.width = '0px';
        br.style.height = '0px';
    });
    overlay.replaceChildren(clone);
    overlay.hidden = false;
}

function scheduleIosNativeTextSelectionOverlay(delay = 0) {
    if (!isIOSMobileInteraction()) return;
    if (iosNativeTextOverlayTimer != null) {
        clearTimeout(iosNativeTextOverlayTimer);
        iosNativeTextOverlayTimer = null;
    }
    const queueFrame = () => {
        if (iosNativeTextOverlayFrame != null) cancelAnimationFrame(iosNativeTextOverlayFrame);
        iosNativeTextOverlayFrame = requestAnimationFrame(syncIosNativeTextSelectionOverlay);
    };
    if (delay > 0) iosNativeTextOverlayTimer = setTimeout(queueFrame, delay);
    else queueFrame();
}

function ensureIosNativeTextSelectionOverlay() {
    if (!isIOSMobileInteraction()) return;
    setIosNativeTextSelectionAncestorState(true);
    const container = document.querySelector('.book-container');
    const flipbook = document.getElementById('flipbook');
    if (!container || !flipbook) return;

    let overlay = document.getElementById(IOS_NATIVE_TEXT_OVERLAY_ID);
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = IOS_NATIVE_TEXT_OVERLAY_ID;
        overlay.className = 'ios-native-text-selection-overlay';
        overlay.setAttribute('aria-label', 'PDF text selection');
        overlay.hidden = true;
        container.appendChild(overlay);
        bindMobileTouchEvents(overlay);
    }

    if (iosNativeTextOverlayObservedFlipbook !== flipbook) {
        iosNativeTextOverlayObserver?.disconnect();
        iosNativeTextOverlayObserver = new MutationObserver(() => {
            scheduleIosNativeTextSelectionOverlay();
        });
        iosNativeTextOverlayObserver.observe(flipbook, { childList: true, subtree: true });
        iosNativeTextOverlayObservedFlipbook = flipbook;
    }

    if (!iosNativeTextOverlayEventsBound) {
        iosNativeTextOverlayEventsBound = true;
        window.addEventListener('resize', () => scheduleIosNativeTextSelectionOverlay(), { passive: true });
        window.visualViewport?.addEventListener(
            'resize',
            () => scheduleIosNativeTextSelectionOverlay(),
            { passive: true }
        );
        window.visualViewport?.addEventListener(
            'scroll',
            () => scheduleIosNativeTextSelectionOverlay(),
            { passive: true }
        );
        container.addEventListener('scroll', () => scheduleIosNativeTextSelectionOverlay(), { passive: true });
    }
    scheduleIosNativeTextSelectionOverlay();
}

function isIosNativeTextOverlayTarget(target) {
    return target instanceof Element
        && !!target.closest(`#${IOS_NATIVE_TEXT_OVERLAY_ID} .textLayer span`);
}

function isMobileTextTarget(target) {
    return target instanceof Element && !!target.closest(MOBILE_TEXT_SPAN_SELECTOR);
}

// iOS 的原生文字选区手柄拖动可能不会把 touch 目标保持在 textLayer span 上，
// 但仍会继续冒泡到翻页区域；仅对 iOS 记录文字手势候选，避免影响 Android 翻页。
function isIOSMobileInteraction() {
    return isMobileFn() && isIOSDevice();
}

function hasActiveMobileTextSelection() {
    const selection = window.getSelection && window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    const anchor = selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement;
    const focus = selection.focusNode instanceof Element
        ? selection.focusNode
        : selection.focusNode?.parentElement;
    return !!(anchor?.closest?.(MOBILE_TEXT_LAYER_SELECTOR)
        || focus?.closest?.(MOBILE_TEXT_LAYER_SELECTOR));
}

function clearMobileLongPressTimer(gesture) {
    if (!gesture?.longPressTimer) return;
    clearTimeout(gesture.longPressTimer);
    gesture.longPressTimer = null;
}

function setMobileTextSelecting(gesture, active) {
    if (gesture) gesture.selectionMode = active;
    document.getElementById('flipbook')?.classList.toggle('mobile-text-selecting', active);
}

function normalizeTextCaret(node, offset, clientX, fallbackTarget) {
    let textNode = node;
    if (textNode?.nodeType !== Node.TEXT_NODE) {
        const nodeElement = textNode instanceof Element ? textNode : null;
        const element = nodeElement?.closest?.(MOBILE_TEXT_SPAN_SELECTOR)
            || fallbackTarget?.closest?.(MOBILE_TEXT_SPAN_SELECTOR);
        textNode = element?.childNodes
            ? Array.from(element.childNodes).find((child) => child.nodeType === Node.TEXT_NODE)
            : null;
    }
    const textLayer = textNode?.parentElement?.closest?.(MOBILE_TEXT_LAYER_SELECTOR);
    if (!textNode || !textLayer || !textNode.textContent?.length) return null;

    let caretOffset = Number.isInteger(offset) ? offset : 0;
    if (node?.nodeType !== Node.TEXT_NODE) {
        const span = textNode.parentElement;
        const rect = span?.getBoundingClientRect();
        const ratio = rect?.width > 0 ? (clientX - rect.left) / rect.width : 0;
        caretOffset = Math.round(Math.max(0, Math.min(1, ratio)) * textNode.textContent.length);
    }
    return {
        node: textNode,
        offset: Math.max(0, Math.min(textNode.textContent.length, caretOffset)),
    };
}

function getMobileTextCaret(clientX, clientY, fallbackTarget = null) {
    if (typeof document.caretPositionFromPoint === 'function') {
        const position = document.caretPositionFromPoint(clientX, clientY);
        const normalized = normalizeTextCaret(position?.offsetNode, position?.offset, clientX, fallbackTarget);
        if (normalized) return normalized;
    }
    if (typeof document.caretRangeFromPoint === 'function') {
        const range = document.caretRangeFromPoint(clientX, clientY);
        const normalized = normalizeTextCaret(range?.startContainer, range?.startOffset, clientX, fallbackTarget);
        if (normalized) return normalized;
    }

    const span = document.elementFromPoint(clientX, clientY)?.closest?.(MOBILE_TEXT_SPAN_SELECTOR)
        || fallbackTarget?.closest?.(MOBILE_TEXT_SPAN_SELECTOR);
    return normalizeTextCaret(span, null, clientX, span);
}

function compareTextCarets(first, second) {
    if (!first?.node || !second?.node) return 0;
    if (first.node === second.node) return first.offset - second.offset;
    const firstRange = document.createRange();
    const secondRange = document.createRange();
    try {
        firstRange.setStart(first.node, first.offset);
        firstRange.collapse(true);
        secondRange.setStart(second.node, second.offset);
        secondRange.collapse(true);
        return firstRange.compareBoundaryPoints(Range.START_TO_START, secondRange);
    } catch (error) {
        return 0;
    }
}

function applyMobileTextSelection(start, end) {
    if (!start?.node || !end?.node) return false;
    const selection = window.getSelection && window.getSelection();
    if (!selection) return false;
    try {
        selection.removeAllRanges();
        if (typeof selection.setBaseAndExtent === 'function') {
            selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
        } else {
            const range = document.createRange();
            if (compareTextCarets(start, end) <= 0) {
                range.setStart(start.node, start.offset);
                range.setEnd(end.node, end.offset);
            } else {
                range.setStart(end.node, end.offset);
                range.setEnd(start.node, start.offset);
            }
            selection.addRange(range);
        }
        return !selection.isCollapsed;
    } catch (error) {
        return false;
    }
}

function beginMobileTextSelection(gesture, target) {
    const caret = getMobileTextCaret(gesture.x, gesture.y, target);
    if (!caret) return false;
    const text = caret.node.textContent || '';
    if (!text.length) return false;

    // 中文按单字建立初始范围；连续拉丁字母/数字按整词建立，随后拖动可继续扩展。
    let startOffset = Math.min(caret.offset, text.length - 1);
    let endOffset = startOffset + 1;
    const wordChar = /[A-Za-z0-9_]/;
    if (wordChar.test(text[startOffset] || '')) {
        while (startOffset > 0 && wordChar.test(text[startOffset - 1])) startOffset--;
        while (endOffset < text.length && wordChar.test(text[endOffset])) endOffset++;
    }
    gesture.selectionStart = { node: caret.node, offset: startOffset };
    gesture.selectionEnd = { node: caret.node, offset: endOffset };
    return applyMobileTextSelection(gesture.selectionStart, gesture.selectionEnd);
}

function extendMobileTextSelection(gesture, clientX, clientY, target) {
    if (!gesture?.selectionStart || !gesture.selectionEnd) return false;
    const caret = getMobileTextCaret(clientX, clientY, target);
    if (!caret) return false;
    if (compareTextCarets(caret, gesture.selectionStart) < 0) {
        return applyMobileTextSelection(gesture.selectionEnd, caret);
    }
    if (compareTextCarets(caret, gesture.selectionEnd) > 0) {
        return applyMobileTextSelection(gesture.selectionStart, caret);
    }
    return applyMobileTextSelection(gesture.selectionStart, gesture.selectionEnd);
}

function getMobileTouchMidpoint(touches) {
    if (!touches || touches.length < 2) return null;
    return {
        x: (touches[0].clientX + touches[1].clientX) / 2,
        y: (touches[0].clientY + touches[1].clientY) / 2,
    };
}

function getMobileTouchDistance(touches) {
    if (!touches || touches.length < 2) return 0;
    return Math.hypot(
        touches[1].clientX - touches[0].clientX,
        touches[1].clientY - touches[0].clientY,
    );
}

function getMobileZoomBounds(zoom = store.currentZoom) {
    const container = document.querySelector('.book-container');
    const width = container?.clientWidth || 0;
    const height = container?.clientHeight || 0;
    return {
        minX: Math.min(0, width - width * zoom),
        maxX: 0,
        minY: Math.min(0, height - height * zoom),
        maxY: 0,
    };
}

function clampMobileZoomPan(zoom = store.currentZoom) {
    const bounds = getMobileZoomBounds(zoom);
    mobileZoomPanX = Math.min(bounds.maxX, Math.max(bounds.minX, mobileZoomPanX));
    mobileZoomPanY = Math.min(bounds.maxY, Math.max(bounds.minY, mobileZoomPanY));
}

function renderMobileContentZoom() {
    const wrap = document.getElementById('zoomWrap');
    const container = document.querySelector('.book-container');
    if (!wrap || !container) return;
    const zoomed = store.currentZoom > 1.001;
    if (!zoomed) {
        mobileZoomPanX = 0;
        mobileZoomPanY = 0;
        wrap.style.transform = '';
    } else {
        clampMobileZoomPan();
        wrap.style.transform = `translate3d(${mobileZoomPanX}px, ${mobileZoomPanY}px, 0) scale(${store.currentZoom})`;
    }
    container.classList.toggle('mobile-content-zoomed', zoomed);
}

function resetMobileContentZoom() {
    if (!isMobileFn()) return;
    cancelPendingZoomRender();
    store.currentZoom = MIN_ZOOM;
    mobileZoomPanX = 0;
    mobileZoomPanY = 0;
    renderMobileContentZoom();
    document.getElementById('flipbook')?.removeAttribute('data-zoom-render-ready');
    restoreBaseCanvasesAfterZoom();
    scheduleIosNativeTextSelectionOverlay();
}

function beginMobilePinch(touches) {
    const midpoint = getMobileTouchMidpoint(touches);
    const distance = getMobileTouchDistance(touches);
    const container = document.querySelector('.book-container');
    const rect = container?.getBoundingClientRect();
    if (!midpoint || !rect || distance <= 0) return false;
    const startZoom = Math.max(MIN_ZOOM, Number(store.currentZoom) || MIN_ZOOM);
    mobilePinchGesture = {
        startDistance: distance,
        startZoom,
        localX: (midpoint.x - rect.left - mobileZoomPanX) / startZoom,
        localY: (midpoint.y - rect.top - mobileZoomPanY) / startZoom,
    };
    hideIosNativeTextSelectionOverlay();
    return true;
}

function updateMobilePinch(touches) {
    if (!mobilePinchGesture && !beginMobilePinch(touches)) return;
    const midpoint = getMobileTouchMidpoint(touches);
    const distance = getMobileTouchDistance(touches);
    const container = document.querySelector('.book-container');
    const rect = container?.getBoundingClientRect();
    if (!midpoint || !rect || distance <= 0) return;
    const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, mobilePinchGesture.startZoom * distance / mobilePinchGesture.startDistance),
    );
    store.currentZoom = nextZoom;
    mobileZoomPanX = midpoint.x - rect.left - mobilePinchGesture.localX * nextZoom;
    mobileZoomPanY = midpoint.y - rect.top - mobilePinchGesture.localY * nextZoom;
    renderMobileContentZoom();
    cancelPendingZoomRender();
    document.getElementById('flipbook')?.removeAttribute('data-zoom-render-ready');
}

function finishMobilePinch() {
    mobilePinchGesture = null;
    if (store.currentZoom <= 1.01) {
        resetMobileContentZoom();
        return;
    }
    scheduleZoomRender(store.currentZoom, true);
    scheduleIosNativeTextSelectionOverlay(120);
}

function panMobileZoomedContent(gesture, touch) {
    if (!gesture?.contentZoomed) return false;
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (Math.hypot(dx, dy) <= MOBILE_GESTURE_MOVE_TOLERANCE) return false;
    gesture.moved = true;
    clearMobileLongPressTimer(gesture);

    // 已在左右边缘继续向外滑时保留翻页动作，其余方向用于查看放大内容。
    if (Math.abs(dx) > Math.abs(dy) * 1.2 && shouldTurnAtMobileContentZoom(gesture, dx, dy)) {
        return true;
    }
    mobileZoomPanX = gesture.panX + dx;
    mobileZoomPanY = gesture.panY + dy;
    renderMobileContentZoom();
    hideIosNativeTextSelectionOverlay();
    return true;
}

function handleMobileBookTouchStart(event) {
    if (!isMobileFn()) return;
    // 插入页属于后台增强；用户连续操作期间不要触发重建抢占翻页。
    store.__lastUserInteractionAt = performance.now();
    store.__hasUserInteracted = true;
    if (event.touches.length > 1) {
        // 双指仅缩放阅读区；取消单指翻页，避免最后一根手指抬起时被当成点击。
        mobileMultiTouchActive = true;
        beginMobilePinch(event.touches);
        clearMobileLongPressTimer(mobileTurnTouchStart);
        mobileTurnTouchStart = null;
        document.getElementById('flipbook')?.classList.remove('mobile-text-selecting');
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        return;
    }
    if (mobileMultiTouchActive || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const startedOnText = isMobileTextTarget(event.target);
    const startedOnIosOverlay = isIOSMobileInteraction() && isIosNativeTextOverlayTarget(event.target);
    const iosInteraction = isIOSMobileInteraction();
    const gesture = {
        x: touch.clientX,
        y: touch.clientY,
        interactive: isInteractiveBookTarget(event.target),
        startedOnText,
        iosTextCandidate: iosInteraction && (startedOnText || startedOnIosOverlay),
        selectionMode: hasActiveMobileTextSelection(),
        moved: false,
        contentZoom: getMobileContentZoomPanState(),
        contentZoomed: isMobileContentZoomed(),
        panX: mobileZoomPanX,
        panY: mobileZoomPanY,
        longPressTimer: null,
        selectionStart: null,
        selectionEnd: null,
    };
    mobileTurnTouchStart = gesture;
    if (gesture.selectionMode) {
        // iOS 的原生选区手柄依赖完整的触摸事件序列。此处只让自定义翻页逻辑
        // 退出，不在捕获阶段截断事件，避免微信 WKWebView 收不到拖动手柄事件。
        if (iosInteraction) {
            setMobileTextSelecting(gesture, true);
            return;
        }
        const selection = window.getSelection && window.getSelection();
        if (selection?.rangeCount) {
            const range = selection.getRangeAt(0);
            if (range.startContainer?.nodeType === Node.TEXT_NODE
                && range.endContainer?.nodeType === Node.TEXT_NODE) {
                gesture.selectionStart = { node: range.startContainer, offset: range.startOffset };
                gesture.selectionEnd = { node: range.endContainer, offset: range.endOffset };
            }
        }
        setMobileTextSelecting(gesture, true);
        // 已有选择范围时，后续拖动属于调整选择手柄，不允许 PageFlip 接管这次触摸。
        event.stopImmediatePropagation();
        event.stopPropagation();
    } else if (gesture.startedOnText || startedOnIosOverlay) {
        gesture.longPressTimer = setTimeout(() => {
            if (mobileTurnTouchStart !== gesture || gesture.moved) return;
            gesture.longPressTimer = null;
            // iOS 先保留系统选区；若 WebKit 没有建立选区，再用 Range 兜底，
            // 让 Safari 与微信内置 WebView 都能出现可复制的文字选区。
            const selected = hasActiveMobileTextSelection()
                || beginMobileTextSelection(gesture, event.target);
            if (selected) setMobileTextSelecting(gesture, true);
        }, MOBILE_LONG_PRESS_DELAY);
    }
}

function handleMobileBookTouchMove(event) {
    if (!isMobileFn()) return;
    if (mobileMultiTouchActive || event.touches.length > 1) {
        if (event.touches.length > 1) mobileMultiTouchActive = true;
        if (event.touches.length > 1) updateMobilePinch(event.touches);
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        return;
    }
    if (!mobileTurnTouchStart || event.touches.length !== 1) return;
    const activeTextSelection = hasActiveMobileTextSelection();
    if (!mobileTurnTouchStart.selectionMode && !activeTextSelection
        && panMobileZoomedContent(mobileTurnTouchStart, event.touches[0])) {
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        return;
    }
    if (isIOSMobileInteraction() && isIosNativeTextOverlayTarget(event.target)) {
        const touch = event.touches[0];
        const dx = touch.clientX - mobileTurnTouchStart.x;
        const dy = touch.clientY - mobileTurnTouchStart.y;
        if (Math.hypot(dx, dy) > MOBILE_GESTURE_MOVE_TOLERANCE) {
            mobileTurnTouchStart.moved = true;
            clearMobileLongPressTimer(mobileTurnTouchStart);
        }
        // 不截断 overlay 事件，让 WKWebView 继续处理长按选区和选择手柄拖动。
        return;
    }
    if (isIOSMobileInteraction()
        && (mobileTurnTouchStart.iosTextCandidate
            || mobileTurnTouchStart.selectionMode
            || activeTextSelection)) {
        const touch = event.touches[0];
        const dx = touch.clientX - mobileTurnTouchStart.x;
        const dy = touch.clientY - mobileTurnTouchStart.y;
        if (Math.hypot(dx, dy) > MOBILE_GESTURE_MOVE_TOLERANCE) {
            mobileTurnTouchStart.moved = true;
            clearMobileLongPressTimer(mobileTurnTouchStart);
        }
        // iOS Safari / 微信 WebView 的选区和拖动手柄需要收到完整触摸序列。
        // PageFlip 的原生触摸已禁用，此处仅 return 跳过自定义翻页，不截断事件。
        return;
    }
    if (mobileTurnTouchStart.selectionMode || activeTextSelection) {
        setMobileTextSelecting(mobileTurnTouchStart, true);
        const touch = event.touches[0];
        extendMobileTextSelection(mobileTurnTouchStart, touch.clientX, touch.clientY, event.target);
        // 选择状态由当前逻辑维护范围；阻止浏览器滚动和 PageFlip 横滑翻页。
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        return;
    }
    const touch = event.touches[0];
    const dx = touch.clientX - mobileTurnTouchStart.x;
    const dy = touch.clientY - mobileTurnTouchStart.y;
    if (Math.hypot(dx, dy) > MOBILE_GESTURE_MOVE_TOLERANCE) {
        mobileTurnTouchStart.moved = true;
        clearMobileLongPressTimer(mobileTurnTouchStart);
    }
    // 放大内容中只有从左右边缘继续向外滑动才翻页，其余滑动用于平移内容。
    if (Math.abs(dx) > MOBILE_GESTURE_MOVE_TOLERANCE
        && Math.abs(dx) > Math.abs(dy) * 1.2
        && shouldTurnAtMobileContentZoom(mobileTurnTouchStart, dx, dy)) {
        event.preventDefault();
    }
}

function getVisibleMobilePageRect(fb) {
    const visiblePages = Array.from(fb.querySelectorAll('.page')).map((page) => ({
        display: getComputedStyle(page).display,
        rect: page.getBoundingClientRect(),
    })).filter(({ display, rect }) => display !== 'none' && rect.width > 20 && rect.height > 20);
    if (visiblePages.length > 0) {
        visiblePages.sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
        return visiblePages[0].rect;
    }
    return fb.getBoundingClientRect();
}

    // 插入页后台重建可能与移动端手势重叠；在短窗口内持续重试，避免一次性重试仍落在锁内而丢失翻页。
function retryMobileTurn(turn) {
    store.__mobileTurnPending = true;
    let attempts = 0;
    const attempt = () => {
        if (turn()) {
            store.__mobileTurnPending = false;
            return;
        }
        if (++attempts < 50) setTimeout(attempt, 80);
    };
    attempt();
}

function isMobileContentZoomed() {
    return isMobileFn() && store.currentZoom > 1.01;
}

// 阅读区放大后，只有已经平移到对应边缘时，继续向外滑动才交给翻页。
function getMobileContentZoomPanState() {
    if (!isMobileContentZoomed()) return null;
    const bounds = getMobileZoomBounds();
    return {
        atLeft: mobileZoomPanX >= bounds.maxX - MOBILE_ZOOM_EDGE_EPSILON,
        atRight: mobileZoomPanX <= bounds.minX + MOBILE_ZOOM_EDGE_EPSILON,
    };
}

window.__getMobileContentZoomPanState = getMobileContentZoomPanState;

function shouldTurnAtMobileContentZoom(gesture, dx, dy) {
    const zoomState = gesture?.contentZoom || getMobileContentZoomPanState();
    if (!zoomState) return true;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX < MOBILE_GESTURE_MOVE_TOLERANCE || absX <= absY * 1.2) return false;
    // 手指左滑会把视觉视口推向右边；手指右滑会把视觉视口推向左边。
    return dx < 0 ? zoomState.atRight : zoomState.atLeft;
}

let pendingMobilePageView = null;
let pendingMobilePageViewTimer = null;
const MOBILE_TURN_QUEUE_LIMIT = 4;
const MOBILE_TURN_QUEUE_WAIT_MS = 80;
const MOBILE_TURN_QUEUE_TIMEOUT_MS = 8000;
let mobileTurnQueue = [];
let mobileTurnQueueDrainTimer = null;
let mobileTurnQueueWaitingSince = 0;

function clearPendingMobilePageView(pending = pendingMobilePageView, clearTrigger = false) {
    if (!pending || pending !== pendingMobilePageView) return;
    pendingMobilePageView = null;
    if (pendingMobilePageViewTimer != null) {
        clearTimeout(pendingMobilePageViewTimer);
        pendingMobilePageViewTimer = null;
    }
    if (clearTrigger) clearJumpTrigger();
}

function setPendingMobilePageView(fromIndex, targetIndex) {
    if (!Number.isInteger(fromIndex) || !Number.isInteger(targetIndex) || fromIndex === targetIndex) return;
    clearPendingMobilePageView();
    const pending = { fromIndex, targetIndex };
    pendingMobilePageView = pending;
    // PageFlip 异常中断时不保留已失效的触摸触发来源，避免污染下一次翻页。
    pendingMobilePageViewTimer = setTimeout(() => clearPendingMobilePageView(pending, true), 2500);
}

function scheduleMobileTurnQueueDrain(delay = MOBILE_TURN_QUEUE_WAIT_MS) {
    if (mobileTurnQueueDrainTimer != null || mobileTurnQueue.length === 0) return;
    mobileTurnQueueDrainTimer = setTimeout(() => {
        mobileTurnQueueDrainTimer = null;
        drainMobileTurnQueue();
    }, Math.max(0, delay));
}

function drainMobileTurnQueue() {
    if (mobileTurnQueue.length === 0) {
        mobileTurnQueueWaitingSince = 0;
        return;
    }
    if (!isMobileFn()) {
        mobileTurnQueue = [];
        mobileTurnQueueWaitingSince = 0;
        return;
    }
    if (!store.pageFlip || store.isRebuilding || isMobilePageFlipAnimating()) {
        if (!mobileTurnQueueWaitingSince) mobileTurnQueueWaitingSince = performance.now();
        // 异常情况下 PageFlip 没有回到 read 状态时，丢弃积压请求但保留页面可操作。
        if (performance.now() - mobileTurnQueueWaitingSince >= MOBILE_TURN_QUEUE_TIMEOUT_MS) {
            mobileTurnQueue = [];
            mobileTurnQueueWaitingSince = 0;
            return;
        }
        scheduleMobileTurnQueueDrain();
        return;
    }

    mobileTurnQueueWaitingSince = 0;
    const next = mobileTurnQueue.shift();
    if (!startMobileTurn(next.direction, next.corner)) {
        // Retry if the flip state changed between the guard and the start call.
        mobileTurnQueue.unshift(next);
    }
    if (mobileTurnQueue.length > 0) scheduleMobileTurnQueueDrain();
}

function startMobileTurn(direction, corner) {
    const pageFlip = store.pageFlip;
    if (!pageFlip || store.isRebuilding) return false;

    const pageCount = pageFlip.getPageCount?.() || 1;
    const current = pageFlip.getCurrentPageIndex?.() ?? 0;
    const delta = direction === 'next' ? 1 : -1;
    const target = Math.max(0, Math.min(pageCount - 1, current + delta));
    const canTurn = target !== current;
    if (canTurn) setPendingMobilePageView(current, target);

    if (isMobileContentZoomed() && pageFlip.turnToPage) {
        if (isMobilePageFlipAnimating()) return false;
        if (canTurn) pageFlip.turnToPage(target);
        return true;
    }

    try {
        if (direction === 'next') pageFlip.flipNext(corner);
        else pageFlip.flipPrev(corner);
    } catch (error) {
        clearPendingMobilePageView(undefined, true);
        return false;
    }
    return true;
}

// 内容放大时跳过 PageFlip 的 3D 翻页动画，避免缩放合成层与卷页阴影互相刷新。
// 未放大时保留原有动画；放大状态下仍通过 PageFlip 定位，确保 flip 事件链继续同步页码和目录。
function turnMobilePage(direction, corner) {
    const pageFlip = store.pageFlip;
    if (!pageFlip || store.isRebuilding) return false;

    // PageFlip 在动画中再次调用 flipNext/flipPrev 会强制结束当前动画，
    // 连续滑动时容易留下半翻页面。改为排队，等当前动画回到 read 状态后再执行。
    if (isMobilePageFlipAnimating()) {
        if (mobileTurnQueue.length < MOBILE_TURN_QUEUE_LIMIT) {
            mobileTurnQueue.push({ direction, corner });
            scheduleMobileTurnQueueDrain();
        }
        return true;
    }

    return startMobileTurn(direction, corner);
}

function handleMobileBookTouchEnd(event) {
    if (!isMobileFn()) return;
    if (mobileMultiTouchActive) {
        if (event.touches.length < 2 && mobilePinchGesture) finishMobilePinch();
        if (event.touches.length === 0) mobileMultiTouchActive = false;
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
        return;
    }
    if (!mobileTurnTouchStart || event.changedTouches.length !== 1) return;
    const start = mobileTurnTouchStart;
    clearMobileLongPressTimer(start);
    mobileTurnTouchStart = null;
    const activeTextSelection = hasActiveMobileTextSelection();
    if (isIOSMobileInteraction()
        && (start.iosTextCandidate || start.selectionMode || activeTextSelection)) {
        // iOS 的原生选择菜单由 WebKit 在 touchend 后建立；不要在捕获阶段阻断它。
        requestAnimationFrame(() => {
            document.getElementById('flipbook')?.classList.remove('mobile-text-selecting');
        });
        return;
    }
    if (start.selectionMode || activeTextSelection) {
        // 非 iOS 仍由现有脚本选择逻辑维护范围，阻止 PageFlip 接管本次 touchend。
        event.stopImmediatePropagation();
        event.stopPropagation();
        requestAnimationFrame(() => {
            document.getElementById('flipbook')?.classList.remove('mobile-text-selecting');
        });
        return;
    }
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const fb = document.getElementById('flipbook');
    const rect = fb ? getVisibleMobilePageRect(fb) : null;
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const corner = touch.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';

    if (absX >= MOBILE_SWIPE_DISTANCE && absX > absY * 1.2
        && shouldTurnAtMobileContentZoom(start, dx, dy)) {
        event.preventDefault();
        event.stopPropagation();
        // 横向滑动统一使用 bottom 锚点，避免手指位于页面上半区时出现向下坠落的视觉轨迹。
        const turn = () => {
            if (!store.pageFlip || store.isRebuilding) return false;
            hasUserFlipIntent = true;
            setJumpTrigger('touch');
            return turnMobilePage(dx < 0 ? 'next' : 'prev', 'bottom');
        };
        retryMobileTurn(turn);
        return;
    }

    if (start.contentZoomed && start.moved) return;

    // A stationary tap is a page-turn gesture only inside one of the four corner hot zones.
    if (Math.hypot(dx, dy) > MOBILE_GESTURE_MOVE_TOLERANCE
        || start.interactive || isInteractiveBookTarget(event.target)) return;
    if (!isPointInPageCorner(touch.clientX, touch.clientY, rect)) return;
    event.preventDefault();
    event.stopPropagation();
    const side = touch.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
    const turn = () => {
        if (!store.pageFlip || store.isRebuilding) return false;
        hasUserFlipIntent = true;
        setJumpTrigger('touch');
        const current = store.pageFlip.getCurrentPageIndex?.() ?? 0;
        const turnCorner = side === 'right' && current === 0 ? 'bottom' : corner;
        return turnMobilePage(side === 'left' ? 'prev' : 'next', turnCorner);
    };
    retryMobileTurn(turn);
}

function handleMobileBookTouchCancel() {
    clearMobileLongPressTimer(mobileTurnTouchStart);
    mobileTurnTouchStart = null;
    mobileMultiTouchActive = false;
    if (mobilePinchGesture) finishMobilePinch();
    document.getElementById('flipbook')?.classList.remove('mobile-text-selecting');
}

function bindMobilePageTurning(fb) {
    if (!fb) return;
    fb.classList.toggle('ios-mobile-text-select', isIOSMobileInteraction());
    ensureIosNativeTextSelectionOverlay();
    bindMobileTouchEvents(fb);
}

function bindMobileTouchEvents(target) {
    if (!target) return;
    // 外置 iOS 文字层是 #flipbook 的兄弟节点，事件不会冒泡到翻页器；两者共用
    // 同一组稳定函数，浏览器会自动去重，重建后重复调用仍保持幂等。
    target.addEventListener('touchstart', handleMobileBookTouchStart, { passive: false, capture: true });
    target.addEventListener('touchmove', handleMobileBookTouchMove, { passive: false, capture: true });
    target.addEventListener('touchend', handleMobileBookTouchEnd, { passive: false, capture: true });
    target.addEventListener('touchcancel', handleMobileBookTouchCancel, { passive: true, capture: true });
}

// PC 页面本体普通点击不翻页；双击缩放由独立的 dblclick 监听处理。
function handlePcBookClick(event) {
    if (isMobileFn() || isInteractiveBookTarget(event.target)) return;
    store.__lastUserInteractionAt = performance.now();
    store.__hasUserInteracted = true;
    // 箭头、滑块和其他显式控件仍通过各自事件完成翻页。
    cancelPendingPcFlipClick();
}

function handlePcBookDoubleClick(event) {
    if ((window.__app && window.__app.isMobile) || !store.pdf || !store.pageFlip) return;
    if (isInteractiveBookTarget(event.target)) return;

    cancelPendingPcFlipClick();
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    togglePcBookZoom({ clientX: event.clientX, clientY: event.clientY });

    // 浏览器默认双击会选中 PDF 文本；本次手势用于缩放，清除该临时选区。
    const selection = window.getSelection && window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
}

function togglePcBookZoom(focusPoint = null) {
    if ((window.__app && window.__app.isMobile) || !store.pdf || !store.pageFlip) return;
    const targetZoom = store.currentZoom > MIN_ZOOM ? MIN_ZOOM : DOUBLE_CLICK_ZOOM;
    const zoomFocus = targetZoom > store.currentZoom ? captureZoomFocusPoint(focusPoint) : null;
    applyZoom(targetZoom - store.currentZoom, zoomFocus);
}

function bindBoundaryGuard() {
    const fb = document.getElementById('flipbook');
    if (!fb) return;
    bindMobilePageTurning(fb);
    // 使用稳定函数引用；重建后重复调用 addEventListener 时浏览器会自动去重。
    fb.addEventListener('click', handlePcBookClick, true);
    fb.addEventListener('dblclick', handlePcBookDoubleClick, true);
    updatePcPageArrowState();
}

// 翻页事件统一绑定（首次建立与重建实例后都会调用，确保 TOC/缩略图/搜索/滑块/埋点同步不丢）。
// lastFlipData：记录上一次 flip 事件的物理索引。page-flip 的 update()/turnToPage() 会触发
// e.data 与当前页相同的「定位刷新帧」（非真实翻页），据此跳过 orientation 同步，避免连锁重建。
let lastFlipData = null;
let hasUserFlipIntent = false;
let lastScreenLeftPageNum = null;
let lastScreenRightPageNum = null;
function bindFlipEvents() {
    let flipEventCount = 0;
    let isFirstFlipEvent = true;
    if (lastScreenLeftPageNum == null) {
        lastScreenLeftPageNum = 1;
    }
    store.pageFlip.on('flip', (e) => {
        const isRepeatFrame = (e.data === lastFlipData); // 非真实翻页（定位/刷新帧）
        const wasFirst = isFirstFlipEvent;
        isFirstFlipEvent = false;
        lastFlipData = e.data;
        store.currentPageIndex = e.data;
        updatePcPageArrowState();
        hideIosNativeTextSelectionOverlay();
        scheduleIosNativeTextSelectionOverlay(900);
        setTimeout(updatePcPageArrowState, 850);
        setTimeout(updatePcPageArrowState, 1400);
        scheduleZoomRenderAfterPageTurn();
        // 移动端手势和程序跳页也在进入对应 spread 时激活插入页。
        activateInsertFramesNear(e.data, store.currentOrientation === 'double' ? 1 : 0);
        // 页码一律以「真实 PDF 页号」为准（插入页返回前一 PDF 页号），保证页码不变。
        const currentPage = pdfPageAt(e.data);
        updateActiveTOC(currentPage);
        const self = window.__app;

        // 翻页过程中自动跟随 orientation：离开首/尾页→双页；进入首/尾页→单页居中。
        // 注意：rebuildTo 内部会再次 flip 触发本回调，但重建后 currentOrientation 已更新，
        // 且 isRebuilding 锁会拦截重建中的重入，故不会无限循环。
        // 单页模式给偶数页书追加了透明空白尾页（data-blank=1），它不是真实页，
        // 翻到它/从它翻出都不应触发 orientation 同步。
        if (isBlankPageAt(e.data)) return;
        // 跨 orientation 重建后播放的「单页→双页」动画 flip 事件：跳过 orientation 同步，
        // 避免动画中途被「离开首/尾页」判定误触发再次重建，导致跳右/回中/闪烁。
        // 同时跳过「非真实翻页帧」（update/turnToPage 触发的 e.data 与上次相同的定位刷新），
        // 这是连锁 rebuildTo(single) 的根本来源。
        if (!store.__animatingFlip && !isRepeatFrame) {
            const targetCentered = isCenteredIndex(e.data);
            const curSingle = store.currentOrientation === 'single';
            // 重建后首次定位 flip（及动画残余帧）不触发 orientation 重判，避免单页模式
            // flip(57) 的动画序列被误判为"离开尾页"而回退双页。justRebuilt 一次性消费。
            if (store.justRebuilt) {
                store.justRebuilt = false;
            } else if (!store.isRebuilding && store.pdf) {
                // 首/尾页进入、离开均由显式翻页入口预判式重建，这里仅保留 orientation 同步：
                if (targetCentered && !curSingle) {
                    rebuildTo('single', e.data);
                } else if (!targetCentered && curSingle) {
                    rebuildTo('double', e.data);
                }
                // 注：尾页右侧向后翻再回弹尾页的兜底已移除——翻页改由 handleFl ickClick 接管，
                // 不再会翻到透明空白尾页，尾页与首页路径完全对称、同等干脆。
            }
        }
        if (self && self.updateActiveThumbnail) self.updateActiveThumbnail(currentPage);
        flipEventCount++;
        if (flipEventCount > 1) hideFlipHint();
        if (store.currentSearchKeyword) {
            highlightSearchOnVisiblePages(currentPage);
        }
        // 滑动条表示当前屏幕中可继续阅读到的真实 PDF 页；若当前物理页是插入页，
        // 取其后方第一张 PDF 页，避免首页后的插入页仍显示 1 / 58。
        syncPageSlider(pdfPageForSlider(e.data));
        // pdf_page_view：真实翻页才上报。PC 双页每屏左右各一条，移动端每屏一条。
        // 插入页可能与前一物理页映射到同一个 PDF 页号；是否真实翻页应以物理索引变化为准。
        const mobilePending = isMobileFn() ? pendingMobilePageView : null;
        // PageFlip 在首次触摸翻页时可能先补发当前页的刷新帧。待目标物理页真正落位后再上报，
        // 避免把首页（索引 0）错误记为“首页 -> 第 2 页”的结果。
        const waitingForMobileTarget = mobilePending && e.data !== mobilePending.targetIndex;
        if (!store.__suppressAnimatedPageView
            && !isRepeatFrame && !isBlankPageAt(e.data) && !(wasFirst && !hasUserFlipIntent)
            && !waitingForMobileTarget) {
            const total = store.renderedPageCount || store.pageFlip.getPageCount?.() || store.totalPages || currentPage;
            const isSingleMode = isMobileFn() || store.currentOrientation === 'single';
            const leftIdx = isSingleMode ? e.data
                : (store.coverCentered
                    ? (e.data % 2 === 1 ? e.data : e.data - 1)
                    : (e.data % 2 === 0 ? e.data : e.data - 1));
            const rightIdx = isSingleMode ? null : leftIdx + 1;
            const hasRight = rightIdx != null && rightIdx < total;
            // 埋点按翻页序列的物理页码上报（物理索引 + 1）；插入页也占一个物理页码。
            const leftPageNum = leftIdx + 1;
            const rightPageNum = hasRight ? rightIdx + 1 : null;
            const leftFrom = mobilePending ? mobilePending.fromIndex + 1 : (lastScreenLeftPageNum ?? leftPageNum);
            const rightFrom = lastScreenRightPageNum ?? leftFrom;
            const duration = measurePrevPageStayMs();
            const trigger = peekJumpTrigger();
            setCommonTitle(rightPageNum != null ? `${leftPageNum}_${rightPageNum}` : String(leftPageNum));
            trackPdfPageView({ pageNum: leftPageNum, fromPageNum: leftFrom, toPageNum: leftPageNum, trigger, durationMs: duration });
            if (rightPageNum != null) {
                trackPdfPageView({ pageNum: rightPageNum, fromPageNum: rightFrom, toPageNum: rightPageNum, trigger, durationMs: duration });
            }
            clearJumpTrigger();
            if (mobilePending) clearPendingMobilePageView(mobilePending);
            lastScreenLeftPageNum = leftPageNum;
            lastScreenRightPageNum = rightPageNum;
            markPageStayStart();
        }
        // 放大态翻页保持当前倍率；动画完成后的延迟定位会同步新页面边界。
        if (store.currentZoom > 1) schedulePcPageArrowPosition({ reset: true });
    });
    // 每次（含重建）重新绑定边界屏蔽守卫（浏览器对同函数同选项去重，不会重复）
    bindBoundaryGuard();
}

/**
 * 绑定「插入页 iframe 内链接」的跨文档跳转。
 *
 * 插入页是独立 <iframe> 文档，其内部 <a data-goto-page="N"> 点击后无法自己翻外层 PDF，
 * 只能通过 parent.postMessage 把目标 PDF 原始页码发回父窗口。这里监听 message，
 * 用 pdfPageToFlipIndex() 换算成物理索引后调用 store.pageFlip.flip(index) 完成跳转。
 *
 * 注意：
 *   - 只认 { type: 'gotoPdfPage', page } 消息，page 为 PDF 原始页码（从 1 开始）。
 *   - 用 '*' 来源（同源 POC 场景）；生产可收紧为具体 origin。
 *   - flip 是惰性的：若目标页与当前页同 orientation 直接翻，否则由库/orientation 逻辑处理。
 */
function bindInsertPageLinks() {
    if (window.__insertLinkBound) return; // 只绑一次，避免重复 flip
    window.__insertLinkBound = true;
    window.addEventListener('message', (e) => {
        let msg = e.data;
        if (typeof msg !== 'object' || msg === null) return;
        // PC 插入页位于独立 iframe，dblclick 不会冒泡到父页面；由 iframe 转发后复用同一缩放切换。
        if (msg.type === 'insert-double-click-zoom') {
            cancelPendingPcFlipClick();
            const clientX = Number(msg.clientX);
            const clientY = Number(msg.clientY);
            const focusPoint = Number.isFinite(clientX) && Number.isFinite(clientY)
                ? { clientX, clientY }
                : null;
            togglePcBookZoom(focusPoint);
            return;
        }
        // iframe 内容页的触摸事件不会冒泡到 #flipbook；由同源手势桥转成父页面坐标，
        // 继续复用阅读区内部缩放，因此顶部工具栏和底部滑轨仍保持固定尺寸。
        if (msg.type === 'insert-content-pinch') {
            if (!isMobileFn()) return;
            if (msg.phase === 'start') {
                mobileMultiTouchActive = true;
                beginMobilePinch(msg.touches);
            } else if (msg.phase === 'move') {
                mobileMultiTouchActive = true;
                updateMobilePinch(msg.touches);
            } else if (msg.phase === 'end') {
                if (mobilePinchGesture) finishMobilePinch();
                mobileMultiTouchActive = false;
            }
            return;
        }
        // 手机端插入页 iframe 内左右滑动或四角点击 -> 通知父窗口翻页。
        if (msg.type === 'insert-swipe' || msg.type === 'insert-corner-tap') {
            if (!isMobileFn()) return;
            const corner = msg.type === 'insert-corner-tap' && msg.corner === 'top' ? 'top' : 'bottom';
            if (msg.direction !== 'next' && msg.direction !== 'prev') return;
            store.__lastUserInteractionAt = performance.now();
            store.__hasUserInteracted = true;
            const turn = () => {
                if (!store.pageFlip || store.isRebuilding) return false;
                hasUserFlipIntent = true;
                setJumpTrigger('touch');
                return turnMobilePage(msg.direction, corner);
            };
            // 与普通 PDF 页手势一致：插入页恰逢后台重建时保留用户意图，避免消息被静默丢弃。
            retryMobileTurn(turn);
            return;
        }
        if (msg.type === 'insert-link-click') {
            const currentIndex = store.pageFlip?.getCurrentPageIndex?.() ?? 0;
            track('click_link_in_page', {
                title: msg.link_text || msg.link_url || '',
                url: msg.link_url || '',
                page_url: (typeof location !== 'undefined' ? location.href : ''),
                link_url: msg.link_url || '',
                link_text: msg.link_text || '',
                link_type: msg.link_type || 'insert-html',
                page_num: pdfPageAt(currentIndex),
            });
            return;
        }
        if (msg.type !== 'gotoPdfPage') return;
        const pdfPage = parseInt(msg.page, 10);
        if (!Number.isFinite(pdfPage) || pdfPage < 1) return;
        if (!store.pageFlip || typeof store.pageFlip.flip !== 'function') return;
        const index = pdfPageToFlipIndex(pdfPage);
        console.log('[insert-link] 跳转 PDF 第', pdfPage, '页 -> 物理索引', index);
        hasUserFlipIntent = true;
        setJumpTrigger('toc');
        // flip 到目标物理索引；若需要切换 orientation（首/尾页），由显式翻页入口逻辑接管
        store.pageFlip.flip(index);
    });
}

// ========== 插入页页码映射（物理索引 <-> 真实 PDF 页号） ==========
// 插入 iframe 页后，翻页器的物理索引与「真实 PDF 页号」不再一一对应：
//   - PDF 页 .page 有 data-page-num（真实页号）；
//   - 插入页 .page 无 data-page-num（且 data-inserted=1）。
// 显示层、首/尾页居中、goto/滑块等一律以「真实 PDF 页号」为准，保证页码不变；
// 翻页器内部用物理索引。以下两个函数负责转换。

/**
 * 物理索引 -> 真实 PDF 页号。
 * 插入页无真实页号，返回「其前一个真实 PDF 页号」（保证下游页码显示连续、不越界）；
 * 首页前插入时无前页，返回 1。
 * @param {number} index 物理索引（0-based，相对 #flipbook 内全部 .page）
 * @returns {number} 真实 PDF 页号（≥1）
 */
function pdfPageAt(index) {
    const fb = document.getElementById('flipbook');
    if (!fb) return index + 1;
    const pages = fb.querySelectorAll('.page');
    if (!pages[index]) return index + 1;
    for (let k = index; k >= 0; k--) {
        const num = pages[k] && pages[k].dataset ? pages[k].dataset.pageNum : undefined;
        if (num) return parseInt(num, 10);
    }
    return 1;
}

/**
 * 真实 PDF 页号 -> 物理索引（0-based）。
 * 若找不到该页（超出），钳制到有效物理索引范围。
 * @param {number} pdfNum 真实 PDF 页号（≥1）
 * @returns {number} 物理索引
 */
function pdfPageToIndex(pdfNum) {
    const fb = document.getElementById('flipbook');
    if (!fb) return pdfNum - 1;
    const pages = fb.querySelectorAll('.page');
    for (let i = 0; i < pages.length; i++) {
        if (pages[i] && pages[i].dataset && pages[i].dataset.pageNum == pdfNum) return i;
    }
    return Math.max(0, Math.min(pdfNum - 1, pages.length - 1));
}

/**
 * 判断物理索引是否为「透明补位空白尾页」（single 模式给偶页书追加，data-blank=1）。
 * 该页对用户不可见、翻不到，flip 到它不应触发页码/居中/埋点等逻辑。
 * @param {number} index 物理索引
 * @returns {boolean}
 */
function isBlankPageAt(index) {
    const fb = document.getElementById('flipbook');
    if (!fb) return false;
    const pages = fb.querySelectorAll('.page');
    const p = pages[index];
    return !!(p && p.dataset && p.dataset.blank === '1');
}

/** 判断物理索引是否为插入页（data-inserted=1，无真实 PDF 页号）。 */
function isInsertedPageAt(index) {
    const fb = document.getElementById('flipbook');
    if (!fb) return false;
    const pages = fb.querySelectorAll('.page');
    const p = pages[index];
    return !!(p && p.dataset && p.dataset.inserted === '1');
}

// 判断某页（物理索引）是否应单页居中（真实 PDF 首页/尾页 + 功能开启 + 非手机）。
function isCenteredIndex(target) {
    if (!store.coverCentered) return false;
    if (isMobileFn()) return false; // 手机本就单页，无需单页居中 orientation
    if (!store.totalPages) return false;
    // 插入页（无真实 PDF 页号）永远不应单页居中：否则会"继承"其前序 PDF 页号，
    // 导致首页(索引0)后的 O2 插入页被误判为"首页"而单页居中（应进入双页模式）。
    if (isInsertedPageAt(target)) return false;
    const realPage = pdfPageAt(target);
    // 尾页前若紧邻插入页（如尾页前的 T1），应让「插入页 + 尾页」组成双页显示，
    // 而不是尾页单独居中——否则会把插入页甩成孤立的单页。故尾页前是插入页时不居中。
    if (realPage === store.totalPages) {
        const prevInserted = isInsertedPageAt(target - 1);
        if (prevInserted) return false;
        return true;
    }
    return realPage === 1;
}

// ===== 居中诊断工具 =====
// 测量实际几何，区分"没走重建" vs "重建了但CSS偏右"
function diagCenterGeometry(label) {
    const fb = document.getElementById('flipbook');
    const bc = document.querySelector('.book-container');
    const parent = fb ? fb.querySelector('.stf__parent') : null;
    const settings = (store.pageFlip && store.pageFlip.getSettings) ? store.pageFlip.getSettings() : null;
    const rect = fb ? fb.getBoundingClientRect() : null;
    const bcRect = bc ? bc.getBoundingClientRect() : null;
    const vw = window.innerWidth;
    const info = {
        label,
        fbExists: !!fb,
        fbHasSingleClass: fb ? fb.classList.contains('single-centered') : false,
        fbWidth: fb ? fb.offsetWidth : null,
        fbLeft: rect ? Math.round(rect.left) : null,
        fbRight: rect ? Math.round(rect.right) : null,
        fbCenterOffset: rect ? Math.round((rect.left + rect.width / 2) - vw / 2) : null, // 相对视口中心的偏移，0=居中
        parentWidth: parent ? parent.offsetWidth : null,
        bcWidth: bc ? bc.clientWidth : null,
        viewport: vw,
        currentOrientation: store.currentOrientation,
        pfSize: settings ? settings.size : null,
        pfUsePortrait: settings ? !!settings.usePortrait : null,
        isRebuilding: store.isRebuilding,
        renderComplete: store.renderComplete,
        coverCentered: store.coverCentered,
    };
    return info;
}

// 控制台随时调用：window.diagCenter()
window.diagCenter = function () {
    console.log('[center][状态]', {
        coverCentered: store.coverCentered,
        renderComplete: store.renderComplete,
        currentOrientation: store.currentOrientation,
        isRebuilding: store.isRebuilding,
        hasPdf: !!store.pdf,
        totalPages: store.totalPages,
        currentPageIndex: store.currentPageIndex,
        isMobile: isMobileFn(),
        pageFlipExists: !!store.pageFlip,
    });
    diagCenterGeometry('手动诊断');
};

// 统一跳转入口：
// - 渐进渲染未结束 → 直接 flip()（绝不重建，保护渐进渲染）
// - 目标为中间页 / 非首/尾页 → 直接 flip()
// - 目标为首/尾页且当前为双页 → 重建为单页居中（renderComplete 后才允许）
// 统一的翻页/定位：优先 turnToPage（pages.show 直接定位，绕开单页模式 flipToPage 动画落点错乱），
// 失败回退 flip。用于所有需要"跳到绝对页索引"的场景（首页/尾页/缩略图/搜索跳转等）。
function safeFlip(target) {
    try {
        if (store.pageFlip && store.pageFlip.turnToPage) {
            store.pageFlip.turnToPage(target);
        } else if (store.pageFlip && store.pageFlip.flip) {
            store.pageFlip.flip(target, false);
        }
        if (store.pageFlip && store.pageFlip.update) { try { store.pageFlip.update(); } catch (e) {} }
    } catch (e) { /* ignore */ }
}

function flipToIndex(target, trigger = 'goto', { targetIsPhysical = false } = {}) {
    if (!store.pageFlip) return;
    hasUserFlipIntent = true;
    setJumpTrigger(trigger);
    // target 为「真实 PDF 页索引」（0-based，由首页/缩略图/滑块/goto/搜索/分享传入）。
    // 先钳制到 PDF 页数范围，再转换为物理索引（插入页会使物理索引 ≠ PDF 页索引）。
    const pdfTotal = store.totalPages || (store.pageFlip.getPageCount ? store.pageFlip.getPageCount() : 0);
    target = Math.min(Math.max(target, 0), (pdfTotal || 1) - 1);
    const phys = targetIsPhysical ? target : pdfPageToIndex(target + 1);

    const centered = isCenteredIndex(phys);
    console.log('[center] flipToIndex', {
        target, phys, renderComplete: store.renderComplete, centered,
        currentOrientation: store.currentOrientation, isMobile: isMobileFn()
    });

    // 从 PC 封面单页直接跳到显示页时，目标一定属于双页 spread；
    // 目标若是插入页，单靠 turnToPage 不一定触发翻页事件，需显式切换 orientation。
    if (targetIsPhysical && !isMobileFn() && !centered
        && store.currentOrientation === 'single') {
        rebuildTo('double', phys);
        return;
    }

    // 居中功能关闭 / 目标非首/尾页 / 手机 / PDF 未加载 → 普通翻页
    // 注意：已接受牺牲 lazy loading，故不再等 renderComplete，只要 PDF 已加载即可重建居中。
    if (!store.pdf || !centered) {
        safeFlip(phys);
        return;
    }

    const wantSingle = true;
    const curSingle = store.currentOrientation === 'single';
    if (wantSingle === curSingle) {
        // orientation 一致，无需重建，直接翻
        console.log('[center] 无需重建，直接 flip', { target, phys, currentOrientation: store.currentOrientation });
        safeFlip(phys);
    } else {
        console.log('[center] 将要调用 rebuildTo', { orientation: wantSingle ? 'single' : 'double', phys });
        rebuildTo(wantSingle ? 'single' : 'double', phys);
    }
}

// 跨 orientation 重建（仅 renderComplete 后调用）。
// 重建瞬间会丢失 flip 事件绑定，故重建后立即重绑；并在下一个事件循环翻到目标页，
// 此时占位 canvas 仍可用（渐进渲染已结束，canvas 已填完，重建只是换翻页器外壳）。
// 重建为指定 orientation，并定位到 target 页。返回 Promise，重填 canvas 完成后 resolve，
// 调用方据此释放 isRebuilding 锁，避免「锁提前释放 + resize 再次触发重建」打断重填导致永久空白。
function rebuildTo(orientation, target, opts = {}) {
    if (!store.pdf) {
        safeFlip(target);
        return Promise.resolve();
    }
    if (store.isRebuilding) {
        // 已在重建中：放弃本次，直接翻到目标（避免锁死导致永远无法居中）
        safeFlip(target);
        return Promise.resolve();
    }
    // PC 放大态跨单/双页重建时保留当前拖动锚点。否则 applyZoom(force) 的居中计算
    // 会把 scrollLeft 重置为 0，双页页面超出视口后右按钮就会重新压到页面内部。
    const pcZoomPanAnchor = capturePcZoomPanAnchor();
    store.isRebuilding = true;
    const flipbookEl = document.getElementById('flipbook') || (window.__app ? window.__app.flipbookEl : null);
    const syncLayoutAfterRebuild = () => {
        if (store.currentZoom > 1) {
            // 重填和翻页动画会再次改变 PageFlip 的最终几何；结束后补同步一次，既保持倍率，
            // 也按新页面重新居中并触发当前可见 PDF 页的高清重渲染。
            applyZoom(0, null, { force: true });
            restorePcZoomPanAnchor(pcZoomPanAnchor);
        } else {
            schedulePcPageArrowPosition({ reset: true });
        }
    };
    // 超时保险：无论如何 1.5s 后强制释放锁，避免异常路径卡死导致永远无法居中
    const guard = setTimeout(() => {
        store.__suppressAnimatedPageView = false;
        store.isRebuilding = false;
        syncLayoutAfterRebuild();
    }, 1500);
    const finish = () => {
        clearTimeout(guard);
        store.__suppressAnimatedPageView = false;
        store.isRebuilding = false;
        syncLayoutAfterRebuild();
    };

    // 动画场景：从起始页(startFrom)无动画显示，canvas 预填后 flip 动画到目标页(target)。
    // 非动画场景：startPage 直接用 target（维持原行为，无动画定位）。
    const { animateToPage = null, startFrom = target } = opts;
    const startPage = (animateToPage != null) ? startFrom : target;
    if (animateToPage != null) {
        // 清理旧实例残留，确保本次只使用新 page-flip 的 init 回调注册的动画执行器。
        store.__pendingAnimatedFlip = null;
        store.__triggerAnimatedFlip = null;
        // 新双页实例会先触发起始页定位帧；该帧仍是旧屏，不能作为最终曝光上报。
        store.__suppressAnimatedPageView = true;
    }

    const doRebuild = (useFixed) => {
        createPageFlip(
            flipbookEl,
            useFixed ? 'fixed' : 'stretch',
            (window.__app ? window.__app.stopPropFinal : (e) => e.stopPropagation()),
            orientation,
            startPage,
            animateToPage
        );
        // createPageFlip 会按新 orientation 重写宿主宽高。若当前处于放大态，立即用原倍率
        // 重建 zoomWrap 与 transform，保证跨单/双页翻页后仍保持相同的放大状态。
        if (store.currentZoom > 1) applyZoom(0, null, { force: true });
        // 重建后重绑翻页事件 + textLayer 守卫（库会重新生成 DOM）
        bindFlipEvents();
        if (window.__app && !window.__app.isMobile) {
            try { setupTextSelectionGuard(); } catch (e) { /* ignore */ }
        }
        // 落位交由 createPageFlip 内注册的 page-flip 'init' 事件完成（库就绪后一次性定位到 startPage，
        // 与库内部渲染同一步骤，避免「先默认页闪一帧再跳目标页」）。这里不再额外 turnToPage，
        // 否则会与 init 内的定位重复触发动画，反而引入新的抖动。
    };

    try {
        const useFixed = isMobileFn() && store.currentModeIsFixed;
        doRebuild(useFixed);
        // 点击前激活的旧 iframe 会随重建被销毁；必须对重建后的新 DOM 再激活一次。
        if (animateToPage != null) activateInsertFramesNear(animateToPage, 1);
        // 重建后旧 canvas 已被清空，重新把内容填回新占位（异步，渐进恢复显示）。
        // priorityPage: 重建后定位到的目标页优先填 canvas，避免尾页空白停留。
        // target 为物理索引，需转回真实 PDF 页号供 refillPages 优先渲染。
        // 关键修复：必须 await 重填完成后再释放 isRebuilding，否则 resize 会再次触发重建打断重填，
        // 旧 canvas 已清空、新 canvas 未就绪 → 永久空白。
        // 动画场景：起始页(首页)是动画起点，需优先填其 canvas，否则动画从空白页翻起、过程不可见；
        // 非动画场景维持填目标页。
        const priorityPdf = (animateToPage != null) ? pdfPageAt(startFrom) : pdfPageAt(target);
        // 动画场景：起始页 canvas 一就绪（onFirstFilled）就立即播放翻页动画，不等全量渲染，
        // 消除「首页跳右侧后停顿等待全量 PDF 渲染」的不连贯。全量渲染在后台继续。
        const animReadyDeadline = performance.now() + 1800;
        let animStarted = false;
        const triggerAnim = () => {
            if (animStarted) return;
            const runAnimation = store.__triggerAnimatedFlip;
            // page-flip 的 init 通过 setTimeout 异步触发；第一页重填可能更早完成。
            // 此时持续等到动画执行器注册，而不是把用户的翻页操作丢掉。
            if (typeof runAnimation !== 'function') {
                if (performance.now() < animReadyDeadline) {
                    requestAnimationFrame(triggerAnim);
                    return;
                }
                animStarted = true;
                console.warn('[center] 动画初始化超时，直接定位目标页:', animateToPage);
                store.__suppressAnimatedPageView = false;
                safeFlip(animateToPage);
                finish();
                return;
            }
            animStarted = true;
            // 静态首屏只负责抢首屏显示；真正开始翻页时必须让出交互层，确保用户从
            // 第一帧就看到与后续页面相同的 PageFlip 阴影和 3D 翻页过程。
            if (!isMobileFn() && startFrom === 0) {
                hideFirstPagePreview({ immediate: true });
            }
            // 关键：update() 会触发 e.data=当前页 的 flip 定位帧，重设 justRebuilt 拦截，避免连锁重建
            store.justRebuilt = true;
            try { if (store.pageFlip.update) store.pageFlip.update(); } catch (e) {}
            // 同步直接 flip（不用 rAF）：让「首页定位到封面位」与「翻页动画」在同一渲染帧内衔接，
            // 避免中间渲染出一帧静止的「首页在右侧」，从视觉上消除「跳右侧」的观感。
            // 动画结束(onDone)时才释放锁；失败路径由 __triggerAnimatedFlip 内部兜底 clear() 调用 onDone
            store.__suppressAnimatedPageView = false;
            try { runAnimation(finish); } catch (e2) { safeFlip(animateToPage); finish(); }
        };
        // 非动画场景：起始页(priorityPage)就绪即释放 isRebuilding 锁，不等全量渲染。
        // 否则全量渲染 60 页期间锁一直占用，用户此时翻页会被拦截 → 点击无响应。
        const finishOnFirstFilled = () => {
            store.justRebuilt = true;
            try { if (store.pageFlip.update) store.pageFlip.update(); } catch (e) {}
            finish();
        };
        return refillPages(
            store.pdf, store.totalPages, store.renderTextLayer,
            Array.from(flipbookEl.querySelectorAll('.page')),
            {
                priorityPage: priorityPdf,
                onFirstFilled: (animateToPage != null) ? triggerAnim : finishOnFirstFilled,
                onInitialBatchFilled: store.onInitialBatchFilled,
                onPageCanvasFilled: handlePageCanvasFilled,
                idleAfter: 3,
            }
        ).then(() => {
            if (animateToPage != null) {
                // 动画场景：动画已由 onFirstFilled 触发，这里仅兜底（函数内部保证只执行一次）。
                triggerAnim();
            } else {
                // 非动画场景：锁已由 onFirstFilled 释放，这里兜底确保释放（防止 onFirstFilled 未触发）
                if (store.isRebuilding) {
                    store.justRebuilt = true;
                    try { if (store.pageFlip.update) store.pageFlip.update(); } catch (e) {}
                    finish();
                }
            }
            diagCenterGeometry('rebuildTo完成');
            // 后台重填全部完成后再补一次可见页高清渲染；动画结束时目标页 Canvas 可能尚未写回。
            if (store.currentZoom > 1) scheduleZoomRender(store.currentZoom, true);
        }).catch(err => {
            console.error('[center] 重填失败:', err);
            store.__suppressAnimatedPageView = false;
            finish();
        });
    } catch (e) {
        console.error('[center] 重建失败，回退双页:', e);
        store.__suppressAnimatedPageView = false;
        try {
            doRebuild(false);
            return refillPages(store.pdf, store.totalPages, store.renderTextLayer,
                Array.from(flipbookEl.querySelectorAll('.page')), {
                    onPageCanvasFilled: handlePageCanvasFilled,
                    idleAfter: 3,
                })
                .catch(err => console.error('[center] 双页回退重填失败:', err))
                .finally(finish);
        } catch (e2) {
            console.error('[center] 双页回退也失败:', e2);
            finish();
            return Promise.resolve();
        }
    }
}

// ========== 插入 HTML 页：显示/隐藏切换 ==========
/**
 * 切换「显示插入页」状态并重建翻页器。
 * - insertVisible=false → 重建为纯 PDF 翻页器；
 * - insertVisible=true  → 重建为 PDF + 插入页混排翻页器。
 * 重建后落位到「切换前所在真实 PDF 页」对应的物理位置（页码不变）。
 * @returns {Promise<void>}
 */
function toggleInsertedPages() {
    if (!store.pdf || !store.insertEnabled) return Promise.resolve();
    if (store.isRebuilding) return Promise.resolve(); // 重建中忽略，避免锁冲突

    store.insertVisible = !store.insertVisible;
    // 记录切换前真实 PDF 页号（切换后物理索引会变，需重新映射）
    const realPdf = pdfPageAt(store.currentPageIndex || 0);
    const flipbookEl = document.getElementById('flipbook') || (window.__app ? window.__app.flipbookEl : null);
    if (!flipbookEl) return Promise.resolve();

    // 计算切换后 seq 中「该真实 PDF 页」的物理索引（不依赖重建前旧 DOM，避免时序错位）：
    //   - 打开插入页：物理索引 = (pdfNum-1) + 排在它之前的插入页数（afterPage < pdfNum 的项）
    //   - 关闭插入页：纯 PDF，物理索引 = pdfNum - 1
    let targetPhys;
    if (store.insertVisible) {
        let ahead = 0;
        for (const it of store.insertedPages || []) {
            if (it.afterPage < realPdf) ahead++;
        }
        targetPhys = (realPdf - 1) + ahead;
    } else {
        targetPhys = realPdf - 1;
    }

    store.isRebuilding = true;
    const guard = setTimeout(() => { store.isRebuilding = false; }, 1500);
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        store.isRebuilding = false;
        updateInsertIconState();
    };

    const orientation = store.currentOrientation === 'single' ? 'single' : 'double';
    const wantSingle = orientation === 'single';

    try {
        createPageFlip(
            flipbookEl,
            isMobileFn() && store.currentModeIsFixed ? 'fixed' : 'stretch',
            (window.__app ? window.__app.stopPropFinal : (e) => e.stopPropagation()),
            orientation,
            targetPhys
        );
        insertSequenceReady = true;
        bindFlipEvents();
        if (window.__app && !window.__app.isMobile) {
            try { setupTextSelectionGuard(); } catch (e) { /* ignore */ }
        }
        if (store.insertVisible) activateInsertFramesNear(targetPhys, 2);
        return refillPages(
            store.pdf, store.totalPages, store.renderTextLayer,
            Array.from(flipbookEl.querySelectorAll('.page')),
            {
                priorityPage: realPdf,
                onFirstFilled: finish,
                onInitialBatchFilled: store.onInitialBatchFilled,
                onPageCanvasFilled: handlePageCanvasFilled,
                idleAfter: 3,
            }
        ).then(() => {
            try { if (store.pageFlip.update) store.pageFlip.update(); } catch (e) {}
        }).catch((err) => {
            console.error('[insert] 切换后重填失败:', err);
        }).finally(finish);
    } catch (e) {
        console.error('[insert] 切换重建失败:', e);
        finish();
        return Promise.resolve();
    }
}

/**
 * 更新插入切换图标的激活态（active 高亮表示当前显示插入页）。
 * 图标不存在或功能禁用时不改动。
 */
function updateInsertIconState() {
    const btn = document.getElementById('insertToggleBtn');
    if (!btn) return;
    if (store.insertEnabled) {
        btn.classList.toggle('active', store.insertVisible);
        btn.title = store.insertVisible ? '隐藏插入HTML页' : '显示插入HTML页';
        btn.disabled = false;
    } else {
        btn.classList.remove('active');
        btn.title = '插入HTML功能不可用（无配置或PDF不匹配）';
        btn.disabled = true;
    }
}

function performSearch() {
    const isMobile = window.__isMobile ? window.__isMobile() : false;
    const pcInput = document.getElementById('searchInput');
    const mobileInput = document.getElementById('mobileSearchInput');
    const keyword = (isMobile ? mobileInput.value : pcInput.value).trim();

    let resultsContainer;
    if (isMobile) {
        window.__mobileShowSearchView && window.__mobileShowSearchView();
        window.__mobileOpenDrawer && window.__mobileOpenDrawer('搜索结果');
        resultsContainer = document.getElementById('mobileSearchResults');
    } else {
        resultsContainer = document.getElementById('searchResults');
        closeZoomBar();
        openPcDrawer('search');
    }

    resultsContainer.innerHTML = '';
    clearAllSearchHighlights();
    store.currentSearchKeyword = '';

    if (!keyword) {
        resultsContainer.innerHTML = '<p class="empty-state">请输入关键字</p>';
        return;
    }

    const results = searchIndex(keyword);
    if (results === null) {
        resultsContainer.innerHTML = '<p class="empty-state">搜索暂不可用（文本索引缺失）</p>';
        return;
    }

    const lowerKeyword = keyword.toLowerCase();

    // 埋点：search_keywords 事件（PDF 要求字段：search_keywords / page_num + 公共字段）
    const curPage = (store.pageFlip && typeof store.pageFlip.getCurrentPageIndex === 'function')
        ? pdfPageAt(store.pageFlip.getCurrentPageIndex()) : 1;
    track('search_keywords', {
        search_keywords: keyword,
        page_num: curPage,
    });

    const currentPage = pdfPageAt(store.pageFlip.getCurrentPageIndex());
    const resultPages = results.map(r => r.page).join(',');
    track('search_result', {
        search_keywords: keyword,
        result_count: results.length,
        result: resultPages,
        page_num: currentPage,
    });

    if (results.length === 0) {
        resultsContainer.innerHTML = '<p class="empty-state">未找到匹配内容</p>';
        return;
    }

    store.currentSearchKeyword = keyword;

    results.forEach(item => {
        const idx = item.text.toLowerCase().indexOf(lowerKeyword);
        const start = Math.max(0, idx - 20);
        const end = Math.min(item.text.length, idx + 20);
        let snippet = item.text.substring(start, end).replace(/\n/g, ' ');

        const regex = new RegExp(`(${escapeRegex(keyword)})`, 'gi');
        snippet = snippet.replace(regex, '<mark>$1</mark>');

        const div = document.createElement('div');
        div.className = 'search-item';
        div.innerHTML = `
            <div class="page-num">第 ${item.page} 页</div>
            <div class="snippet">...${snippet}...</div>
        `;

        div.addEventListener('click', async () => {
            flipToIndex(item.page - 1, 'search');
            if (isMobile) {
                window.__mobileCloseDrawer && window.__mobileCloseDrawer();
            }
            setTimeout(() => {
                highlightSearchOnPage(item.page, keyword);
            }, 800);
        });

        resultsContainer.appendChild(div);
    });

    highlightSearchOnVisiblePages(currentPage);
}

function cancelPendingZoomRender() {
    if (zoomRenderTimer !== null) {
        clearTimeout(zoomRenderTimer);
        zoomRenderTimer = null;
    }
    if (pageTurnZoomRenderTimer !== null) {
        clearTimeout(pageTurnZoomRenderTimer);
        pageTurnZoomRenderTimer = null;
    }
    if (baseCanvasRestoreTimer !== null) {
        clearTimeout(baseCanvasRestoreTimer);
        baseCanvasRestoreTimer = null;
    }
    if (normalQualityRenderTimer !== null) {
        clearTimeout(normalQualityRenderTimer);
        normalQualityRenderTimer = null;
    }
    normalQualityPendingPages.clear();
    cancelZoomRerenders();
}

/**
 * 物理索引 -> 滑动条显示页码。
 * PC 双页模式显示当前 spread 的左页：封面为 1，后续依次为 2、4、6……；
 * 插入页仍按物理序列占位，尾部超过 PDF 总页数时统一显示最后一页。
 * 其它模式继续按真实 PDF 页号显示，且不改变其它 UI/埋点使用的 pdfPageAt() 语义。
 * @param {number} index 物理索引（0-based）
 * @returns {number} 滑动条显示的页号（>=1）
 */
function pdfPageForSlider(index) {
    const fb = document.getElementById('flipbook');
    if (!fb) return index + 1;
    const pages = fb.querySelectorAll('.page');

    if (!isMobileFn()
        && store.currentOrientation === 'double'
        && store.pageFlip?.getOrientation?.() === 'landscape') {
        const leftIndex = store.coverCentered
            ? (index % 2 === 1 ? index : index - 1)
            : (index % 2 === 0 ? index : index - 1);
        const total = store.totalPages || pages.length || 1;

        // HTML 自定义页继续占据物理槽位，因此尾部可能有多个 spread 超过 PDF
        // 页数。统一封顶为最后一页，避免在末尾前人为回退到 56 而产生重复页码。
        return Math.max(1, Math.min(total, leftIndex + 1));
    }

    const page = pages[index];
    const directNum = page?.dataset?.pageNum;
    if (directNum) return parseInt(directNum, 10);

    for (let k = index + 1; k < pages.length; k++) {
        const num = pages[k]?.dataset?.pageNum;
        if (num) return parseInt(num, 10);
    }
    return pdfPageAt(index);
}

function getCurrentViewZoomRequest() {
    if (isMobileFn()) {
        return store.currentZoom > 1.01
            ? { zoom: store.currentZoom, trackStoreZoom: true }
            : null;
    }
    return store.currentZoom > 1
        ? { zoom: store.currentZoom, trackStoreZoom: true }
        : null;
}

function isMobilePageFlipAnimating() {
    if (!isMobileFn()) return false;
    const flipbook = document.getElementById('flipbook');
    return flipbook?.dataset?.flipState === 'flipping' || !!store.__animatingFlip;
}

function scheduleCurrentViewZoomRender() {
    const request = getCurrentViewZoomRequest();
    if (!request) return;
    scheduleZoomRender(request.zoom, request.trackStoreZoom);
}

// 基础 Canvas 写回时只在“该页当前可见且确实处于放大态”下补高清渲染。
// 普通 100% 浏览在倍率判断处直接返回，不扫描页面、不增加渲染任务。
function handlePageCanvasFilled(pageNumber) {
    updateThumbnailForPage(pageNumber);
    const request = getCurrentViewZoomRequest();
    if (!request) {
        // 仅处理质量检查时记录的“当前可见但 Canvas 尚未填回”页面；后台其余页面零额外扫描。
        if (!isMobileFn() && store.currentZoom <= 1
            && normalQualityPendingPages.delete(Number(pageNumber))) {
            scheduleNormalQualityRender(100);
        }
        return;
    }
    const page = document.querySelector(`#flipbook .page[data-page-num="${Number(pageNumber)}"]`);
    const container = document.querySelector('.book-container');
    if (!page || !container || page.dataset.blank === '1') return;
    const style = getComputedStyle(page);
    const pageRect = page.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
        || pageRect.width <= 1 || pageRect.height <= 1
        || pageRect.right <= containerRect.left || pageRect.left >= containerRect.right
        || pageRect.bottom <= containerRect.top || pageRect.top >= containerRect.bottom) return;
    document.getElementById('flipbook')?.removeAttribute('data-zoom-render-ready');
    scheduleZoomRender(request.zoom, request.trackStoreZoom);
}

// 将已完成的页面 Canvas 缩放绘制到对应预览项；未完成页面保持轻量空白占位。
function updateThumbnailForPage(pageNumber) {
    const source = store.pageCanvases[Number(pageNumber) - 1];
    const item = document.querySelector(`.thumbnail-item[data-page="${Number(pageNumber)}"]`);
    const target = item?.querySelector('canvas');
    if (!source || !target) return;

    const width = target.width;
    const height = target.height;
    const srcAspect = source.width / source.height;
    const dstAspect = width / height;
    let dx = 0;
    let dy = 0;
    let dw = width;
    let dh = height;
    if (srcAspect > dstAspect) {
        dh = height;
        dw = dh * srcAspect;
        dx = (width - dw) / 2;
    } else {
        dw = width;
        dh = dw / srcAspect;
        dy = (height - dh) / 2;
    }

    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, dx, dy, dw, dh);
    item.classList.add('is-ready');
}

function scheduleZoomRenderAfterPageTurn() {
    const request = getCurrentViewZoomRequest();
    if (!request) {
        scheduleNormalQualityRender(820);
        return;
    }
    document.getElementById('flipbook')?.removeAttribute('data-zoom-render-ready');
    if (pageTurnZoomRenderTimer !== null) clearTimeout(pageTurnZoomRenderTimer);
    // PageFlip 动画为 750ms；动画落位后再读取可见页，只渲染最终屏幕中的 1–2 页。
    pageTurnZoomRenderTimer = setTimeout(() => {
        pageTurnZoomRenderTimer = null;
        scheduleCurrentViewZoomRender();
    }, 820);
}

function getVisiblePdfPageNumbers() {
    const container = document.querySelector('.book-container');
    const containerRect = container?.getBoundingClientRect();
    return [...document.querySelectorAll('#flipbook .page[data-page-num]')]
        .filter((page) => {
            if (page.dataset.blank === '1') return false;
            const style = getComputedStyle(page);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const rect = page.getBoundingClientRect();
            if (rect.width <= 1 || rect.height <= 1) return false;
            if (!containerRect) return true;
            return rect.right > containerRect.left && rect.left < containerRect.right
                && rect.bottom > containerRect.top && rect.top < containerRect.bottom;
        })
        .map((page) => Number(page.dataset.pageNum))
        .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1);
}

function getPageCanvasCssPixelRatio(pageNumber) {
    const page = document.querySelector(`#flipbook .page[data-page-num="${Number(pageNumber)}"]`);
    const canvas = page?.querySelector('canvas');
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect || rect.width <= 1 || rect.height <= 1) return 0;
    return Math.min(canvas.width / rect.width, canvas.height / rect.height);
}

// 普通 100% 浏览只在前三页首屏任务或翻页动画完成后检查当前可见 PDF 页。
// 已达到 2 后备像素/CSS 像素的高 DPI 页面直接复用；离屏增强页恢复基础 Canvas，限制显存占用。
function scheduleNormalQualityRender(delay = 0) {
    if (isMobileFn() || !store.pdf || store.currentZoom > 1) return;
    if (normalQualityRenderTimer !== null) clearTimeout(normalQualityRenderTimer);
    normalQualityPendingPages.clear();
    document.getElementById('flipbook')?.removeAttribute('data-quality-render-ready');
    normalQualityRenderTimer = setTimeout(async () => {
        normalQualityRenderTimer = null;
        if (isMobileFn() || !store.pdf || store.currentZoom > 1 || store.isRebuilding) return;
        const visiblePages = getVisiblePdfPageNumbers();
        if (visiblePages.length === 0) return;

        restoreBaseCanvasesAfterZoom(visiblePages);
        const minimumRatio = NORMAL_QUALITY_CSS_PIXEL_RATIO - NORMAL_QUALITY_RATIO_TOLERANCE;
        const pagesNeedingQuality = [];
        visiblePages.forEach((pageNumber) => {
            const ratio = getPageCanvasCssPixelRatio(pageNumber);
            if (ratio <= 0) normalQualityPendingPages.add(pageNumber);
            else if (ratio < minimumRatio) pagesNeedingQuality.push(pageNumber);
        });
        if (pagesNeedingQuality.length > 0) {
            await rerenderVisiblePagesForZoom(store.pdf, pagesNeedingQuality, 1, {
                minCssPixelRatio: NORMAL_QUALITY_CSS_PIXEL_RATIO,
                renderKind: 'quality',
            });
        }

        if (isMobileFn() || store.currentZoom > 1 || store.isRebuilding) return;
        const currentVisiblePages = getVisiblePdfPageNumbers();
        const currentPagesAreSharp = currentVisiblePages.length > 0
            && currentVisiblePages.every(
                (pageNumber) => getPageCanvasCssPixelRatio(pageNumber) >= minimumRatio
            );
        if (currentPagesAreSharp) {
            document.getElementById('flipbook')?.setAttribute(
                'data-quality-render-ready',
                String(NORMAL_QUALITY_CSS_PIXEL_RATIO)
            );
        }
    }, Math.max(0, Number(delay) || 0));
}

function scheduleZoomRender(requestedZoom = store.currentZoom, trackStoreZoom = true) {
    if (!store.pdf || requestedZoom <= 1) return;
    if (zoomRenderTimer !== null) clearTimeout(zoomRenderTimer);
    zoomRenderTimer = setTimeout(async () => {
        zoomRenderTimer = null;
        // PageFlip 动画期间不要替换页面 Canvas。移动端放大时若在卷页中途换层，
        // 浏览器会短暂显示新旧图层，表现为页面闪烁；动画结束后再重新排队渲染。
        if (isMobilePageFlipAnimating()) {
            scheduleZoomRender(requestedZoom, trackStoreZoom);
            return;
        }
        const zoomStillCurrent = trackStoreZoom
            ? store.currentZoom === requestedZoom
            : Math.abs((window.visualViewport?.scale || 1) - requestedZoom) < 0.05;
        if (!store.pdf || !zoomStillCurrent || store.isRebuilding) return;
        const pageNumbers = getVisiblePdfPageNumbers();
        if (pageNumbers.length === 0) return;
        const results = await rerenderVisiblePagesForZoom(store.pdf, pageNumbers, requestedZoom);
        const zoomRemainsCurrent = trackStoreZoom
            ? store.currentZoom === requestedZoom
            : Math.abs((window.visualViewport?.scale || 1) - requestedZoom) < 0.05;
        if (zoomRemainsCurrent && results.length > 0) {
            document.getElementById('flipbook')?.setAttribute('data-zoom-render-ready', String(requestedZoom));
        }
    }, ZOOM_RENDER_DEBOUNCE_MS);
}

// 记录双击点在未缩放页面中的坐标，供放大完成后恢复视口焦点。
function captureZoomFocusPoint(point) {
    if (!point || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return null;
    const fb = document.getElementById('flipbook');
    const container = document.querySelector('.book-container');
    if (!fb || !container) return null;
    const rect = fb.getBoundingClientRect();
    const zoom = Math.max(MIN_ZOOM, Number(store.currentZoom) || MIN_ZOOM);
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
        clientX: point.clientX,
        clientY: point.clientY,
        localX: (point.clientX - rect.left) / zoom,
        localY: (point.clientY - rect.top) / zoom,
    };
}

// 放大后的布局会先统一居中，再按双击点修正滚动位置，保证点击内容仍在原视口处。
function focusZoomPoint(focusPoint, zoom) {
    if (!focusPoint || zoom <= MIN_ZOOM) return;
    const fb = document.getElementById('flipbook');
    const container = document.querySelector('.book-container');
    if (!fb || !container) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const rect = fb.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const visualX = rect.left + focusPoint.localX * zoom;
        const visualY = rect.top + focusPoint.localY * zoom;
        container.scrollLeft += visualX - focusPoint.clientX;
        container.scrollTop += visualY - focusPoint.clientY;
    }));
}

function applyZoom(delta, focusPoint = null, { force = false } = {}) {
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, store.currentZoom + delta));
    if (newZoom === store.currentZoom && !force) return;
    if (isMobileFn()) {
        store.currentZoom = newZoom;
        if (newZoom <= 1.01) resetMobileContentZoom();
        else {
            renderMobileContentZoom();
            scheduleZoomRender(newZoom, true);
        }
        return;
    }
    cancelPendingZoomRender();
    document.getElementById('flipbook')?.removeAttribute('data-zoom-render-ready');
    store.currentZoom = newZoom;
    lastPcArrowBounds = null;
    lastPcArrowLayoutKey = '';

    const fb = document.getElementById('flipbook');
    const wrap = document.getElementById('zoomWrap');
    const container = document.querySelector('.book-container');
    const bcClientWidth = container ? container.clientWidth : 0;

    const zoomPct = `${Math.round(store.currentZoom * 100)}%`;
    const zoomLevel = document.getElementById('zoomLevelBar');
    if (zoomLevel) zoomLevel.textContent = zoomPct;
    const zoomRange = document.getElementById('zoomRangeBar');
    if (zoomRange) zoomRange.value = Math.round(store.currentZoom * 100);

    if (store.currentZoom === 1) {
        restoreBaseCanvasesAfterZoom();
        fb.style.transform = '';
        fb.style.margin = '';
        wrap.style.width = '';
        wrap.style.height = '';
        wrap.style.margin = '';
        wrap.style.minWidth = '';
        wrap.style.flex = '';
        container.style.overflow = 'hidden';
        container.style.display = '';
        container.classList.remove('zoomed');
        container.classList.remove('single-page-mode', 'scroll-locked');
        // 单页居中态：zoom 复位后需保留内联单页尺寸（否则 #flipbook 退回 width:100% 失去居中）。
        // 用库基准单页宽 + margin:0 auto 重新应用，不触发重建避免闪烁。
        if (store.currentOrientation === 'single') {
            fb.style.width = (store.basePageWidth || 720) + 'px';
            fb.style.height = (store.basePageHeight || Math.round((store.basePageWidth || 720) * (store.pdfBaseHeight / store.pdfBaseWidth))) + 'px';
            fb.style.maxWidth = '92vw';
            fb.style.margin = '0 auto';
        } else {
            fb.style.width = '';
            fb.style.height = '';
        }
        if (store.pageFlip && store.pageFlip.update) { try { store.pageFlip.update(); } catch (e) {} }
        centerOverflow();
        schedulePcPageArrowPosition({ reset: true });
        scheduleNormalQualityRender(350);
        return;
    }

    fb.style.transformOrigin = 'top left';
    fb.style.transform = `scale(${store.currentZoom})`;
    // 放大后页面的视觉尺寸由 transform 决定，不能继续保留单/双页模式的 auto margin。
    // PC 端稍后按 PageFlip 页层的实际外溢量精确设置左偏移，使按钮条与页面零间距贴合。
    const pcEdgeGutter = isMobileFn() ? 0 : PC_ZOOM_EDGE_GUTTER;
    fb.style.margin = '0';
    // 单页居中 orientation 时版芯宽 = 单页宽；双页时 = 单页宽 * 2
    const pageSpan = store.currentOrientation === 'single' ? 1 : 2;
    fb.style.width = (store.basePageWidth * pageSpan) + 'px';
    fb.style.height = store.basePageHeight + 'px';
    // PageFlip 的可见 .page 可能相对 #flipbook 左右各外溢数个像素。使用实际页层边界修正
    // zoomWrap 宽度和左偏移，避免仅按基准宽度计算时在最右边界产生细小重叠。
    const nominalZoomedBookWidth = Math.round(store.basePageWidth * pageSpan * store.currentZoom);
    let zoomedBookRightExtent = nominalZoomedBookWidth;
    let zoomedBookLeftOffset = pcEdgeGutter;
    if (pcEdgeGutter > 0) {
        const flipbookRect = fb.getBoundingClientRect();
        const pageRects = Array.from(fb.querySelectorAll('.page'))
            .filter((page) => getComputedStyle(page).display !== 'none')
            .map((page) => page.getBoundingClientRect())
            .filter((rect) => rect.width > 20 && rect.height > 20);
        if (pageRects.length) {
            const pageLeft = Math.min(...pageRects.map((rect) => rect.left));
            const pageRight = Math.max(...pageRects.map((rect) => rect.right));
            const leftOverhang = Math.max(0, flipbookRect.left - pageLeft);
            zoomedBookLeftOffset = Math.ceil(pcEdgeGutter + leftOverhang);
            zoomedBookRightExtent = Math.ceil(Math.max(
                nominalZoomedBookWidth,
                pageRight - flipbookRect.left,
            ));
        }
        fb.style.margin = `0 0 0 ${zoomedBookLeftOffset}px`;
    }
    const zoomedContentWidth = zoomedBookLeftOffset + zoomedBookRightExtent + pcEdgeGutter;
    wrap.style.width = zoomedContentWidth + 'px';
    wrap.style.minWidth = zoomedContentWidth + 'px';
    wrap.style.flex = 'none';
    wrap.style.height = Math.round(store.basePageHeight * store.currentZoom) + 'px';
    // PC 放大态内容组从阅读区最左侧开始：左按钮条贴边，页面紧随按钮条。
    // 复位到 100% 时会清除此内联值，恢复 CSS 原有的常规居中布局。
    wrap.style.margin = pcEdgeGutter > 0 ? '0' : '';

    // 放大态统一走 .zoomed（display:block + overflow:hidden）模型：
    // PC 横向从左边界排布；内容溢出后由 scrollLeft 接管拖拽平移；
    // 纵向居中/拖拽平移由 centerOverflow() 用 scrollTop 实现。
    // 不再用 flex 居中：flex 在内容纵向溢出时会上下均分裁切且 scrollTop 被钳制，
    // 导致只能单向拖拽、无法看顶部。
    container.classList.add('zoomed');
    container.style.overflow = 'hidden';
    container.classList.remove('single-page-mode', 'scroll-locked');
    centerOverflow();
    focusZoomPoint(focusPoint, store.currentZoom);
    schedulePcPageArrowPosition({ reset: true });
    scheduleZoomRender(store.currentZoom, true);
}

function toggleFullscreen() {
    const appContainer = document.querySelector('.app-container');
    const bookContainer = document.querySelector('.book-container');
    const btn = document.getElementById('fullscreenBtn');

    if (!document.fullscreenElement) {
        appContainer.requestFullscreen().then(() => {
            bookContainer.classList.add('fullscreen-mode');
            btn.title = '退出全屏';
        }).catch(err => {
            console.error('全屏失败:', err);
        });
    } else {
        document.exitFullscreen().then(() => {
            bookContainer.classList.remove('fullscreen-mode');
            btn.title = '全屏';
        });
    }
}

function syncAfterLayoutChange() {
    if (store.currentZoom !== 1) {
        applyZoom(0);          // 复位缩放（恢复 transform / class / pageFlip.update / 居中）
        syncAfterLayoutChange(); // 复位后重新按当前窗口尺寸适配单/双页
        return;
    }
    const bc = document.querySelector('.book-container');
    const fb = document.getElementById('flipbook');
    const settings = store.pageFlip && store.pageFlip.getSettings ? store.pageFlip.getSettings() : null;
    const minW = settings ? settings.minWidth : 550;
    const doubleThreshold = minW * 2;
    const SCROLL_THRESHOLD = 600;
    let containerW = null;
    if (fb) {
        const parent = fb.querySelector('.stf__parent');
        if (parent) containerW = parent.offsetWidth;
        else if (bc) containerW = Math.round(bc.getBoundingClientRect().width);
    } else if (bc) {
        containerW = Math.round(bc.getBoundingClientRect().width);
    }
    const wantSingle = containerW !== null ? containerW < doubleThreshold : false;
    const wantScrollLock = containerW !== null ? containerW < SCROLL_THRESHOLD : false;
    if (bc) {
        bc.classList.toggle('single-page-mode', wantSingle);
        bc.classList.toggle('scroll-locked', wantScrollLock);
    }
    if (store.pageFlip && store.pageFlip.update) {
        try { store.pageFlip.update(); } catch (e) { /* ignore */ }
    }
    centerOverflow();
}

function centerOverflow() {
    const bc = document.querySelector('.book-container');
    const wrap = document.getElementById('zoomWrap');
    if (!bc || !wrap) return;
    if (store.currentZoom === 1) {
        bc.scrollLeft = 0;
        bc.scrollTop = 0;
        return;
    }
    // 测量-修正法：先读取 wrap 在「内容坐标系」中的真实左上角位置（含任何 transform /
    // margin 造成的偏移），再计算应到达的目标居中位置，用 scroll 增量修正。
    // 相比直接写 scrollLeft=(wW-bcW)/2，此法不假设 wrap 从 0 开始，能纠正意外偏移，且幂等。
    // 横向：仅当 wrap 宽 > 容器宽（横向溢出）才用 scrollLeft 居中；否则保持左对齐且
    //   scrollLeft 为 0（无滚动范围，负值会被钳制导致跳边）。
    // 纵向：始终用 scrollTop 居中（block 模型下纵向溢出可滚动，拖拽平移也依赖 scrollTop）。
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const bcRect = bc.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        // wrap 当前在内容坐标中的左上角（减去 scroll 偏移还原到内容坐标系）
        const curX = wrapRect.left - bcRect.left + bc.scrollLeft;
        const curY = wrapRect.top - bcRect.top + bc.scrollTop;
        const overflowX = wrapRect.width > bc.clientWidth;
        const targetX = overflowX ? (bc.clientWidth - wrapRect.width) / 2 : 0;
        const targetY = (bc.clientHeight - wrapRect.height) / 2;
        if (overflowX) bc.scrollLeft += (targetX - curX);
        else bc.scrollLeft = 0;
        bc.scrollTop += (targetY - curY);
    }));
}

function capturePcZoomPanAnchor() {
    if (isMobileFn() || store.currentZoom <= 1) return null;
    const bc = document.querySelector('.book-container');
    if (!bc) return null;
    const maxX = Math.max(0, bc.scrollWidth - bc.clientWidth);
    return {
        xRatio: maxX > 0 ? bc.scrollLeft / maxX : 0,
        atRight: maxX > 0 && maxX - bc.scrollLeft <= 4,
    };
}

function restorePcZoomPanAnchor(anchor) {
    if (!anchor || isMobileFn() || store.currentZoom <= 1) return;
    const bc = document.querySelector('.book-container');
    if (!bc) return;
    // centerOverflow 使用双 requestAnimationFrame；再延后一帧恢复，避免被其居中结果覆盖。
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        const maxX = Math.max(0, bc.scrollWidth - bc.clientWidth);
        bc.scrollLeft = anchor.atRight ? maxX : Math.round(anchor.xRatio * maxX);
        schedulePcPageArrowPosition({ reset: true });
    })));
}

// 执行分享：复制「当前页链接」到剪贴板并 toast 提示。平台无关，PC 与手机共用。
export async function doShare() {
    const pdfName = store.pdfName;
    const physicalIndex = getCurrentPhysicalPageIndex();
    const link = buildShareLink(pdfName, physicalIndex);
    let copied = false;
    try {
        await navigator.clipboard.writeText(link);
        copied = true;
    } catch (e) {
        copied = false;
    }
    if (copied) {
        showShareToast('本页分享链接已复制到剪贴板');
    } else {
        try {
            const ta = document.createElement('textarea');
            ta.value = link;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            copied = true;
            showShareToast('本页分享链接已复制到剪贴板');
        } catch (e2) {
            showShareToast('复制失败，链接：' + link);
        }
    }
    console.log('[分享] 当前页链接:', link);
    // 埋点：share 事件（PDF 要求字段：title / url / page_num / utm_medium=share）
    // page_num 按埋点规范使用物理页码；使用翻页事件同步的 store 状态，避免移动端
    // 动画已落位但 PageFlip getter 仍返回上一帧时把当前页误报为 1。
    const curPage = physicalIndex + 1;
    track('share', {
        url: link,
        page_num: curPage,
        utm_medium: 'share',
    });
}

// ========== 顶部缩放条（轻盈替代原抽屉缩放视图） ==========
function openZoomBar() {
    const bar = document.getElementById('zoomBar');
    if (!bar) return;
    bar.classList.add('open');
    bar.setAttribute('aria-hidden', 'false');
    // 同步当前百分比到滑块/文本
    const zoomRange = document.getElementById('zoomRangeBar');
    const zoomLevel = document.getElementById('zoomLevelBar');
    if (zoomRange) zoomRange.value = Math.round(store.currentZoom * 100);
    if (zoomLevel) zoomLevel.textContent = `${Math.round(store.currentZoom * 100)}%`;
}

function closeZoomBar() {
    const bar = document.getElementById('zoomBar');
    if (!bar) return;
    bar.classList.remove('open');
    bar.setAttribute('aria-hidden', 'true');
}

function toggleZoomBar() {
    const bar = document.getElementById('zoomBar');
    if (!bar) return;
    if (bar.classList.contains('open')) closeZoomBar();
    else openZoomBar();
}

// ========== 跳页气泡（左下角，轻盈替代对话框） ==========
function goToPage(pageNum) {
    if (!store.pageFlip) return;
    // goto 以「真实 PDF 页号」为准（页码不变），total 用 PDF 页数。
    const total = store.totalPages || (store.pageFlip.getPageCount ? store.pageFlip.getPageCount() : 0);
    const n = parseInt(pageNum, 10);
    if (!Number.isFinite(n)) return;
    const target = Math.min(Math.max(n, 1), total);
    flipToDisplayedPage(target, 'goto');
}

// PC 双页下，页码输入/滑动条表示阅读器显示页：3 属于 2-3 spread，5 属于 4-5 spread。
// 移动端仍以单页 PDF 页码跳转；目录、缩略图和搜索继续走 flipToIndex 的 PDF 语义。
function flipToDisplayedPage(pageNum, trigger) {
    const singlePageMode = document.querySelector('.book-container')?.classList.contains('single-page-mode');
    if (isMobileFn() || singlePageMode) {
        flipToIndex(pageNum - 1, trigger);
        return;
    }

    const spreadPage = pageNum > 1 && pageNum % 2 === 1 ? pageNum - 1 : pageNum;
    flipToIndex(spreadPage - 1, trigger, { targetIsPhysical: true });
}

function openGotoBar() {
    const pop = document.getElementById('gotoPopover');
    if (!pop) return;
    pop.classList.add('open');
    pop.setAttribute('aria-hidden', 'false');
    // goto 基于真实 PDF 页号
    const total = store.totalPages || (store.pageFlip && store.pageFlip.getPageCount()) || 1;
    const totalEl = document.getElementById('gotoTotal');
    if (totalEl) totalEl.textContent = `/ ${total}`;
    const cur = store.pageFlip ? pdfPageAt(store.pageFlip.getCurrentPageIndex()) : 1;
    const input = document.getElementById('gotoInput');
    if (input) { input.value = cur; input.max = total; setTimeout(() => input.focus(), 50); }
}

function closeGotoBar() {
    const pop = document.getElementById('gotoPopover');
    if (!pop) return;
    pop.classList.remove('open');
    pop.setAttribute('aria-hidden', 'true');
}

function toggleGotoBar() {
    const pop = document.getElementById('gotoPopover');
    if (!pop) return;
    if (pop.classList.contains('open')) closeGotoBar();
    else openGotoBar();
}

// ========== 翻页滑块（PC 页码标记常驻；移动端拖动/悬停时显示） ==========
let pageSliderTipTimer = null;

function positionPageSliderTip() {
    const slider = document.getElementById('pageSlider');
    const tip = document.getElementById('pageSliderTip');
    const bar = document.getElementById('pageSliderBar');
    if (!slider || !tip || !bar) return;

    const min = parseInt(slider.min, 10);
    const max = parseInt(slider.max, 10);
    const val = parseInt(slider.value, 10);
    const total = Number.isFinite(max) ? max : 1;
    const pct = max > min ? (val - min) / (max - min) : 0;
    const sliderRect = slider.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const thumbW = isMobileFn() ? 36 : 16;
    const x = sliderRect.left - barRect.left + thumbW / 2 + pct * (sliderRect.width - thumbW);

    tip.style.left = `${x}px`;
    tip.textContent = `${val} / ${total}`;
}

function setupPageSlider() {
    const slider = document.getElementById('pageSlider');
    const tip = document.getElementById('pageSliderTip');
    const bar = document.getElementById('pageSliderBar');
    if (!slider) return;
    // 滑块基于真实 PDF 页号（页码不变），total 用 PDF 页数，value 用当前真实页号。
    const total = store.totalPages || (store.pageFlip && store.pageFlip.getPageCount()) || 1;
    slider.max = total;
    const cur = store.pageFlip ? pdfPageForSlider(store.pageFlip.getCurrentPageIndex()) : 1;
    slider.value = cur;

    const showTip = () => {
        if (!tip) return;
        tip.classList.add('show');
        if (pageSliderTipTimer) clearTimeout(pageSliderTipTimer);
    };

    const hideTip = () => {
        if (!tip) return;
        pageSliderTipTimer = setTimeout(() => tip.classList.remove('show'), 600);
    };

    // 移动端拖动时按帧合并跳页请求，避免每个 pointermove 都重复执行完整翻页流程。
    let pendingSliderTarget = null;
    let sliderFlipRaf = null;
    let sliderCanvasRequestId = 0;
    const hasPageCanvas = (pageNumber) => !!document.querySelector(
        `#flipbook .page[data-page-num="${pageNumber}"] canvas`
    );
    const flipMobileSliderTargetWhenReady = (target) => {
        const requestId = ++sliderCanvasRequestId;
        if (hasPageCanvas(target)) {
            flipToDisplayedPage(target, 'slider');
            return;
        }

        // 未绘制页先升到 PDF 渲染队首，Canvas 插入占位后才真正翻页，避免跳入空白页。
        void requestPriorityPageCanvas(target, { replacePending: true }).then((ready) => {
            if (!ready || requestId !== sliderCanvasRequestId || !isMobileFn() || !store.pageFlip) return;
            if (parseInt(slider.value, 10) !== target) return;
            const currentIndex = store.pageFlip.getCurrentPageIndex?.();
            const currentPage = Number.isInteger(currentIndex) ? pdfPageForSlider(currentIndex) : null;
            if (currentPage !== target) flipToDisplayedPage(target, 'slider');
        });
    };
    const commitSliderTarget = () => {
        const target = pendingSliderTarget;
        pendingSliderTarget = null;
        sliderFlipRaf = null;
        if (!Number.isInteger(target) || !store.pageFlip) return;
        const currentIndex = store.pageFlip.getCurrentPageIndex?.();
        const currentPage = Number.isInteger(currentIndex) ? pdfPageForSlider(currentIndex) : null;
        if (isMobileFn()) {
            // 每次新的滑块目标都会使旧的 Canvas 等待结果失效，防止拖动结束后跳回旧页。
            if (currentPage === target) {
                sliderCanvasRequestId++;
                return;
            }
            flipMobileSliderTargetWhenReady(target);
            return;
        }
        if (currentPage !== target) flipToDisplayedPage(target, 'slider');
    };
    const flushSliderTarget = () => {
        if (sliderFlipRaf != null) {
            cancelAnimationFrame(sliderFlipRaf);
            sliderFlipRaf = null;
        }
        commitSliderTarget();
    };
    const scheduleSliderTarget = (target) => {
        if (!Number.isInteger(target)) return;
        pendingSliderTarget = target;
        if (sliderFlipRaf == null) sliderFlipRaf = requestAnimationFrame(commitSliderTarget);
    };

    slider.addEventListener('input', () => {
        const target = parseInt(slider.value, 10);
        if (store.pageFlip) {
            if (isMobileFn()) scheduleSliderTarget(target);
            else flipToDisplayedPage(target, 'slider');
        }
        positionPageSliderTip();
        showTip();
        if (bar) bar.setAttribute('aria-valuenow', String(target));
    });
    slider.addEventListener('change', hideTip);
    slider.addEventListener('pointerdown', () => { positionPageSliderTip(); showTip(); });
    slider.addEventListener('pointerup', hideTip);
    // 鼠标悬停在滑块（含 thumb 圆钮）上即显示页码 tooltip，移出后隐藏，提升可发现性。
    slider.addEventListener('mouseenter', () => { positionPageSliderTip(); showTip(); });
    slider.addEventListener('mouseleave', hideTip);

    // 移动端点击滑轨空白位置时，部分 iOS 浏览器不会按原生 range 的默认行为跳转。
    // 这里统一按触点位置计算页码，并接管后续 pointermove，使点击和拖动行为一致。
    if (bar && !bar.dataset.sliderTrackBound) {
        let activePointerId = null;

        const updateSliderFromClientX = (clientX) => {
            if (!Number.isFinite(clientX)) return;
            const rect = slider.getBoundingClientRect();
            const thumbWidth = isMobileFn() ? 36 : 16;
            const start = rect.left + thumbWidth / 2;
            const end = rect.right - thumbWidth / 2;
            const usableWidth = end - start;
            if (usableWidth <= 0) return;

            const min = Number(slider.min);
            const max = Number(slider.max);
            const safeMin = Number.isFinite(min) ? min : 1;
            const safeMax = Number.isFinite(max) && max >= safeMin ? max : safeMin;
            const ratio = Math.max(0, Math.min(1, (clientX - start) / usableWidth));
            const target = Math.round(safeMin + ratio * (safeMax - safeMin));
            if (String(target) !== slider.value) {
                slider.value = String(target);
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                positionPageSliderTip();
                showTip();
            }
        };

        bar.addEventListener('pointerdown', (event) => {
            if (!isMobileFn() || !event.isPrimary) return;
            activePointerId = event.pointerId;
            bar.setPointerCapture?.(event.pointerId);
            event.preventDefault();
            updateSliderFromClientX(event.clientX);
        }, { passive: false });

        bar.addEventListener('pointermove', (event) => {
            if (!isMobileFn() || event.pointerId !== activePointerId) return;
            event.preventDefault();
            updateSliderFromClientX(event.clientX);
        }, { passive: false });

        const releaseSliderPointer = (event) => {
            if (event.pointerId !== activePointerId) return;
            activePointerId = null;
            if (bar.hasPointerCapture?.(event.pointerId)) bar.releasePointerCapture(event.pointerId);
            flushSliderTarget();
            hideTip();
        };
        bar.addEventListener('pointerup', releaseSliderPointer);
        bar.addEventListener('pointercancel', releaseSliderPointer);
        bar.dataset.sliderTrackBound = 'true';
    }

    // 初始定位一次（应对窗口变化后 thumb 位置）
    positionPageSliderTip();
    window.addEventListener('resize', positionPageSliderTip, { passive: true });
}

// 翻页事件回调：把滑块位置同步到当前页（不触发 flip 避免回环）
function syncPageSlider(currentPage) {
    const slider = document.getElementById('pageSlider');
    const bar = document.getElementById('pageSliderBar');
    if (!slider) return;
    if (parseInt(slider.value, 10) !== currentPage) slider.value = currentPage;
    positionPageSliderTip();
    if (bar) bar.setAttribute('aria-valuenow', String(currentPage));
}

// ========== 放大后鼠标拖拽平移（替代原生滚动条） ==========
// 仅在 PC 且 zoom > 1 时生效；使用 Pointer Capture 保证指针移出页面后仍能连续拖动。
// 超过阈值才认定为拖拽，并屏蔽松手后浏览器生成的 click，避免拖动画面时误触发翻页。
function setupPan() {
    const bc = document.querySelector('.book-container');
    if (!bc) return;
    let panning = false;
    let dragged = false;
    let activePointerId = null;
    let startX = 0, startY = 0, startScrollLeft = 0, startScrollTop = 0;

    bc.addEventListener('scroll', schedulePcPageArrowScrollSync, { passive: true });

    bc.addEventListener('pointerdown', (e) => {
        if ((window.__app && window.__app.isMobile) || store.currentZoom <= 1) return;
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        if (isInteractiveBookTarget(e.target)) return;

        panning = true;
        dragged = false;
        activePointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        startScrollLeft = bc.scrollLeft;
        startScrollTop = bc.scrollTop;
        cancelPendingPcFlipClick();
        bc.classList.add('grabbing');
    });

    window.addEventListener('pointermove', (e) => {
        if (!panning || e.pointerId !== activePointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragged && Math.hypot(dx, dy) >= 5) {
            dragged = true;
            try { bc.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        }
        if (!dragged) return;
        bc.scrollLeft = startScrollLeft - dx;
        bc.scrollTop = startScrollTop - dy;
        e.preventDefault();
    });

    const finishPan = (e) => {
        if (!panning || (e.pointerId != null && e.pointerId !== activePointerId)) return;
        const pointerId = activePointerId;
        panning = false;
        activePointerId = null;
        bc.classList.remove('grabbing');
        if (dragged) {
            // click 紧跟 pointerup 派发；保留短窗口覆盖慢设备事件队列。
            suppressPcFlipClickUntil = performance.now() + 450;
            cancelPendingPcFlipClick();
            const selection = window.getSelection && window.getSelection();
            if (selection && !selection.isCollapsed) selection.removeAllRanges();
            e.preventDefault();
        }
        try {
            if (pointerId != null && bc.hasPointerCapture(pointerId)) bc.releasePointerCapture(pointerId);
        } catch (err) { /* ignore */ }
    };

    window.addEventListener('pointerup', finishPan);
    window.addEventListener('pointercancel', finishPan);
}

function setupShareFeature() {
    const shareBtn = document.getElementById('shareBtn');
    const toast = document.getElementById('shareToast');
    const toastClose = document.getElementById('shareToastClose');
    if (!shareBtn) return;

    if (toastClose) {
        toastClose.addEventListener('click', () => toast && toast.classList.remove('show'));
    }

    shareBtn.addEventListener('click', doShare);
}

function getCurrentPhysicalPageIndex() {
    const storedIndex = Number(store.currentPageIndex);
    if (Number.isInteger(storedIndex) && storedIndex >= 0) return storedIndex;
    const pageFlipIndex = store.pageFlip?.getCurrentPageIndex?.();
    return Number.isInteger(pageFlipIndex) && pageFlipIndex >= 0 ? pageFlipIndex : 0;
}

function buildShareLink(pdfName, physicalIndex = getCurrentPhysicalPageIndex()) {
    // 分享页码用「真实 PDF 页号」（插入页返回前一 PDF 页号），保证分享/恢复页码不变。
    const page = pdfPageAt(physicalIndex);
    const target = new URL(location.origin + location.pathname);
    const inheritedKeys = [
        'utm_source', 'utm_content', 'utm_campaign', 'utm_term',
        'se_sr', 'se_md', 'se_ct', 'se_tr', 'referral',
    ];
    const current = new URLSearchParams(location.search);
    for (const key of inheritedKeys) {
        if (current.has(key)) target.searchParams.set(key, current.get(key));
    }
    target.searchParams.set('file', pdfName);
    target.searchParams.set('page', String(page));
    target.searchParams.set('utm_medium', 'share');
    return target.toString();
}

let downloadInFlight = false;
let pendingWechatIosDownload = null;
let wechatIosDownloadGuideInitialized = false;
let wechatIosDownloadLastFocused = null;

function isWeChatBrowser() {
    return /MicroMessenger|WeChatDevTools/i.test(navigator.userAgent || '');
}

function isIOSDevice() {
    const userAgent = navigator.userAgent || '';
    return /iPhone|iPad|iPod/i.test(userAgent)
        || (/Macintosh/i.test(userAgent) && Number(navigator.maxTouchPoints) > 1);
}

function getDownloadFileName(pdfName, url) {
    const baseName = String(pdfName || '').trim().split(/[\\/]/).pop().toLowerCase();
    if (baseName === DEFAULT_PDF_NAME.toLowerCase()) return DEFAULT_DOWNLOAD_FILE_NAME;
    let value = String(pdfName || '').trim();
    try { value = decodeURIComponent(value); } catch (e) { /* 保留原始值 */ }
    value = value.split(/[?#]/, 1)[0].replace(/\\/g, '/');
    value = value.slice(value.lastIndexOf('/') + 1);
    if (!value) {
        try { value = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (e) { /* ignore */ }
    }
    // download 属性不能包含路径或控制字符，否则部分浏览器会拒绝下载。
    value = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '');
    if (!value) value = 'whitepaper.pdf';
    if (!/\.pdf$/i.test(value)) value += '.pdf';
    return value;
}

function supportsDownloadAttribute() {
    return typeof HTMLAnchorElement !== 'undefined'
        && 'download' in document.createElement('a');
}

function triggerDownloadLink(url, fileName, { download = true, newTab = false } = {}) {
    if (download && !supportsDownloadAttribute()) return false;
    const anchor = document.createElement('a');
    anchor.href = url;
    if (download && supportsDownloadAttribute()) anchor.download = fileName;
    if (newTab) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
    }
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    try {
        anchor.click();
        return true;
    } catch (error) {
        console.warn('[download] 直链触发失败：', error);
        return false;
    } finally {
        if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
    }
}

function isValidFileSize(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function fileSizeBytesToKb(value) {
    return isValidFileSize(value) ? Math.round((value / 1024) * 100) / 100 : null;
}

function trackFileDownload(pdfName, url, fileName, fileSize = null) {
    track('file_download', {
        // 文件标识类字段统一使用 se_pdf_view_plugin 中的正式配置，
        // 避免本地预览地址覆盖 file_url。
        file_size: fileSizeBytesToKb(fileSize),
    });
}

function closeWechatIosDownloadGuide() {
    const guide = document.getElementById('wechatIosDownloadGuide');
    if (!guide || guide.hidden) return;
    guide.hidden = true;
    pendingWechatIosDownload = null;
    if (wechatIosDownloadLastFocused && typeof wechatIosDownloadLastFocused.focus === 'function') {
        wechatIosDownloadLastFocused.focus({ preventScroll: true });
    }
    wechatIosDownloadLastFocused = null;
}

async function copyWechatIosDownloadLink() {
    const link = pendingWechatIosDownload?.pageUrl;
    if (!link) return;

    let copied = false;
    try {
        await navigator.clipboard.writeText(link);
        copied = true;
    } catch (error) {
        let textarea = null;
        try {
            textarea = document.createElement('textarea');
            textarea.value = link;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            copied = document.execCommand('copy');
        } catch (fallbackError) {
            copied = false;
        } finally {
            if (textarea) textarea.remove();
        }
    }
    showShareToast(copied ? '页面链接已复制，请粘贴到浏览器打开' : '复制失败，请使用微信右上角菜单打开');
}

function continueWechatIosDownload() {
    if (!pendingWechatIosDownload) return;
    // “继续”仅收起提示；用户随后通过微信右上角菜单在系统浏览器打开当前阅读页，
    // 再点击下载即可走普通移动浏览器的强制下载流程。
    closeWechatIosDownloadGuide();
}

function setupWechatIosDownloadGuide() {
    if (wechatIosDownloadGuideInitialized) return;
    const guide = document.getElementById('wechatIosDownloadGuide');
    const copyButton = document.getElementById('wechatIosCopyDownloadLink');
    const continueButton = document.getElementById('wechatIosContinueDownload');
    if (!guide || !copyButton || !continueButton) return;

    wechatIosDownloadGuideInitialized = true;
    copyButton.addEventListener('click', copyWechatIosDownloadLink);
    continueButton.addEventListener('click', continueWechatIosDownload);
    guide.addEventListener('click', (event) => {
        if (event.target === guide) closeWechatIosDownloadGuide();
    });
    guide.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeWechatIosDownloadGuide();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [copyButton, continueButton];
        const currentIndex = focusable.indexOf(document.activeElement);
        if (event.shiftKey && currentIndex <= 0) {
            event.preventDefault();
            continueButton.focus();
        } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
            event.preventDefault();
            copyButton.focus();
        }
    });
}

function openWechatDownloadGuide(download) {
    // 清理旧版本遗留的下载中转参数，确保微信右上角菜单交给外部浏览器的是阅读页本身。
    const pageUrl = new URL(window.location.href);
    pageUrl.searchParams.delete('se_download');
    if (pageUrl.href !== window.location.href && window.history?.replaceState) {
        window.history.replaceState(window.history.state, '', pageUrl);
    }

    setupWechatIosDownloadGuide();
    const guide = document.getElementById('wechatIosDownloadGuide');
    const continueButton = document.getElementById('wechatIosContinueDownload');
    if (!guide || !continueButton) {
        showShareToast('请点击微信右上角菜单，在浏览器中打开后下载');
        return;
    }

    pendingWechatIosDownload = { ...download, pageUrl: pageUrl.href };
    wechatIosDownloadLastFocused = document.activeElement;
    guide.hidden = false;
    continueButton.focus({ preventScroll: true });
}

async function fetchVerifiedPdfBlob(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const blob = await response.blob();
    if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
        throw new Error(`响应类型不是 PDF：${contentType}`);
    }
    const header = await blob.slice(0, 1024).text();
    if (!header.includes('%PDF-')) throw new Error('响应内容不是 PDF 文件');
    return blob;
}

// 普通 WAP / PC 浏览器把 PDF 读取为 Blob 后强制下载；微信内只显示外部浏览器引导，
// 让用户先用系统浏览器打开当前阅读页，不在微信 WebView 内直接下载文件。
// POC 阶段下载的是原始 PDF（不含标注）。
export async function downloadPdf() {
    if (downloadInFlight) return;
    downloadInFlight = true;

    const pdfName = store.pdfName || DEFAULT_PDF_NAME;
    // 默认白皮书使用业务附件直链；带 ?file= 的自定义 PDF 继续相对于当前应用 BASE_URL 解析。
    const isDefaultPdf = pdfName.replaceAll(String.fromCharCode(92), '/').split('/').pop().toLowerCase() === DEFAULT_PDF_NAME.toLowerCase();
    const url = isDefaultPdf ? DEFAULT_DOWNLOAD_URL : resolveAppUrl(pdfName);
    const fileName = getDownloadFileName(pdfName, url);

    try {
        if (isWeChatBrowser()) {
            openWechatDownloadGuide({ pdfName, url, fileName });
            return;
        }

        showShareToast('正在准备下载：' + fileName);
        const blob = await fetchVerifiedPdfBlob(url);
        const objectUrl = URL.createObjectURL(blob);
        try {
            if (!triggerDownloadLink(objectUrl, fileName)) throw new Error('浏览器不支持下载链接');
        } finally {
            // 移动浏览器可能延迟接管 Blob 下载，保留一分钟再释放对象 URL。
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        }
        showShareToast('已开始下载：' + fileName);
        trackFileDownload(pdfName, url, fileName, blob.size);
    } catch (e) {
        console.error('下载失败:', e);
        showShareToast('下载失败：' + fileName);
    } finally {
        // 防止连续点击重复触发下载，同时不阻塞用户稍后再次下载。
        setTimeout(() => { downloadInFlight = false; }, 400);
    }
}

let shareToastTimer = null;
function showShareToast(message) {
    const toast = document.getElementById('shareToast');
    const text = document.getElementById('shareToastText');
    if (!toast || !text) return;
    text.textContent = message;
    toast.classList.add('show');
    if (shareToastTimer) clearTimeout(shareToastTimer);
    shareToastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 把模块级共享函数挂为 App 原型方法，使 App 实例（如 this.applyZoom）与模块级调用一致，
// 避免两套实现分裂。
App.prototype.applyZoom = applyZoom;
App.prototype.centerOverflow = centerOverflow;
App.prototype.toggleFullscreen = toggleFullscreen;
App.prototype.syncAfterLayoutChange = syncAfterLayoutChange;
App.prototype.performSearch = performSearch;
App.prototype.doShare = doShare;
App.prototype.downloadPdf = downloadPdf;
App.prototype.openZoomBar = openZoomBar;
App.prototype.closeZoomBar = closeZoomBar;
App.prototype.toggleZoomBar = toggleZoomBar;
App.prototype.goToPage = goToPage;
App.prototype.openGotoBar = openGotoBar;
App.prototype.closeGotoBar = closeGotoBar;
App.prototype.toggleGotoBar = toggleGotoBar;
App.prototype.setupPageSlider = setupPageSlider;
App.prototype.setupPan = setupPan;
App.prototype.syncPageSlider = syncPageSlider;
App.prototype.toggleInsertedPages = toggleInsertedPages;
App.prototype.updateInsertIconState = updateInsertIconState;
App.prototype.flipToIndex = flipToIndex;

export { App };

// 自启动：入口由 main.js 的 import 触发本模块执行，这里直接启动单例。
const app = new App();
app.start().catch((err) => {
    console.error('初始化失败:', err);
});
