// PDF 引擎模块（步骤3-3：抽 pdf-engine.js）。
// 平台无关：负责 PDF 加载、逐页 Canvas/TextLayer 渲染、page-flip 实例创建。
// 不出现任何 isMobile 判定；平台差异通过参数传入（renderTextLayer 布尔、createPageFlip 的 mode）。
//
// 依赖：pdfjsLib / PageFlip 由调用方（main.js）注入构造参数或在本文件顶部 import。
// 为避免 pdf-engine 反向依赖入口全局配置，这里直接 import 所需库（与 main.js 共用同一份实例）。

import { PageFlip } from 'page-flip';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { store } from './state.js';
import { buildInsertPage } from './insert-engine.js';
import { resolveAppUrl } from './app-url.js';

const DEFAULT_PDF_NAME = '“化”解之道-赢得化工企业绿色竞争力转型.pdf';
const PDF_RANGE_CHUNK_SIZE = 256 * 1024;
// 线性化 PDF 的首段通常大于默认分片；一次取够首段可减少微信/高延迟网络下的往返次数。
const PDF_BOOTSTRAP_RANGE_SIZE = 2 * 1024 * 1024;
const BASE_RENDER_SCALE = 1.5;
// sample.pdf 是固定的 A4 文档。首屏先用该稳定比例建立 PageFlip，真实第一页尺寸随后校正。
const DEFAULT_PAGE_WIDTH = 595.276;
const DEFAULT_PAGE_HEIGHT = 841.89;
// PDF.js 官方 HiDPI 渲染方式：Canvas 后备像素覆盖页面实际 CSS 尺寸 × devicePixelRatio。
// 页面在本项目中通常比 scale=1.5 的 viewport 小，因此先计入布局缩放再限制到 2，
// 可避免几十页 Canvas 在 3x/4x DPR 下无意义地按完整 viewport 倍增、耗尽内存。
const MAX_INITIAL_CANVAS_OUTPUT_SCALE = 2;
const MAX_ZOOM_CANVAS_OUTPUT_SCALE = 4;
const MAX_ZOOM_CANVAS_PIXELS = 16_000_000;
// 第 1 页仍最优先；完成首次绘制后连续准备第 2、3 页，再把其余页面交给空闲调度。
const INITIAL_EAGER_PAGE_COUNT = 3;
const zoomRenderTasks = new Map();
let zoomRenderRequestId = 0;
// 渐进渲染进行中时，移动端滑块可把用户最新选择的页提升到队首。
// 等待者以 PDF 真实页码为键；同一页的多次请求共用一次 Canvas 绘制。
const pendingPriorityPages = [];
const pageCanvasWaiters = new Map();
let activePageRenderController = null;

function getFilledPageCanvas(pageNumber) {
    return document.querySelector(`#flipbook .page[data-page-num="${pageNumber}"] canvas`);
}

function settlePageCanvasWaiters(pageNumber, ready) {
    const waiters = pageCanvasWaiters.get(pageNumber);
    if (!waiters) return;
    pageCanvasWaiters.delete(pageNumber);
    waiters.forEach((resolve) => resolve(ready));
}

/**
 * 请求把尚未完成的 PDF 页提升为当前渐进渲染的最高优先级。
 * Canvas 已就绪时立即返回，避免已渲染页面的滑块跳转多一次异步等待。
 */
export function requestPriorityPageCanvas(pageNumber, { replacePending = false } = {}) {
    const page = Number(pageNumber);
    if (!Number.isInteger(page) || page < 1) return Promise.resolve(false);
    if (activePageRenderController && page > activePageRenderController.totalPages) {
        return Promise.resolve(false);
    }
    if (getFilledPageCanvas(page)) return Promise.resolve(true);

    if (replacePending) pendingPriorityPages.splice(0);
    const oldIndex = pendingPriorityPages.indexOf(page);
    if (oldIndex >= 0) pendingPriorityPages.splice(oldIndex, 1);
    pendingPriorityPages.unshift(page);
    activePageRenderController?.wakeForPriority?.();

    return new Promise((resolve) => {
        const waiters = pageCanvasWaiters.get(page) || [];
        waiters.push(resolve);
        pageCanvasWaiters.set(page, waiters);
    });
}

function getCanvasOutputScale(viewport, pageDiv, zoom = 1, minCssPixelRatio = 0) {
    const deviceScale = Number(window.devicePixelRatio) || 1;
    const layoutWidth = pageDiv.clientWidth || store.basePageWidth || viewport.width;
    const layoutHeight = pageDiv.clientHeight || store.basePageHeight || viewport.height;
    const layoutScale = Math.max(layoutWidth / viewport.width, layoutHeight / viewport.height);
    const desiredScale = Math.max(
        deviceScale * layoutScale * Math.max(1, Number(zoom) || 1),
        layoutScale * Math.max(0, Number(minCssPixelRatio) || 0),
    );
    const pixelLimitScale = Math.sqrt(MAX_ZOOM_CANVAS_PIXELS / (viewport.width * viewport.height));
    const outputLimit = zoom > 1
        ? Math.min(MAX_ZOOM_CANVAS_OUTPUT_SCALE, pixelLimitScale)
        : MAX_INITIAL_CANVAS_OUTPUT_SCALE;
    return Math.max(1, Math.min(desiredScale, outputLimit));
}

function configureCanvas(canvas, viewport, outputScale) {
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.dataset.viewportWidth = String(viewport.width);
    canvas.dataset.viewportHeight = String(viewport.height);
    canvas.dataset.outputScale = String(outputScale);
}

function releaseCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
}

/**
 * PDF.js 传入 url 时会先发起一个不带 Range 的整文件 GET，再根据响应头决定是否取消并改用 Range。
 * 在高延迟公网链路上，取消信号可能很晚才生效，导致首个请求几乎下载完整个 PDF。
 * 此传输器从第一个数据请求起就显式携带 Range，彻底绕过 PDF.js 的整文件探测请求。
 */
class HttpPdfRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    constructor({ url, length, initialData, etag, filename }) {
        // progressiveDone=true：没有整文件渐进流，后续数据全部由 requestDataRange 提供。
        super(length, initialData, true, filename);
        this.url = url;
        this.etag = etag;
        this.controllers = new Set();
        this.aborted = false;
    }

    requestDataRange(begin, end) {
        const controller = new AbortController();
        this.controllers.add(controller);

        const load = async (attempt = 0) => {
            try {
                const headers = { Range: `bytes=${begin}-${end - 1}` };
                if (this.etag) headers['If-Range'] = this.etag;

                const response = await fetch(this.url, {
                    headers,
                    signal: controller.signal,
                });
                if (response.status !== 206) {
                    await response.body?.cancel().catch(() => {});
                    throw new Error(`Range 请求应返回 206，实际为 ${response.status}`);
                }

                const contentRange = parseContentRange(response.headers.get('Content-Range'));
                if (!contentRange || contentRange.begin !== begin || contentRange.end + 1 !== end) {
                    throw new Error(`Range 响应区间不匹配：${response.headers.get('Content-Range') || '缺失'}`);
                }

                const chunk = new Uint8Array(await response.arrayBuffer());
                if (chunk.byteLength !== end - begin) {
                    throw new Error(`Range 响应长度不匹配：期望 ${end - begin}，实际 ${chunk.byteLength}`);
                }
                if (!this.aborted) this.onDataRange(begin, chunk);
            } catch (error) {
                if (controller.signal.aborted || this.aborted) return;
                // 短暂网络抖动只重试一次；避免单个分片偶发失败让 PDF.js 永久等待。
                if (attempt === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 150));
                    return await load(1);
                }
                console.error(`[PDF Range] ${begin}-${end - 1} 加载失败`, error);
                // PDFDataRangeTransport 没有错误回调；空分片可让读取流程结束并由 PDF.js 报出加载错误，
                // 比保持 pending 状态导致界面一直等待更可控。
                this.onDataRange(begin, new Uint8Array());
            } finally {
                this.controllers.delete(controller);
            }
        };

        void load();
    }

    abort() {
        this.aborted = true;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
    }
}

function parseContentRange(value) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value || '');
    if (!match) return null;
    const begin = Number(match[1]);
    const end = Number(match[2]);
    const length = Number(match[3]);
    if (![begin, end, length].every(Number.isSafeInteger) || begin > end || end >= length) return null;
    return { begin, end, length };
}

/**
 * 用首个明确的 206 请求同时取得 PDF 头部数据和总长度。
 * 若服务器不支持标准 Range，则立即取消该响应，并回退到 PDF.js 默认 URL 加载器。
 */
async function createPdfRangeTransport(pdfUrl, pdfName) {
    const controller = new AbortController();
    const rangeEnd = PDF_BOOTSTRAP_RANGE_SIZE - 1;
    const response = await fetch(pdfUrl, {
        headers: { Range: `bytes=0-${rangeEnd}` },
        signal: controller.signal,
    });
    const contentRange = parseContentRange(response.headers.get('Content-Range'));

    if (response.status !== 206 || !contentRange || contentRange.begin !== 0) {
        controller.abort();
        console.warn('[PDF Range] 服务器未返回有效 206，回退到 PDF.js 默认加载器。');
        return null;
    }

    const initialData = new Uint8Array(await response.arrayBuffer());
    if (initialData.byteLength !== contentRange.end + 1) {
        throw new Error(`PDF 首分片长度不匹配：期望 ${contentRange.end + 1}，实际 ${initialData.byteLength}`);
    }

    return new HttpPdfRangeTransport({
        url: pdfUrl,
        length: contentRange.length,
        initialData,
        etag: response.headers.get('ETag'),
        filename: pdfName.split(/[\\/]/).pop(),
    });
}

/**
 * 将后台页渲染让到浏览器空闲窗口，每个空闲窗口只启动一页。
 * requestIdleCallback 不可用时退化为短延时，仍确保主线程有机会完成绘制和交互。
 */
function waitForBrowserIdle() {
    return new Promise((resolve) => {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => resolve(), { timeout: 300 });
        } else {
            setTimeout(resolve, 16);
        }
    });
}

/**
 * 在已按序排布好的 PDF .page 占位之间插入「插入页」iframe 占位，并返回最终 seq。
 * 用于 createPageFlip 占位阶段：buildPagePlaceholders 已把 PDF 占位 append 到 flipbookEl
 * （data-page-num = PDF 页号），此处按 store.insertedPages 的 afterPage 把插入页插到目标
 * PDF 页之后（afterPage=0 插最前），并把 DOM 重排为最终顺序，供 loadFromHTML 使用。
 * 插入页不含 data-page-num，故 refillPages 按号填回时会自动跳过它们。
 * @param {HTMLElement} flipbookEl  #flipbook 容器（其 .page 为 PDF 占位 + 可能的补位）
 * @param {HTMLElement[]} pdfPlaceholders  buildPagePlaceholders 返回的 PDF 占位数组
 * @returns {HTMLElement[]} 最终顺序的 .page 序列
 */
function applyInsertionsToDom(flipbookEl, pdfPlaceholders, insertions) {
    if (!insertions || insertions.length === 0) return pdfPlaceholders;
    // 用 buildInsertPage 造插入页节点（先不挂 DOM，后面按序插入）。
    // 策略 S3：插入页宽 = 单页宽，双页展开时占一侧，另一侧由相邻 PDF 页补齐，
    // 因此给插入页设置与 PDF 单页一致的宽高比，保证 page-flip 测量尺寸正确、视频比例不被破坏。
    const insNodes = insertions.map((it) => {
        const node = buildInsertPage(it.htmlUrl, it.title);
        if (store.pdfBaseWidth && store.pdfBaseHeight) {
            node.style.aspectRatio = `${store.pdfBaseWidth} / ${store.pdfBaseHeight}`;
        }
        return node;
    });
    // 组装最终 seq（PDF 占位对象被原样引用）
    const seq = [];
    // afterPage === 0 插最前
    insertions.forEach((it, idx) => {
        if (it.afterPage === 0) seq.push(insNodes[idx]);
    });
    pdfPlaceholders.forEach((p, i) => {
        seq.push(p);
        const pageNum = i + 1;
        insertions.forEach((it, idx) => {
            if (it.afterPage === pageNum) seq.push(insNodes[idx]);
        });
    });
    // 按 seq 顺序重排 DOM
    seq.forEach((node) => flipbookEl.appendChild(node));
    return seq;
}

/**
 * 加载 public 目录下的 PDF。
 * 支持 URL 参数 ?file=xxx.pdf 指定文件（分享链接携带），默认 sample.pdf。
 * 返回 { pdf, totalPages }。PDF 基础尺寸（单页宽高）写入 store.pdfBaseWidth/Height。
 */
export async function loadPdf() {
    const urlParams = new URLSearchParams(window.location.search);
    const pdfName = urlParams.get('file') || DEFAULT_PDF_NAME;
    const requestedPage = Number.parseInt(urlParams.get('page'), 10);
    const priorityPage = Number.isInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1;
    const pdfUrl = resolveAppUrl(pdfName);
    console.log('Loading PDF from:', pdfUrl);

    performance.mark('pdf-load-start');

    performance.mark('pdf-range-bootstrap-start');
    const rangeTransport = await createPdfRangeTransport(pdfUrl, pdfName);
    performance.mark('pdf-range-bootstrap-ready');
    performance.measure('pdf-range-bootstrap', 'pdf-range-bootstrap-start', 'pdf-range-bootstrap-ready');
    const bootstrapMeasure = performance.getEntriesByName('pdf-range-bootstrap').at(-1);
    console.info(`[perf] PDF first Range ready: ${Math.round(bootstrapMeasure?.duration || 0)} ms`);

    const pdf = await pdfjsLib.getDocument({
        ...(rangeTransport ? { range: rangeTransport, docBaseUrl: pdfUrl } : { url: pdfUrl }),
        // 自定义传输保证首个 PDF 数据请求就是 206；同时禁止整文件流和无关页自动预取。
        // 256 KiB 比默认 64 KiB 更适合当前 HTTP/1.1 公网链路，可减少首屏所需的往返次数。
        disableRange: false,
        disableStream: true,
        disableAutoFetch: true,
        rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
        // PDF.js v6 默认不解析注释，需显式开启 AnnotationMode，否则 getAnnotations() 返回空数组
        // ENABLE 表示解析全部注释（含链接），便于后续叠加链接热区
        annotationMode: (pdfjsLib.AnnotationMode && pdfjsLib.AnnotationMode.ENABLE) || 1,
    }).promise;
    performance.mark('pdf-document-ready');
    performance.measure('pdf-document-load', 'pdf-load-start', 'pdf-document-ready');
    const documentMeasure = performance.getEntriesByName('pdf-document-load').at(-1);
    console.info(`[perf] PDF document ready: ${Math.round(documentMeasure?.duration || 0)} ms`);
    const totalPages = pdf.numPages;

    // 默认首页使用已知 A4 比例立即继续创建 PageFlip，避免首屏再等待一次 getPage(1) 的 Range。
    // 非默认 PDF 仍同步取得真实尺寸，确保自定义文件不会因未知比例变形。
    const isDefaultPdf = pdfName.split(/[\\/]/).pop().toLowerCase() === DEFAULT_PDF_NAME;
    // 分享深链优先取得当前目标页，避免首页请求抢占首屏 Range 带宽。
    const firstPagePromise = pdf.getPage(Math.min(priorityPage, totalPages));
    if (isDefaultPdf) {
        store.pdfBaseWidth = DEFAULT_PAGE_WIDTH;
        store.pdfBaseHeight = DEFAULT_PAGE_HEIGHT;
        void firstPagePromise.then((firstPage) => {
            const baseViewport = firstPage.getViewport({ scale: 1.0 });
            store.pdfBaseWidth = baseViewport.width;
            store.pdfBaseHeight = baseViewport.height;
        }).catch((error) => {
            console.warn('[PDF] 默认首页尺寸后台校正失败，将继续使用 A4 比例：', error);
        });
    } else {
        const firstPage = await firstPagePromise;
        const baseViewport = firstPage.getViewport({ scale: 1.0 });
        store.pdfBaseWidth = baseViewport.width;
        store.pdfBaseHeight = baseViewport.height;
    }

    const fileSize = Number.isSafeInteger(rangeTransport?.length) && rangeTransport.length >= 0
        ? rangeTransport.length
        : null;
    return { pdf, totalPages, fileSize };
}

/**
 * 渐进渲染（lazy loading）：
 *  - 阶段A：先同步创建全部 N 个空 .page 占位（含正确宽高比，避免 page-flip 算 0 尺寸），
 *    立即 append；随后回调 onPlaceholdersReady（调用方据此一次性建立翻页器，认识全部页）。
 *  - 阶段B：后台逐页渲染 Canvas + TextLayer，按 data-page-num 填回对应占位 .page。
 *    全程不 destroy/重建翻页器，因此翻页不会越界、不会白屏；未渲染页先空白、随后补全。
 *
 * @param {object} pdf            pdfjs 文档对象
 * @param {number} totalPages     总页数
 * @param {object} opts
 * @param {boolean} opts.renderTextLayer  是否渲染 PDF.js 文本层（PC/手机均用于文字选择）
 * @param {HTMLElement} opts.flipbookEl    #flipbook 容器
 * @param {function} [opts.onPlaceholdersReady] 占位建好后回调（建翻页器 + 绑定交互）
 * @param {function} [opts.onFirstFilled]  第 1 页填充完成回调（隐藏“解析中”提示）
 * @param {function} [opts.onPageCanvasFilled] 单页 Canvas 写回回调 (pageNumber)
 * @param {function} [opts.onProgress]     进度回调 (done, total)
 */
/**
 * 创建全部空 .page 占位（含正确宽高比 + 空文本层容器），append 到 flipbookEl。
 * 供翻页器 loadFromHTML 识别全部页。重建翻页器时若旧占位已被 destroy 清空，
 * 需再次调用本函数重建占位，否则 loadFromHTML 拿到空集合 → createSpread 报错白屏。
 * @returns {HTMLElement[]} 占位 .page 元素数组
 */
export function buildPagePlaceholders(flipbookEl, totalPages, renderTextLayer, extraBlank = 0) {
    const ratio = (store.pdfBaseHeight && store.pdfBaseWidth)
        ? `${store.pdfBaseWidth} / ${store.pdfBaseHeight}`
        : '1 / 1.414';
    const placeholders = [];
    for (let i = 1; i <= totalPages; i++) {
        const pageDiv = document.createElement('div');
        pageDiv.className = 'page';
        pageDiv.dataset.pageNum = i;
        pageDiv.style.width = '100%';
        pageDiv.style.aspectRatio = ratio;       // 空占位也有正确比例尺寸
        pageDiv.style.backgroundColor = '#fff';
        // 预留空文本层容器（后续填充），避免填充时再创建导致结构不一致
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        if (!renderTextLayer) textLayerDiv.style.display = 'none';
        pageDiv.appendChild(textLayerDiv);
        flipbookEl.appendChild(pageDiv);
        placeholders.push(pageDiv);
    }
    // 奇页书补位：single 模式（PC 宽屏 usePortrait 不生效，退化为 showCover 双页书）下，
    // 偶数总页数会让尾页并入最后一幅 spread（尾页无法单页显示）。追加 1 个透明空白尾页使
    // 总页数变奇数，真正的尾页即成为落单的右页单页。该空白页对用户不可见、翻不到。
    for (let k = 1; k <= extraBlank; k++) {
        const blankDiv = document.createElement('div');
        blankDiv.className = 'page blank-page';
        blankDiv.dataset.pageNum = totalPages + k;
        blankDiv.dataset.blank = '1';
        blankDiv.style.width = '100%';
        blankDiv.style.aspectRatio = ratio;
        blankDiv.style.backgroundColor = 'transparent';
        blankDiv.style.visibility = 'hidden';
        flipbookEl.appendChild(blankDiv);
        placeholders.push(blankDiv);
    }
    return placeholders;
}

export async function renderAllPages(pdf, totalPages, {
    renderTextLayer, flipbookEl, prebuiltText,
    onPlaceholdersReady = null, onFirstFilled = null, onInitialBatchFilled = null,
    onPageCanvasFilled = null, onPriorityFilled = null, onProgress = null,
    priorityPage = 0, priorityPages = [],
} = {}) {
    // ---- 阶段A：创建全部占位 .page（瞬间，供翻页器立即建立）----
    const placeholders = buildPagePlaceholders(flipbookEl, totalPages, renderTextLayer);

    // 占位就绪：建立翻页器（认识全部页），不必等任何真实内容
    if (onPlaceholdersReady) {
        try { await onPlaceholdersReady(); } catch (e) { console.error('[render] onPlaceholdersReady 失败:', e); }
    }

    // ---- 阶段B：后台逐页渲染内容，填回占位 ----
    // 注意：onPlaceholdersReady 内的 createPageFlip 可能会按新 orientation 清空并重建 .page
    // （如单页偶页补空白尾页），因此这里必须用文档中【实时】的 .page 节点，而非阶段A 缓存的数组，
    // 否则 canvas 会被填入已脱离 DOM 的旧节点 → 首屏空白。
    const livePlaceholders = Array.from(flipbookEl.querySelectorAll('.page'));
    const initialCompleted = await refillPages(pdf, totalPages, renderTextLayer, livePlaceholders, {
        onProgress,
        onFirstFilled,
        onInitialBatchFilled,
        onPageCanvasFilled,
        onPriorityFilled,
        priorityPage,
        priorityPages,
        idleAfter: INITIAL_EAGER_PAGE_COUNT,
    });

    // 用户可能在首屏阶段触发单页→双页重建，此时上面的旧代次会主动退出。
    // 等待最新活动代次稳定完成，避免目录/缩略图在新页面尚未填充时过早生成。
    if (!initialCompleted) {
        let active = store.activeRenderPromise;
        while (active) {
            try { await active; } catch (e) { /* 错误由发起重建的调用方处理 */ }
            if (active === store.activeRenderPromise) break;
            active = store.activeRenderPromise;
        }
    }

    // 全部页 canvas 已填入占位（或个别页失败也已尽力），渐进渲染阶段结束。
    // 此后方可允许跨 orientation 重建（首/尾页单页居中），渐进渲染阶段绝不重建。
    store.renderComplete = true;
}

/**
 * 阶段B：后台逐页渲染 Canvas + 文本层，填回对应占位 .page。
 * 既用于首次渐进渲染，也用于重建翻页器后（旧 .page 被清空，重建占位后重新填充）。
 * @param {HTMLElement[]} placeholders 与页码顺序对应的 .page 占位元素
 */
export function refillPages(pdf, totalPages, renderTextLayer, placeholders, options = {}) {
    const renderGeneration = (store.renderGeneration || 0) + 1;
    store.renderGeneration = renderGeneration;
    const task = refillPagesInternal(
        renderGeneration, pdf, totalPages, renderTextLayer, placeholders, options
    );
    store.activeRenderPromise = task;
    return task;
}

async function refillPagesInternal(renderGeneration, pdf, totalPages, renderTextLayer, placeholders, {
    onProgress = null, onFirstFilled = null, onInitialBatchFilled = null, onPageCanvasFilled = null,
    onPriorityFilled = null,
    priorityPage = 0, priorityPages = [], idleAfter = null,
} = {}) {
    let firstFilled = false;
    const isCanceled = () => renderGeneration !== store.renderGeneration;
    // 优先渲染目标页（如重建后定位到的首/尾页），使其 canvas 尽快就绪，消除重建后空白停留。
    const order = [];
    const queuedPriorityPages = [];
    const seenPriorityPages = new Set();
    const addPriorityPage = (pageNumber) => {
        const page = Number(pageNumber);
        if (!Number.isInteger(page) || page < 1 || page > totalPages || seenPriorityPages.has(page)) return;
        seenPriorityPages.add(page);
        queuedPriorityPages.push(page);
    };
    // priorityPages 用于分享深链首屏同屏页；保留 priorityPage 兼容重建翻页等旧调用。
    (Array.isArray(priorityPages) ? priorityPages : []).forEach(addPriorityPage);
    addPriorityPage(priorityPage);
    queuedPriorityPages.forEach((page) => order.push(page));
    for (let i = 1; i <= totalPages; i++) {
        if (!seenPriorityPages.has(i)) order.push(i);
    }
    const initialBatchSize = Number.isInteger(idleAfter)
        ? Math.min(Math.max(idleAfter, 1), order.length)
        : 0;
    // 首批页面只预取相邻的 1 页，令 PDF 数据下载与当前页 Canvas 绘制并行，
    // 避免首页翻动后第 2 页仍要从零开始等待 getPage/Range 请求。
    const prefetchedPages = new Map();
    const requestPage = (pageNumber) => {
        if (!prefetchedPages.has(pageNumber)) {
            prefetchedPages.set(pageNumber, pdf.getPage(pageNumber));
        }
        return prefetchedPages.get(pageNumber);
    };
    const canvasJobs = new Map();
    const renderCanvas = async (pageNumber, pageDiv) => {
        const page = await requestPage(pageNumber);
        const viewport = page.getViewport({ scale: BASE_RENDER_SCALE });
        const canvas = document.createElement('canvas');
        const outputScale = getCanvasOutputScale(viewport, pageDiv);
        const renderTransform = outputScale !== 1
            ? [outputScale, 0, 0, outputScale, 0, 0]
            : null;
        configureCanvas(canvas, viewport, outputScale);
        const ctx = canvas.getContext('2d');
        await page.render({
            canvasContext: ctx,
            viewport,
            transform: renderTransform,
        }).promise;
        return { page, viewport, canvas };
    };
    // 占位 .page 可能混入插入页（无 data-page-num）。填回必须按 data-page-num 精确匹配，
    // 而非按下标 placeholders[i-1]（否则插入页会导致 PDF 内容错位）。插入页自动被跳过。
    const pageLookup = new Map();
    Array.from(placeholders || []).forEach((p) => {
        const num = p && p.dataset ? p.dataset.pageNum : undefined;
        if (num) pageLookup.set(String(num), p);
    });
    let priorityWake = null;
    const priorityController = {
        totalPages,
        wakeForPriority: () => priorityWake?.(),
    };
    activePageRenderController = priorityController;
    const takePriorityFromOrder = () => {
        while (pendingPriorityPages.length > 0) {
            const pageNumber = pendingPriorityPages.shift();
            if (getFilledPageCanvas(pageNumber)) {
                settlePageCanvasWaiters(pageNumber, true);
                continue;
            }
            const index = order.indexOf(pageNumber);
            if (index >= 0) {
                order.splice(index, 1);
                return pageNumber;
            }
        }
        return null;
    };
    const waitForIdleOrPriority = async () => {
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                if (priorityWake === finish) priorityWake = null;
                resolve();
            };
            priorityWake = finish;
            void waitForBrowserIdle().then(finish);
        });
    };
    let processedCount = 0;
    while (order.length > 0) {
        if (isCanceled()) return false;
        let i = takePriorityFromOrder();
        let isDynamicPriority = i != null;
        if (i == null) i = order.shift();
        const currentPriorityIndex = pendingPriorityPages.indexOf(i);
        if (currentPriorityIndex >= 0) {
            pendingPriorityPages.splice(currentPriorityIndex, 1);
            isDynamicPriority = true;
        }
        // 首次加载立即完成第 1 页；此后每页等待一次浏览器空闲窗口，
        // 避免连续 Canvas/TextLayer 渲染长期占用主线程、延迟首屏绘制与交互。
        if (!isDynamicPriority && Number.isInteger(idleAfter) && processedCount >= idleAfter) {
            await waitForIdleOrPriority();
            if (isCanceled()) return false;
            const waitingCurrentPriorityIndex = pendingPriorityPages.indexOf(i);
            const priorityPageNumber = waitingCurrentPriorityIndex >= 0
                ? (pendingPriorityPages.splice(waitingCurrentPriorityIndex, 1), i)
                : takePriorityFromOrder();
            if (priorityPageNumber != null && priorityPageNumber !== i) {
                order.unshift(i);
                i = priorityPageNumber;
                isDynamicPriority = true;
            } else if (priorityPageNumber === i) {
                isDynamicPriority = true;
            }
        }
        const pageDiv = pageLookup.get(String(i));
        if (!pageDiv) {
            // 该 PDF 页占位缺失（如被插入页挤占/异常），跳过此页渲染，不中断其它页。
            continue;
        }
        if (processedCount < initialBatchSize - 1) {
            const nextPageNumber = order[0];
            const nextPageDiv = pageLookup.get(String(nextPageNumber));
            if (nextPageDiv && !canvasJobs.has(nextPageNumber)) {
                const nextCanvasJob = renderCanvas(nextPageNumber, nextPageDiv);
                canvasJobs.set(nextPageNumber, nextCanvasJob);
                void nextCanvasJob.catch(() => {});
            } else {
                void requestPage(nextPageNumber).catch(() => {});
            }
        }
        const canvasJob = canvasJobs.get(i) || renderCanvas(i, pageDiv);
        canvasJobs.set(i, canvasJob);
        const { page, viewport, canvas } = await canvasJob;
        if (isCanceled()) return false;
        // a. 渲染 Canvas。首批相邻页可在前一页文字层处理期间并行绘制。
        // 按 PDF 页码保存，确保优先页/空闲调度不会打乱缩略图顺序。
        store.pageCanvases[i - 1] = canvas;

        // 填回对应占位 .page
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.backgroundColor = 'white';
        // 首屏预览图是远程加载期间的临时页面内容；真实 Canvas 到位后立即移除，
        // 避免与 Canvas 叠加或在后续翻页中残留旧封面。
        pageDiv.querySelectorAll('.page-preview-placeholder').forEach((node) => node.remove());
        // 文本层容器需置于 canvas 之上，因此插入到 pageDiv（已含空 textLayer）前先移除旧空层
        const oldText = pageDiv.querySelector('.textLayer');
        pageDiv.insertBefore(canvas, oldText);
        settlePageCanvasWaiters(i, true);
        // 仅通知 Canvas 已可用；调用方可在确有放大需求时按当前可见页补高清渲染。
        // 100% 浏览下回调会立即返回，不改变原有渐进渲染顺序，也不等待额外任务。
        if (onPageCanvasFilled) {
            try { onPageCanvasFilled(i); } catch (e) { /* 单页增强失败不阻断基础渲染 */ }
        }
        if (onPriorityFilled && i === priorityPage) {
            try { onPriorityFilled(i); } catch (e) { /* 首屏优先页回调失败不阻断渲染 */ }
        }

        if (i === 1) {
            performance.mark('pdf-first-page-canvas-ready');
            performance.measure('pdf-first-page-total', 'pdf-load-start', 'pdf-first-page-canvas-ready');
            const firstPageMeasure = performance.getEntriesByName('pdf-first-page-total').at(-1);
            console.info(`[perf] First page canvas ready: ${Math.round(firstPageMeasure?.duration || 0)} ms`);
        } else if (i <= INITIAL_EAGER_PAGE_COUNT) {
            const loadStart = performance.getEntriesByName('pdf-load-start').at(-1)?.startTime || 0;
            console.info(`[perf] Page ${i} canvas ready: ${Math.round(performance.now() - loadStart)} ms`);
        }

        if (initialBatchSize > 0 && processedCount === initialBatchSize - 1 && onInitialBatchFilled) {
            try { onInitialBatchFilled(initialBatchSize); } catch (e) {}
        }

        // Canvas 是首屏真正可见内容：插入后立即通知，不等待文本层、链接扫描等增强工作。
        // 首次加载时再让出一个浏览器空闲窗口，确保第 1 页先完成绘制后才继续增强。
        if (!firstFilled) {
            firstFilled = true;
            if (onFirstFilled) { try { onFirstFilled(); } catch (e) {} }
        }
        // b. 文本层（文字选中）
        const textLayerDiv = oldText || document.createElement('div');
        textLayerDiv.className = 'textLayer';
        if (!renderTextLayer) {
            textLayerDiv.style.display = 'none';
        }

        // 注入 css 变量
        textLayerDiv.style.setProperty('--scale-factor', viewport.scale);
        textLayerDiv.style.setProperty('--user-unit', '1');
        textLayerDiv.style.setProperty('--total-scale-factor', viewport.scale);
        textLayerDiv.style.transformOrigin = 'top left';

        // 使用 PDF.js 的 TextLayer API 创建透明文本层（仅 renderTextLayer=true 时）
        let pageTextContent = null;
        if (renderTextLayer) {
            try {
                pageTextContent = await page.getTextContent();
                if (isCanceled()) return false;
                const textLayer = new pdfjsLib.TextLayer({
                    textContentSource: pageTextContent,
                    container: textLayerDiv,
                    viewport: viewport
                });
                await textLayer.render();
                if (isCanceled()) return false;
            } catch (textErr) {
                if (textLayerDiv && textLayerDiv.parentNode) {
                    textLayerDiv.parentNode.removeChild(textLayerDiv);
                }
            }
        }

        // c. 链接热区层：扫描 PDF 正文文本层里出现的网址/邮箱文本，叠加透明可点击 <a> 热区。
        //    说明：pdf.js v6 在本项目的 sample.pdf 上 getAnnotations() 始终返回空（链接注释解析
        //    兼容性不足，但 Acrobat 能识别并点击），因此改用「文本层 URL 识别」方案——
        //    文本层本来就有精确的逐字几何信息，从文本项中提取 URL 文本并据其坐标造热区，
        //    既可靠又不依赖 annotation 解析。click_link_in_page 埋点（委托监听 .book-container
        //    内 <a>）可自动采集 link_url/link_text/page_num。
        const linkLayerDiv = document.createElement('div');
        linkLayerDiv.className = 'linkLayer';
        // 与 textLayer 一致：显式给定渲染像素尺寸，配合 transform 缩放铺满 page，
        // 否则容器 0 尺寸 + overflow:hidden 会把热区 <a> 裁剪掉导致无法点击
        linkLayerDiv.style.setProperty('width', `${viewport.width}px`, 'important');
        linkLayerDiv.style.setProperty('height', `${viewport.height}px`, 'important');
        linkLayerDiv.style.setProperty('right', 'auto', 'important');
        linkLayerDiv.style.setProperty('bottom', 'auto', 'important');
        linkLayerDiv.style.setProperty('inset', '0px auto auto 0px', 'important');
        linkLayerDiv.style.setProperty('--scale-factor', String(viewport.scale), 'important');
        linkLayerDiv.style.setProperty('--user-unit', '1');
        linkLayerDiv.style.setProperty('--total-scale-factor', String(viewport.scale), 'important');
        linkLayerDiv.style.transformOrigin = 'top left';
        try {
            // PC 复用文本层已经获取的内容，避免同一页重复解析；手机端按需获取一次。
            const textContent = pageTextContent || await page.getTextContent();
            if (isCanceled()) return false;
            const URL_RE = /(https?:\/\/[^\s]+)|(www\.[^\s]+\.[^\s]+)|(mailto:[^\s]+)/i;
            for (const it of textContent.items) {
                const str = (it.str || '').trim();
                if (!str) continue;
                const m = str.match(URL_RE);
                if (!m) continue;
                let url = m[0];
                if (/^www\./i.test(url)) url = 'https://' + url;
                // item.transform = [a,b,c,d,e,f]，e,f 为文字基线左下角（PDF 用户空间，y 向上）
                const tr = it.transform;
                if (!tr || tr.length < 6) continue;
                const fontSize = Math.hypot(tr[2], tr[3]) || 10; // 用户空间字号
                const x = tr[4];            // 文字基线左下角 x（PDF 用户空间，y 向上）
                const yBaseline = tr[5];    // 文字基线 y
                const approxW = fontSize * 0.56 * str.length; // 文本宽度近似（用户空间）
                // 纯算术坐标转换：scale=1 的页面尺寸存于 store.pdfBaseWidth/Height
                const scaleX = viewport.width / (store.pdfBaseWidth || viewport.width);
                const scaleY = viewport.height / (store.pdfBaseHeight || viewport.height);
                // PDF 用户空间(y向上) -> 屏幕像素(y向下)：文字顶部=基线+0.8字号，底部=基线-0.2字号
                const ascent = 0.8 * fontSize;
                const descent = 0.2 * fontSize;
                const pxX = x * scaleX;
                const pxTop = viewport.height - (yBaseline + ascent) * scaleY;
                const w = approxW * scaleX;
                const h = (ascent + descent) * scaleY;
                if (w <= 0 || h <= 0) continue;
                const a = document.createElement('a');
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = str; // 不可见但供埋点 link_text 取用
                a.style.position = 'absolute';
                a.style.left = `${pxX}px`;
                a.style.top = `${pxTop}px`;
                a.style.width = `${w}px`;
                a.style.height = `${h}px`;
                a.style.pointerEvents = 'auto';
                a.style.backgroundColor = 'transparent';
                a.style.color = 'transparent';
                a.style.cursor = 'pointer';
                a.style.fontSize = '0'; // 隐藏文字，仅作热区
                a.setAttribute('data-page-num', String(i));
                a.setAttribute('data-link-type', 'pdf-text-url');
                a.setAttribute('data-link-url', url);
                linkLayerDiv.appendChild(a);
            }
        } catch (linkErr) {
            console.warn('[linkLayer] 文本URL热区生成失败 page', i + 1, linkErr);
        }
        // 插入到 textLayer 之后（DOM 更靠后），配合高 z-index 确保热区在文字层之上，点击优先命中热区
        if (textLayerDiv && textLayerDiv.parentNode === pageDiv) {
            pageDiv.insertBefore(linkLayerDiv, textLayerDiv.nextSibling);
        } else {
            pageDiv.appendChild(linkLayerDiv);
        }

        // 覆盖几何属性（强制容器精确像素 + 取消 inset 拉伸）
        textLayerDiv.style.setProperty('width', `${viewport.width}px`, 'important');
        textLayerDiv.style.setProperty('height', `${viewport.height}px`, 'important');
        textLayerDiv.style.setProperty('right', 'auto', 'important');
        textLayerDiv.style.setProperty('bottom', 'auto', 'important');
        textLayerDiv.style.setProperty('inset', '0px auto auto 0px', 'important');
        textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale), 'important');
        textLayerDiv.style.setProperty('--user-unit', '1', 'important');
        textLayerDiv.style.setProperty('--total-scale-factor', String(viewport.scale), 'important');

        // 监听 pageDiv 尺寸变化，动态计算文本层 / 链接热区层缩放
        const resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                const rect = entry.contentRect;
                if (rect.width > 0) {
                    const scaleX = rect.width / viewport.width;
                    const scaleY = rect.height / viewport.height;
                    textLayerDiv.style.transform = `scale(${scaleX}, ${scaleY})`;
                    linkLayerDiv.style.transform = `scale(${scaleX}, ${scaleY})`;
                }
            }
        });
        resizeObserver.observe(pageDiv);

        if (onProgress) { try { onProgress(i, totalPages); } catch (e) {} }
        processedCount++;
    }
    if (activePageRenderController === priorityController) {
        activePageRenderController = null;
        pendingPriorityPages.splice(0).forEach((pageNumber) => {
            settlePageCanvasWaiters(pageNumber, !!getFilledPageCanvas(pageNumber));
        });
    }
    return true;
}

/**
 * 取消尚未完成的缩放高清渲染。连续拖动缩放条时只保留最后一次请求，避免主线程堆积。
 */
export function cancelZoomRerenders() {
    zoomRenderRequestId++;
    for (const job of zoomRenderTasks.values()) {
        try { job.renderTask.cancel(); } catch (error) { /* 已完成的任务无需处理 */ }
    }
    zoomRenderTasks.clear();
}

/**
 * 退出放大态时恢复原始 Canvas，并释放高清临时位图，避免用户逐页放大后持续累积内存。
 */
export function restoreBaseCanvasesAfterZoom(exceptPageNumbers = []) {
    cancelZoomRerenders();
    const keepPages = new Set((exceptPageNumbers || []).map(Number));
    document.querySelectorAll('#flipbook .page[data-page-num]').forEach((pageDiv) => {
        const pageNumber = Number(pageDiv.dataset.pageNum);
        if (keepPages.has(pageNumber)) return;
        const baseCanvas = pageDiv.__zoomBaseCanvas;
        const zoomCanvas = pageDiv.querySelector('canvas[data-zoom-render], canvas[data-quality-render]');
        if (!baseCanvas || !zoomCanvas) return;
        zoomCanvas.replaceWith(baseCanvas);
        if (Number.isInteger(pageNumber) && pageNumber >= 1) {
            store.pageCanvases[pageNumber - 1] = baseCanvas;
        }
        releaseCanvas(zoomCanvas);
        pageDiv.__zoomBaseCanvas = null;
    });
}

async function rerenderPageForZoom(pdf, pageNumber, zoom, requestId, {
    minCssPixelRatio = 0,
    renderKind = 'zoom',
} = {}) {
    const pageDiv = document.querySelector(`#flipbook .page[data-page-num="${pageNumber}"]`);
    const originalCanvas = pageDiv?.querySelector('canvas');
    if (!pageDiv || !originalCanvas || !pageDiv.isConnected || requestId !== zoomRenderRequestId) return null;

    const page = await pdf.getPage(pageNumber);
    if (requestId !== zoomRenderRequestId || !pageDiv.isConnected) return null;
    const viewport = page.getViewport({ scale: BASE_RENDER_SCALE });
    const outputScale = getCanvasOutputScale(viewport, pageDiv, zoom, minCssPixelRatio);
    const targetWidth = Math.floor(viewport.width * outputScale);
    const targetHeight = Math.floor(viewport.height * outputScale);

    // 已有 Canvas 分辨率足够时直接复用；缩小后不主动降清晰度，避免反复分配大位图。
    if (originalCanvas.width >= targetWidth && originalCanvas.height >= targetHeight) {
        return {
            pageNumber,
            zoom,
            outputScale: Number(originalCanvas.dataset.outputScale) || outputScale,
            width: originalCanvas.width,
            height: originalCanvas.height,
            reused: true,
        };
    }

    // 在离屏 Canvas 完成整页绘制后再原位替换，旧页面始终可见，不产生白屏或闪烁。
    const replacement = document.createElement('canvas');
    replacement.className = originalCanvas.className;
    replacement.style.cssText = originalCanvas.style.cssText;
    configureCanvas(replacement, viewport, outputScale);
    if (renderKind === 'quality') replacement.dataset.qualityRender = String(minCssPixelRatio);
    else replacement.dataset.zoomRender = String(zoom);
    const context = replacement.getContext('2d');
    const renderTransform = outputScale !== 1
        ? [outputScale, 0, 0, outputScale, 0, 0]
        : null;
    const renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: renderTransform,
    });
    const job = { requestId, renderTask, canvas: replacement };
    zoomRenderTasks.set(pageNumber, job);

    try {
        await renderTask.promise;
        if (requestId !== zoomRenderRequestId || !pageDiv.isConnected) {
            releaseCanvas(replacement);
            return null;
        }
        const liveCanvas = pageDiv.querySelector('canvas');
        if (!liveCanvas) {
            releaseCanvas(replacement);
            return null;
        }
        // 渐进渲染或另一任务可能已经放入更高清 Canvas；绝不以较低分辨率覆盖它。
        if (liveCanvas.width >= replacement.width && liveCanvas.height >= replacement.height) {
            releaseCanvas(replacement);
            return null;
        }
        // 首次高清替换时保留基础 Canvas；更高倍率再次替换时只释放上一张高清位图。
        if (!pageDiv.__zoomBaseCanvas) pageDiv.__zoomBaseCanvas = liveCanvas;
        else releaseCanvas(liveCanvas);
        liveCanvas.replaceWith(replacement);
        store.pageCanvases[pageNumber - 1] = replacement;
        const renderLabel = renderKind === 'quality'
            ? `${minCssPixelRatio}x quality`
            : `${Math.round(zoom * 100)}%`;
        console.info(`[zoom-render] Page ${pageNumber} @ ${renderLabel}: ${replacement.width}x${replacement.height}, outputScale=${outputScale.toFixed(2)}`);
        return {
            pageNumber,
            zoom,
            outputScale,
            width: replacement.width,
            height: replacement.height,
            reused: false,
        };
    } catch (error) {
        releaseCanvas(replacement);
        if (error?.name !== 'RenderingCancelledException') {
            console.warn(`[zoom-render] Page ${pageNumber} 高清重渲染失败`, error);
        }
        return null;
    } finally {
        if (zoomRenderTasks.get(pageNumber) === job) zoomRenderTasks.delete(pageNumber);
    }
}

/**
 * 按当前缩放倍率只重渲染可见 PDF 页。调用方传入页码而不是物理索引，插入 HTML 页自动跳过。
 */
export async function rerenderVisiblePagesForZoom(pdf, pageNumbers, zoom, options = {}) {
    const isQualityRender = options?.renderKind === 'quality'
        && Number(options?.minCssPixelRatio) > 0;
    if (!pdf || (!(zoom > 1) && !isQualityRender)
        || !Array.isArray(pageNumbers) || pageNumbers.length === 0) return [];
    cancelZoomRerenders();
    const requestId = zoomRenderRequestId;
    const uniquePages = [...new Set(pageNumbers)]
        .map(Number)
        .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pdf.numPages);
    const settled = await Promise.allSettled(
        uniquePages.map((pageNumber) => rerenderPageForZoom(pdf, pageNumber, zoom, requestId, options))
    );
    return settled.map((item) => item.status === 'fulfilled' ? item.value : null).filter(Boolean);
}

/**
 * 创建/重建 PageFlip 实例。
 * 平台无关：mode 由调用方根据 isMobile() 决定（'fixed'=手机单页 / 'stretch'=PC 双页）。
 *
 * 关键修复：stretch 模式在手机单页时会把 #flipbook 的宽高自反馈锁定在
 * minWidth(550)/minHeight(420)，导致单页被压窄、视觉偏右。
 * 因此手机单页改用 size:'fixed' 并显式给定「容器可用宽 × PDF 比例」。
 *
 * @param {HTMLElement} flipbookEl  #flipbook 容器
 * @param {'fixed'|'stretch'} mode
 * @param {function} stopPropFinal  防止文字点击冒泡触发翻页的事件拦截器
 * @returns {object} PageFlip 实例
 */
// orientation: 'double'（PC stretch 双页并排）| 'single'（单页居中，用于首/尾页）。
// mode: 'fixed'（手机单页）| 其它（PC）。单页居中只在 PC 双页体系下触发。
// startPage: 实例建立后直接定位到的绝对页索引，避免重建瞬间先闪首页(0)再翻到目标页。
// animateToPage: 可选。若提供，init 后先无动画显示 startPage（起始页），待 canvas 预填完成后
//   （由调用方在 refillPages resolve 后触发）播放翻页动画到 animateToPage。
//   用于「首页单页 → 双页」跨 orientation 重建时保留翻页动画。默认 null 走原有无动画逻辑。
export function createPageFlip(flipbookEl, mode, stopPropFinal, orientation = 'double', startPage = 0, animateToPage = null) {
    // 清掉旧实例写入的 inline 尺寸，避免自反馈锁定残留
    flipbookEl.style.width = '';
    flipbookEl.style.height = '';
    flipbookEl.style.aspectRatio = '';

    // 预计物理页数 = PDF 页数 + 插入页数（供 startPage 钳制，避免插入页使物理索引超 totalPages）。
    const effPageCount = (store.totalPages || 0) + (store.insertVisible ? (store.insertedPages ? store.insertedPages.length : 0) : 0);

    // 关键修复：page-flip 的 destroy() 会把宿主元素（#flipbook）从 DOM 中 remove()，
    // 导致重建时 document.getElementById('flipbook') 为 null、节点游离在文档外，
    // 进而 new PageFlip 内部拿不到页面集合 → setDensity 崩溃、几何测量全 null。
    // 因此 destroy 前记录父节点与位置，destroy 后把同一个节点对象重新挂回文档。
    const hostParent = flipbookEl.parentNode;
    const hostNext = flipbookEl.nextSibling;

    if (store.pageFlip && store.pageFlip.destroy) {
        try { store.pageFlip.destroy(); } catch (e) { /* ignore */ }
    }

    // 若节点已被移出文档，重新挂回原父节点（保持 #zoomWrap > #flipbook 结构）
    if (hostParent && !hostParent.contains(flipbookEl)) {
        if (hostNext && hostNext.parentNode === hostParent) {
            hostParent.insertBefore(flipbookEl, hostNext);
        } else {
            hostParent.appendChild(flipbookEl);
        }
        console.log('[center][createPageFlip] destroy 后已把 #flipbook 重新挂回文档');
    }

    let pf;
    const wantSingle = orientation === 'single' && mode !== 'fixed';
    // PC 端接管翻页（关闭库自带鼠标/触摸手势，改为自定义点击落位），避免在「单←→双」切换时
    // 库先执行一次错误模式的翻页动画（如单页先翻到第2页），再重建，造成可见闪烁。
    // 移动端保留库手势（fixed 滚动/滑动翻页体验更好）。
    const isMobileInteraction = mode === 'fixed' && !wantSingle;
    const disableGestures = !isMobileInteraction;
    // 在创建 PageFlip 前同步标记布局状态，避免首页首帧尚未完成初始化时误显示双页书脊阴影。
    flipbookEl.classList.toggle('is-double', !wantSingle);
    // 单页居中态：给 #flipbook 加类，供 CSS 限制版芯宽度并居中（覆盖 .stf__parent 的 100% 强制）
    flipbookEl.classList.toggle('single-centered', wantSingle);
    if (mode === 'fixed' && !wantSingle) {
        // 手机单页：fixed 尺寸 = 容器可用宽 × 单页 PDF 比例
        const bc = document.querySelector('.book-container');
        const pad = bc ? (parseFloat(getComputedStyle(bc).paddingLeft) || 0) * 2 : 0;
        const avail = (bc ? bc.clientWidth : window.innerWidth) - pad;
        const w = Math.max(200, Math.min(avail, 720));
        const h = w * (store.pdfBaseHeight / store.pdfBaseWidth);
        flipbookEl.style.aspectRatio = `${store.pdfBaseWidth} / ${store.pdfBaseHeight}`;
        // Keep the PageFlip render box equal to the real mobile page instead of stretching it
        // to the full viewport height. PageFlip draws animated pages at top:0 but centers a
        // settled page inside an oversized host; matching these sizes prevents the page from
        // jumping vertically when the first turn finishes.
        flipbookEl.style.width = Math.round(w) + 'px';
        flipbookEl.style.height = Math.round(h) + 'px';
        flipbookEl.style.flex = '0 0 auto';
        pf = new PageFlip(flipbookEl, {
            width: Math.round(w),
            height: Math.round(h),
            size: 'fixed',
            minWidth: Math.round(w), maxWidth: Math.round(w),
            minHeight: Math.round(h), maxHeight: Math.round(h),
            showCover: true,
            mobileScrollSupport: true,
            // Mobile gestures are handled by app.js so taps and swipes have deterministic rules.
            useMouseEvents: false,
            useTouchEvents: false,
            // HTML mode turns Canvas/iframe pages with clip-path + transforms. The library's
            // translucent shadow layers are composited separately and can make the sheet look
            // see-through while it is moving, especially in WebKit and on GPU-backed iframes.
            // Keep the page-curl geometry but render the paper itself without translucent overlays.
            drawShadow: false,
            maxShadowOpacity: 0,
            flippingTime: 750,
            swipeDistance: 30,
            // Native pointer handling is disabled above; app.js owns mobile tap/swipe rules.
            disableFlipByClick: false,
            // PageFlip otherwise paints index 0 before the async init callback can restore
            // the requested share page, which briefly exposes the cover on mobile.
            startPage: Math.max(0, Math.min(startPage, Math.max(effPageCount, 1) - 1))
        });
    } else if (wantSingle) {
        // PC 单页居中（首/尾页）：fixed 单页尺寸 + usePortrait + autoSize:false，
        // 显式设定 #flipbook 宽度 + margin:0 auto 水平居中（绕开 flex 歧义），单页居中显示。
        // 关键修复：宽度同时受「容器可用高度」约束，反算最大宽，确保单页高度 ≤ 容器可视高，
        // 避免 align-items:center + overflow:hidden 把超高页面顶部裁出屏幕。
        const bc = document.querySelector('.book-container');
        const padX = bc ? (parseFloat(getComputedStyle(bc).paddingLeft) || 0) * 2 : 0;
        const padY = bc ? (parseFloat(getComputedStyle(bc).paddingTop) || 0) * 2 : 0;
        const availW = (bc ? bc.clientWidth : window.innerWidth) - padX;
        // 可用高度：容器高减去纵向 padding 再留 16px 安全余量，避免贴边/被工具栏遮挡
        const availH = (bc ? bc.clientHeight : window.innerHeight) - padY - 16;
        const ratio = store.pdfBaseHeight / store.pdfBaseWidth; // 单页 高/宽
        const wByH = availH / ratio; // 受高度约束的最大宽度
        const maxW = Math.min(720, availW, wByH); // 不超过 720、容器宽、高度约束宽
        const w = Math.max(200, Math.round(maxW));
        const h = w * ratio;
        flipbookEl.style.aspectRatio = `${store.pdfBaseWidth} / ${store.pdfBaseHeight}`;
        flipbookEl.style.width = Math.round(w) + 'px';
        flipbookEl.style.maxWidth = '92vw';
        flipbookEl.style.margin = '0 auto';
        pf = new PageFlip(flipbookEl, {
            width: Math.round(w),
            height: Math.round(h),
            size: 'fixed',
            minWidth: Math.round(w), maxWidth: Math.round(w),
            minHeight: Math.round(h), maxHeight: Math.round(h),
            usePortrait: true,
            autoSize: false,
            showCover: true,
            mobileScrollSupport: true,
            useMouseEvents: !disableGestures,
            useTouchEvents: !disableGestures,
            drawShadow: false,
            maxShadowOpacity: 0,
            flippingTime: 750,
            swipeDistance: 30,
            disableFlipByClick: isMobileInteraction,
            startPage: Math.max(0, Math.min(startPage, effPageCount + ((effPageCount % 2 === 0) ? 1 : 0) - 1))
        });
    } else {
        // PC / 双页：stretch 自适应
        flipbookEl.style.aspectRatio = `${store.pdfBaseWidth * 2} / ${store.pdfBaseHeight}`;
        flipbookEl.style.width = 'auto';
        flipbookEl.style.height = 'auto';
        flipbookEl.style.maxWidth = '100%';
        flipbookEl.style.maxHeight = '100%';
        flipbookEl.style.margin = '';
        pf = new PageFlip(flipbookEl, {
            width: store.pdfBaseWidth,
            height: store.pdfBaseHeight,
            size: 'stretch',
            minWidth: 550,
            maxWidth: 2500,
            minHeight: 420,
            maxHeight: 2500,
            showCover: true,
            // 关键修复：双页重建时也透传 startPage，使初始渲染即目标 spread，
            // 避免先以默认首页 spread 显示一帧再动画跳转到目标页的可视闪烁。
            startPage: Math.max(0, Math.min(startPage, Math.max(effPageCount, 1) - 1)),
            useMouseEvents: !disableGestures,
            useTouchEvents: !disableGestures,
            mobileScrollSupport: true,
            drawShadow: false,
            maxShadowOpacity: 0,
            flippingTime: 750,
            swipeDistance: 30,
            disableFlipByClick: isMobileInteraction
        });
    }

    store.pageFlip = pf;
    // 暴露库的真实动画状态给样式诊断与自动回归；每次重建都会重新绑定到新实例。
    // PageFlip 事件参数是 { data: 'flipping'|'read', object }，不是直接的 state 字段。
    try {
        pf.on('changeState', (event) => {
            const live = document.getElementById('flipbook') || flipbookEl;
            if (live) live.dataset.flipState = event?.data || event?.state || '';
        });
    } catch (error) { /* 个别版本无 changeState 时不影响翻页 */ }

    // 复用 POC 经验：page-flip 的 init 事件是异步(setTimeout)触发的「真正就绪」时机。
    // 若把翻页落位放在外部的同步/setTimeout 调用里，会被 init 内部对默认位置的重置覆盖，
    // 体现为「先默认页(首页/错误页)闪一帧、再跳目标页」的可见闪烁。
    // 故将「建立后立即定位到 startPage」放入 init 回调，与库内部渲染同一步骤执行，消除中间帧。
    // justRebuilt 标记本次定位帧，防止其在 flip 事件里被误判为「离开首/尾页」而连锁重建。
    try {
        pf.on('init', () => {
            try {
                store.justRebuilt = true;
                const sp = (typeof startPage === 'number') ? startPage : 0;
                if (pf.turnToPage) pf.turnToPage(sp);
                else if (pf.flip) pf.flip(sp, false);
                if (pf.update) { try { pf.update(); } catch (e2) {} }
                // 跨 orientation 需保留翻页动画：先显示起始页（上面 turnToPage），
                // 登记待播放目标页，由调用方在 canvas 预填完成后调用 store.__triggerAnimatedFlip() 播放。
                if (animateToPage != null) {
                    store.__pendingAnimatedFlip = animateToPage;
                    // onDone: 动画结束回调（由 rebuildTo 传入，用于释放 isRebuilding 锁）
                    store.__triggerAnimatedFlip = (onDone) => {
                        const target = store.__pendingAnimatedFlip;
                        if (target == null || !pf) { if (onDone) onDone(); return; }
                        store.__pendingAnimatedFlip = null;
                        // 动画期间标记：bindFlipEvents 里据此跳过 orientation 同步，避免动画 flip 事件触发连锁重建
                        store.__animatingFlip = true;
                        // 动画结束（回到 read 状态）时清除标记并回调 onDone
                        let done = false;
                        const clear = () => {
                            if (done) return;
                            done = true;
                            store.__animatingFlip = false;
                            if (onDone) { try { onDone(); } catch (e4) {} }
                        };
                        try {
                            pf.on('changeState', (event) => {
                                const state = event?.data || event?.state;
                                if (state === 'read') clear();
                            });
                            // 兜底：动画即使未触发 changeState，也在超时后强制结束，避免锁永久占用
                            setTimeout(clear, 1200);
                        } catch (e3) { clear(); }
                        try { if (pf.flip) pf.flip(target); } catch (e2) { clear(); }
                    };
                }
            } catch (e) { console.error('[center][createPageFlip] init 落位失败', e); }
        });
    } catch (e) { /* 个别版本无 init 事件，降级由 rebuildTo 兜底 */ }

    // 重建场景下，旧实例 destroy() 仅清空内部 pages 数组，但 #flipbook 内残留的 .page（含旧 canvas）
    // 仍留在 DOM 里。若不清理直接 loadFromHTML，page-flip 会重新绑定到这些「陈旧」节点：
    // 其 data-page-num / 数量可能与新 orientation 不匹配，导致重建后某些页永远空白、且无法自愈。
    // 因此无论 existing.length 为多少，每次建立实例前都【整体重建】干净的占位，确保状态确定、可重复。
    const liveFlipbook = document.getElementById('flipbook') || flipbookEl;
    // 关键修复：先彻底清空旧 .page（含其 canvas），避免陈旧节点被 loadFromHTML 复用而导致空白。
    Array.from(liveFlipbook.querySelectorAll('.page')).forEach(n => n.remove());

    const baseCount = store.totalPages
        || (store.pageFlip && store.pageFlip.getPageCount && store.pageFlip.getPageCount())
        || 0;
    if (baseCount > 0) {
        // single 模式：偶页书尾页会被并入最后一幅 spread，无法单页显示。
        // 补 1 个透明空白尾页使总页数变奇数，真尾页即落单单页。
        const extraBlank = (wantSingle && baseCount % 2 === 0) ? 1 : 0;
        const pdfPlaceholders = buildPagePlaceholders(liveFlipbook, baseCount, !!store.renderTextLayer, extraBlank);
        // 显示插入页时，在 PDF 占位之间插入 iframe 占位并重排 DOM。
        // 插入页不参与 PDF 内容填回（无 data-page-num），仅作为翻页器中的一页。
        if (store.insertVisible && store.insertedPages && store.insertedPages.length > 0) {
            applyInsertionsToDom(liveFlipbook, pdfPlaceholders, store.insertedPages);
        }
    }

    // 记录当前翻页器实际 .page 总数（PDF + 插入 + 补位），供边界判断/滑块 max 使用。
    store.renderedPageCount = liveFlipbook.querySelectorAll('.page').length;

    store.pageFlip.loadFromHTML(liveFlipbook.querySelectorAll('.page'));
    // PageFlip 在 showCover=true 时会强制把第一页设为 hard density，翻动时是整张硬板
    // rotateY；后续页面则是 soft density 的卷页效果。PC 需要首屏与后续页视觉一致，
    // 因此仅在 PC 双页实例中把封面恢复为普通纸张。showCover 的单独 spread 布局不受影响。
    if (mode !== 'fixed' && !wantSingle && store.pageFlip.getPage) {
        try {
            const coverPage = store.pageFlip.getPage(0);
            if (coverPage?.setDensity) coverPage.setDensity('soft');
            if (coverPage?.setDrawingDensity) coverPage.setDrawingDensity('soft');
        } catch (error) { /* 柔性封面降级失败时仍保留 PageFlip 默认效果 */ }
    }
    const settled = store.pageFlip.getPageCount ? store.pageFlip.getPageCount() : '?';
    const cfg = store.pageFlip.getSettings ? store.pageFlip.getSettings() : null;
    console.log('[center][createPageFlip] loadFromHTML 后 pageCount:', settled, 'usePortrait:', cfg ? cfg.usePortrait : '?', 'mode:', cfg ? cfg.mode : '?', 'size:', cfg ? cfg.size : '?');

    // page-flip 在 loadFromHTML 时可能重建/替换宿主节点；把缓存引用同步为文档中真实节点，
    // 避免后续 rebuildTo/refill 仍指向游离旧节点。
    const realFlipbook = document.getElementById('flipbook');
    if (realFlipbook && window.__app && window.__app.flipbookEl !== realFlipbook) {
        window.__app.flipbookEl = realFlipbook;
        console.log('[center][createPageFlip] 已同步 window.__app.flipbookEl 为文档真实节点');
    }
    console.log('[center][createPageFlip] 重建后 #flipbook 是否在文档:', !!(realFlipbook && realFlipbook.isConnected), 'orientation:', orientation);

    const pfSettings = store.pageFlip.getSettings();
    store.basePageWidth = pfSettings.width;
    store.basePageHeight = pfSettings.height;
    store.currentOrientation = wantSingle ? 'single' : 'double';

    // 重建后 DOM 被重构，重新为 textLayer 绑定防翻页事件
    setTimeout(() => {
        document.querySelectorAll('.textLayer').forEach(layer => {
            // On mobile the gesture must be able to start over PDF text as well as the canvas.
            // PC keeps the propagation guard so text selection never turns a page accidentally.
            if (!isMobileInteraction) {
                layer.addEventListener('mousedown', stopPropFinal);
                layer.addEventListener('touchstart', stopPropFinal);
                layer.addEventListener('pointerdown', stopPropFinal);
            }
        });
    }, 100);

    return pf;
}
