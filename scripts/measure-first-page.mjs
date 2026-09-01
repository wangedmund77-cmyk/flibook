import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const targetUrl = process.argv[2] || 'http://127.0.0.1:5174/';
const timeoutMs = Number(process.env.PERF_TIMEOUT_MS || 30000);
const previewOut = process.env.PREVIEW_OUT;
const testSecondPage = process.env.TEST_SECOND_PAGE === '1';
const testSecondPageEarly = process.env.TEST_SECOND_PAGE_EARLY === '1';
const testDoubleClickZoom = process.env.TEST_DOUBLE_CLICK_ZOOM === '1';
const testZoomRerender = process.env.TEST_ZOOM_RERENDER === '1';
const testInsertDoubleClickZoom = process.env.TEST_INSERT_DOUBLE_CLICK_ZOOM === '1';
const testMousePan = process.env.TEST_MOUSE_PAN === '1';
const testMobileNavigation = process.env.TEST_MOBILE_NAVIGATION === '1';
const testMobileTextSelection = process.env.TEST_MOBILE_TEXT_SELECTION === '1';
const testMobileFirstLoad = process.env.TEST_MOBILE_FIRST_LOAD === '1';
const testMobileFirstLoadEarly = process.env.TEST_MOBILE_FIRST_LOAD_EARLY === '1';
const testMobileFirstTurnStability = process.env.TEST_MOBILE_FIRST_TURN_STABILITY === '1';
const testMobileDrawerLayout = process.env.TEST_MOBILE_DRAWER_LAYOUT === '1';
const testMobilePageSlider = process.env.TEST_MOBILE_PAGE_SLIDER === '1';
const testMobilePinchRerender = process.env.TEST_MOBILE_PINCH_RERENDER === '1';
const testPcPageArrows = process.env.TEST_PC_PAGE_ARROWS === '1';
const testPcPageArrowsEarly = process.env.TEST_PC_PAGE_ARROWS_EARLY === '1';
const testPcPageClick = process.env.TEST_PC_PAGE_CLICK === '1';
const testPcZoomRightEdge = process.env.TEST_PC_ZOOM_RIGHT_EDGE === '1';
const testMobileCornerTap = process.env.TEST_MOBILE_CORNER_TAP === '1';
const testHiDpiCanvas = process.env.TEST_HIDPI_CANVAS === '1';
const testNormalClarity = process.env.TEST_NORMAL_CLARITY === '1';
const testDeviceScaleFactor = Number(process.env.TEST_DEVICE_SCALE_FACTOR || 2);
const networkLatencyMs = Number(process.env.PERF_NETWORK_LATENCY_MS || 0);
const networkDownloadBps = Number(process.env.PERF_NETWORK_DOWNLOAD_BPS || 0);
const pcViewportWidth = Number(process.env.PC_VIEWPORT_WIDTH || 0);
const pcViewportHeight = Number(process.env.PC_VIEWPORT_HEIGHT || 0);
const pcZoomFitScreenshotOut = process.env.PC_ZOOM_FIT_SCREENSHOT_OUT;
const pcZoomLeftScreenshotOut = process.env.PC_ZOOM_LEFT_SCREENSHOT_OUT;
const pcZoomRightScreenshotOut = process.env.PC_ZOOM_RIGHT_SCREENSHOT_OUT;
const secondScreenshotOut = process.env.SECOND_SCREENSHOT_OUT;
const chromeCandidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const chromePath = chromeCandidates.find(existsSync);

if (!chromePath) {
    throw new Error('未找到 Chrome；可通过 CHROME_PATH 指定 chrome.exe');
}

class CdpClient {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Set();
    }

    async open() {
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.ws.addEventListener('message', (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result || {});
                return;
            }
            for (const listener of this.listeners) listener(msg);
        });
    }

    send(method, params = {}, sessionId) {
        const id = this.nextId++;
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(msg));
        });
    }
}

function waitForBrowserWs(child) {
    return new Promise((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`Chrome 启动超时：${stderr.slice(-1000)}`)), 10000);
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
            const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Chrome 提前退出，code=${code}：${stderr.slice(-1000)}`));
        });
    });
}

function headerValue(headers, name) {
    const key = Object.keys(headers || {}).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : '';
}

const profileDir = await mkdtemp(join(tmpdir(), 'flipbook-first-page-'));
let chrome;
let cdp;

try {
    chrome = spawn(chromePath, [
        '--headless=new',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-extensions',
        '--no-first-run',
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        `--user-data-dir=${profileDir}`,
        'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    const browserWs = await waitForBrowserWs(chrome);
    cdp = new CdpClient(browserWs);
    await cdp.open();

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await Promise.all([
        cdp.send('Runtime.enable', {}, sessionId),
        cdp.send('Network.enable', {}, sessionId),
        cdp.send('Page.enable', {}, sessionId),
        cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId),
    ]);
    if (networkLatencyMs > 0 || networkDownloadBps > 0) {
        await cdp.send('Network.emulateNetworkConditions', {
            offline: false,
            latency: Math.max(0, networkLatencyMs),
            downloadThroughput: networkDownloadBps > 0 ? networkDownloadBps : -1,
            uploadThroughput: -1,
        }, sessionId);
    }
    if (testNormalClarity) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
        }, sessionId);
    } else if (testHiDpiCanvas || testZoomRerender) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 1440,
            height: 900,
            deviceScaleFactor: testDeviceScaleFactor,
            mobile: false,
        }, sessionId);
    } else if (testMobileNavigation || testMobileCornerTap || testMobileTextSelection || testMobileFirstLoad || testMobileFirstLoadEarly || testMobileFirstTurnStability || testMobileDrawerLayout || testMobilePageSlider || testMobilePinchRerender) {
        await Promise.all([
            cdp.send('Emulation.setDeviceMetricsOverride', {
                width: 390,
                height: 844,
                deviceScaleFactor: testMobilePinchRerender ? testDeviceScaleFactor : 1,
                mobile: true,
            }, sessionId),
            cdp.send('Emulation.setTouchEmulationEnabled', {
                enabled: true,
                maxTouchPoints: 5,
            }, sessionId),
        ]);
    } else if (testPcPageArrows || testPcPageArrowsEarly || testPcPageClick || testPcZoomRightEdge) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: pcViewportWidth > 0 ? pcViewportWidth : 1440,
            height: pcViewportHeight > 0 ? pcViewportHeight : 900,
            deviceScaleFactor: testDeviceScaleFactor,
            mobile: false,
        }, sessionId);
    }

    const startedAt = performance.now();
    const requests = new Map();
    const consoleLines = [];
    let firstCanvasAt = null;
    let resolveFirstCanvas;
    const firstCanvasPromise = new Promise((resolve) => { resolveFirstCanvas = resolve; });

    cdp.listeners.add((msg) => {
        if (msg.sessionId !== sessionId) return;
        const observedAt = performance.now() - startedAt;

        if (msg.method === 'Network.requestWillBeSent') {
            requests.set(msg.params.requestId, {
                url: msg.params.request.url,
                method: msg.params.request.method,
                type: msg.params.type,
                range: headerValue(msg.params.request.headers, 'Range'),
                startedAt: observedAt,
            });
        } else if (msg.method === 'Network.responseReceived') {
            const row = requests.get(msg.params.requestId);
            if (!row) return;
            const response = msg.params.response;
            row.status = response.status;
            row.mimeType = response.mimeType;
            row.protocol = response.protocol;
            row.responseAt = observedAt;
            row.ttfb = response.timing?.receiveHeadersEnd;
            row.serverTime = headerValue(response.headers, 'X-Nginx-Request-Time');
        } else if (msg.method === 'Network.loadingFinished') {
            const row = requests.get(msg.params.requestId);
            if (!row) return;
            row.finishedAt = observedAt;
            row.encodedBytes = msg.params.encodedDataLength;
        } else if (msg.method === 'Network.loadingFailed') {
            const row = requests.get(msg.params.requestId);
            if (!row) return;
            row.finishedAt = observedAt;
            row.failed = msg.params.errorText;
            row.canceled = msg.params.canceled;
        } else if (msg.method === 'Runtime.consoleAPICalled') {
            const line = msg.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
            consoleLines.push({ observedAt, line });
            if (line.includes('[perf] First page canvas ready:') && firstCanvasAt == null) {
                firstCanvasAt = observedAt;
                resolveFirstCanvas();
            }
        }
    });

    let mobileFirstLoadPreview = null;
    await cdp.send('Page.navigate', { url: targetUrl }, sessionId);
    if (testMobileFirstLoadEarly) {
        const { result } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const preview = document.getElementById('firstPagePreview');
                return preview ? { x: 0, y: 0, width: innerWidth, height: innerHeight } : null;
            })()`,
            returnByValue: true,
        }, sessionId);
        const rect = result?.value;
        if (!rect) throw new Error('移动端首屏预览层未及时出现，无法执行极早左滑测试');
        mobileFirstLoadPreview = { ...rect, viewportWidth: 390, mobile: true, earlySwipeReady: true };
        const y = Math.round(rect.y + rect.height * 0.5);
        const start = { x: Math.round(rect.x + rect.width * 0.78), y, id: 1, radiusX: 1, radiusY: 1, force: 1 };
        const end = { ...start, x: Math.round(rect.x + rect.width * 0.22) };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] }, sessionId);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] }, sessionId);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
        console.log(`移动端预览图就绪前已执行极早左滑：${Math.round(performance.now() - startedAt)}ms`);
    }
    let initialFlipHintState = null;
    if (testMobileFirstLoad) {
        const hintDeadline = performance.now() + 3000;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const bar = document.getElementById('flipHintBar');
                    const gif = bar?.querySelector('.flip-hint-gif');
                    if (!bar || !gif) return null;
                    const style = getComputedStyle(bar);
                    const rect = bar.getBoundingClientRect();
                    return {
                        shown: !bar.classList.contains('hidden') && style.visibility === 'visible' && Number(style.opacity) > 0.9,
                        ariaHidden: bar.getAttribute('aria-hidden'),
                        pointerEvents: style.pointerEvents,
                        width: rect.width,
                        height: rect.height,
                        gifSrc: gif.currentSrc || gif.src || '',
                        gifReady: gif.complete && gif.naturalWidth === 196 && gif.naturalHeight === 132,
                        seenStored: localStorage.getItem('flipSwipeGifSeenV1') === '1',
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            initialFlipHintState = result?.value;
            if (!initialFlipHintState?.shown || !initialFlipHintState.gifReady) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        } while ((!initialFlipHintState?.shown || !initialFlipHintState.gifReady) && performance.now() < hintDeadline);
        if (!initialFlipHintState?.shown
            || initialFlipHintState.ariaHidden !== 'false'
            || initialFlipHintState.pointerEvents !== 'none'
            || initialFlipHintState.width < 180
            || !initialFlipHintState.gifSrc.includes('flip-swipe-hint.gif')
            || !initialFlipHintState.gifReady
            || !initialFlipHintState.seenStored) {
            throw new Error(`移动端首次进入翻页 GIF 未正确显示或记忆：${JSON.stringify(initialFlipHintState)}`);
        }
        console.log(`移动端首次进入翻页 GIF 已显示：${Math.round(performance.now() - startedAt)}ms`);

        // 在 PDF 之外的顶部空白区域触摸，验证整个页面任意位置都能关闭提示。
        const outsidePdfPoint = { x: 375, y: 28, id: 1, radiusX: 1, radiusY: 1, force: 1 };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [outsidePdfPoint] }, sessionId);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const { result: outsideDismissResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const bar = document.getElementById('flipHintBar');
                return {
                    hidden: bar?.classList.contains('hidden') || false,
                    ariaHidden: bar?.getAttribute('aria-hidden') || '',
                };
            })()`,
            returnByValue: true,
        }, sessionId);
        if (!outsideDismissResult?.value?.hidden || outsideDismissResult.value.ariaHidden !== 'true') {
            throw new Error(`移动端点击 PDF 外区域后 GIF 提示未收起：${JSON.stringify(outsideDismissResult?.value)}`);
        }
        console.log(`移动端点击页面任意区域可关闭 GIF：${JSON.stringify(outsideDismissResult.value)}`);
    }
    let earlyPcArrowInitial = null;
    if (testPcPageArrowsEarly) {
        const arrowDeadline = performance.now() + 5000;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const next = document.getElementById('pcNextPageBtn');
                    const rect = next?.getBoundingClientRect();
                    if (!next || !rect || next.disabled || rect.width < 20) return null;
                    const active = [...document.querySelectorAll('#flipbook .page')]
                        .map((page, index) => ({ index, display: getComputedStyle(page).display }))
                        .filter((page) => page.display !== 'none');
                    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, active };
                })()`,
                returnByValue: true,
            }, sessionId);
            earlyPcArrowInitial = result?.value;
            if (!earlyPcArrowInitial) await new Promise((resolve) => setTimeout(resolve, 20));
        } while (!earlyPcArrowInitial && performance.now() < arrowDeadline);
        if (!earlyPcArrowInitial) throw new Error('PC 首屏右箭头未在 PDF Canvas 前就绪');
        await new Promise((resolve) => setTimeout(resolve, 30));
        const x = earlyPcArrowInitial.x + earlyPcArrowInitial.width / 2;
        const y = earlyPcArrowInitial.y + earlyPcArrowInitial.height / 2;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
        console.log(`PC Canvas 完成前点击右箭头：${Math.round(performance.now() - startedAt)}ms`);
    }
    if (testMobileFirstLoad) {
        const previewDeadline = performance.now() + 3000;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const preview = document.getElementById('firstPagePreview');
                    const image = document.getElementById('firstPagePreviewImage');
                    if (!preview || !image) return null;
                    if (!window.__mobileFirstGestureProbeBound) {
                        window.__mobileFirstGestureProbeBound = true;
                        window.__mobileFirstGestureProbe = [];
                        for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
                            preview.addEventListener(type, (event) => {
                                window.__mobileFirstGestureProbe.push({
                                    type,
                                    touches: event.touches?.length || 0,
                                    changed: event.changedTouches?.length || 0,
                                    x: event.changedTouches?.[0]?.clientX ?? event.touches?.[0]?.clientX ?? null,
                                    y: event.changedTouches?.[0]?.clientY ?? event.touches?.[0]?.clientY ?? null,
                                    target: event.target?.id || event.target?.tagName || '',
                                });
                            }, true);
                        }
                    }
                    const rect = image.getBoundingClientRect();
                    return rect.width > 20 && rect.height > 20 ? {
                        x: rect.left, y: rect.top, width: rect.width, height: rect.height,
                        viewportWidth: innerWidth,
                        mobile: matchMedia('(max-width: 768px) and (pointer: coarse)').matches,
                        earlySwipeReady: !!window.__flipbookEarlySwipeReady,
                        previewDisplay: getComputedStyle(preview).display,
                    } : null;
                })()`,
                returnByValue: true,
            }, sessionId);
            mobileFirstLoadPreview = result?.value?.mobile && result.value.earlySwipeReady ? result.value : null;
            if (!mobileFirstLoadPreview) await new Promise((resolve) => setTimeout(resolve, 20));
        } while (!mobileFirstLoadPreview && performance.now() < previewDeadline);
        if (!mobileFirstLoadPreview) throw new Error('移动端首屏静态预览未及时出现');

        const rect = mobileFirstLoadPreview;
        const y = Math.round(rect.y + rect.height * 0.5);
        const start = { x: Math.round(rect.x + rect.width * 0.78), y, id: 1, radiusX: 1, radiusY: 1, force: 1 };
        const mid = { ...start, x: Math.round(rect.x + rect.width * 0.52) };
        const end = { ...start, x: Math.round(rect.x + rect.width * 0.22) };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] }, sessionId);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [mid] }, sessionId);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] }, sessionId);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const { result: dismissedHintResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const bar = document.getElementById('flipHintBar');
                return {
                    hidden: bar?.classList.contains('hidden') || false,
                    ariaHidden: bar?.getAttribute('aria-hidden') || '',
                    seenStored: localStorage.getItem('flipSwipeGifSeenV1') === '1',
                };
            })()`,
            returnByValue: true,
        }, sessionId);
        if (!dismissedHintResult?.value?.hidden
            || dismissedHintResult.value.ariaHidden !== 'true'
            || !dismissedHintResult.value.seenStored) {
            throw new Error(`移动端开始翻页后 GIF 提示未收起：${JSON.stringify(dismissedHintResult?.value)}`);
        }
        console.log(`移动端首屏完成首次左滑：${Math.round(performance.now() - startedAt)}ms，预览尺寸：${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
    if (testSecondPageEarly) {
        const earlyDeadline = performance.now() + 3000;
        let previewRect;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const el = document.getElementById('firstPagePreviewImage');
                    if (!el) return null;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 20 && rect.height > 20
                        ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
                        : null;
                })()`,
                returnByValue: true,
            }, sessionId);
            previewRect = result?.value;
            if (!previewRect) await new Promise((resolve) => setTimeout(resolve, 25));
        } while (!previewRect && performance.now() < earlyDeadline);
        if (!previewRect) throw new Error('首屏预览图未及时出现，无法执行早点击测试');
        const x = previewRect.x + previewRect.width * 0.82;
        const y = previewRect.y + previewRect.height * 0.5;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
        console.log(`预览阶段已执行早点击：+${Math.round(performance.now() - startedAt)}ms`);
    }
    let timeoutId;
    try {
        await Promise.race([
            firstCanvasPromise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`等待第一页超时（${timeoutMs} ms）`)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timeoutId);
    }

    if (testMobileFirstLoadEarly) {
        const turnDeadline = performance.now() + 5000;
        let firstLoadState;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => ({
                    active: [...document.querySelectorAll('#flipbook .page')]
                        .map((page, index) => ({
                            index,
                            pageNum: page.dataset.pageNum || '',
                            inserted: page.dataset.inserted || '',
                            display: getComputedStyle(page).display,
                        }))
                        .filter((page) => page.display !== 'none'),
                    queued: !!window.__flipbookPreviewNextRequested,
                    firstTurnStartedBeforeCanvas: window.__flipbookFirstTurnStartedBeforeCanvas === true,
                    firstTurnUsedPreviewPlaceholder: window.__flipbookFirstTurnUsedPreviewPlaceholder === true,
                }))()`,
                returnByValue: true,
            }, sessionId);
            firstLoadState = result?.value;
            if (firstLoadState?.active?.some((page) => page.inserted === '1')) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        } while (performance.now() < turnDeadline);
        if (!firstLoadState?.active?.some((page) => page.inserted === '1')
            || firstLoadState.queued
            || !firstLoadState.firstTurnStartedBeforeCanvas
            || !firstLoadState.firstTurnUsedPreviewPlaceholder) {
            throw new Error(`移动端预览图就绪前左滑未可靠重放：${JSON.stringify({ mobileFirstLoadPreview, firstLoadState })}`);
        }
        console.log(`移动端预览图就绪前左滑已在初始化后翻页：${JSON.stringify({ mobileFirstLoadPreview, firstLoadState })}`);
    }

    if (testHiDpiCanvas) {
        const { result } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const canvas = document.querySelector('.page[data-page-num="1"] canvas');
                if (!canvas) return null;
                return {
                    dpr: window.devicePixelRatio,
                    outputScale: Number(canvas.dataset.outputScale),
                    viewportWidth: Number(canvas.dataset.viewportWidth),
                    viewportHeight: Number(canvas.dataset.viewportHeight),
                    backingWidth: canvas.width,
                    backingHeight: canvas.height,
                    clientWidth: canvas.clientWidth,
                    clientHeight: canvas.clientHeight,
                };
            })()`,
            returnByValue: true,
        }, sessionId);
        const state = result?.value;
        const layoutScale = state ? Math.max(
            state.clientWidth / state.viewportWidth,
            state.clientHeight / state.viewportHeight,
        ) : 0;
        const expectedScale = Math.max(1, Math.min(testDeviceScaleFactor * layoutScale, 2));
        if (!state
            || Math.abs(state.outputScale - expectedScale) > 0.001
            || state.backingWidth !== Math.floor(state.viewportWidth * expectedScale)
            || state.backingHeight !== Math.floor(state.viewportHeight * expectedScale)
            || state.clientWidth <= 0
            || state.clientHeight <= 0) {
            throw new Error(`HiDPI Canvas 像素倍率不正确：${JSON.stringify({ expectedScale, state })}`);
        }
        console.log(`PASS: HiDPI Canvas 后备像素已按 ${expectedScale}x 渲染：${JSON.stringify(state)}`);
    }

    if (testNormalClarity) {
        const readNormalClarityState = async () => {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const fb = document.getElementById('flipbook');
                    const containerRect = document.querySelector('.book-container')?.getBoundingClientRect();
                    const pages = [...document.querySelectorAll('#flipbook .page[data-page-num]')]
                        .filter((page) => {
                            const style = getComputedStyle(page);
                            const rect = page.getBoundingClientRect();
                            return style.display !== 'none' && style.visibility !== 'hidden'
                                && Number(style.opacity) !== 0 && rect.width > 1 && rect.height > 1
                                && (!containerRect || (rect.right > containerRect.left
                                    && rect.left < containerRect.right
                                    && rect.bottom > containerRect.top
                                    && rect.top < containerRect.bottom));
                        })
                        .map((page) => {
                            const canvas = page.querySelector('canvas');
                            const rect = canvas?.getBoundingClientRect();
                            return {
                                pageNum: page.dataset.pageNum || '',
                                backingWidth: canvas?.width || 0,
                                backingHeight: canvas?.height || 0,
                                cssWidth: rect?.width || 0,
                                cssHeight: rect?.height || 0,
                                ratio: canvas && rect?.width > 1 && rect?.height > 1
                                    ? Math.min(canvas.width / rect.width, canvas.height / rect.height)
                                    : 0,
                                qualityRender: canvas?.dataset.qualityRender || '',
                            };
                        });
                    return {
                        dpr: window.devicePixelRatio || 1,
                        qualityReady: fb?.dataset.qualityRenderReady || '',
                        pages,
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            return result?.value;
        };
        const waitForSharpPages = async (expectedPage = '') => {
            const deadline = performance.now() + 12000;
            let state;
            do {
                state = await readNormalClarityState();
                const expectedVisible = !expectedPage
                    || state?.pages?.some((page) => page.pageNum === expectedPage);
                const allSharp = state?.pages?.length > 0
                    && state.pages.every((page) => page.ratio >= 1.95
                        && page.backingWidth * page.backingHeight <= 16_000_000);
                if (state?.qualityReady === '2' && expectedVisible && allSharp) return state;
                await new Promise((resolve) => setTimeout(resolve, 100));
            } while (performance.now() < deadline);
            return state;
        };

        const initialClarity = await waitForSharpPages('1');
        if (initialClarity?.dpr !== 1 || initialClarity?.qualityReady !== '2'
            || !initialClarity.pages?.some((page) => page.pageNum === '1')
            || initialClarity.pages.some((page) => page.ratio < 1.95)) {
            throw new Error(`PC 100% 首屏清晰度增强失败：${JSON.stringify(initialClarity)}`);
        }
        await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const slider = document.getElementById('pageSlider');
                if (!slider) return false;
                slider.value = '4';
                slider.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`,
        }, sessionId);
        const turnedClarity = await waitForSharpPages('4');
        if (turnedClarity?.qualityReady !== '2'
            || !turnedClarity.pages?.some((page) => page.pageNum === '4')
            || turnedClarity.pages.some((page) => page.ratio < 1.95)) {
            throw new Error(`PC 100% 翻页后清晰度增强失败：${JSON.stringify({ initialClarity, turnedClarity })}`);
        }
        console.log(`PASS: PC 100% 当前可见页达到 2px/CSS px，翻页后仍保持：${JSON.stringify({ initialClarity, turnedClarity })}`);
    }

    if (testMobilePinchRerender) {
        const readPinchState = async () => {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const fb = document.getElementById('flipbook');
                    const active = [...document.querySelectorAll('#flipbook .page')]
                        .map((page, index) => ({ page, index, display: getComputedStyle(page).display }))
                        .filter((item) => item.display !== 'none');
                    const pdfPage = active.find((item) => item.page.dataset.pageNum && item.page.querySelector('canvas'));
                    const canvas = pdfPage?.page.querySelector('canvas');
                    return {
                        visualScale: window.visualViewport?.scale || 1,
                        dpr: window.devicePixelRatio || 1,
                        active: active.map((item) => ({
                            index: item.index,
                            pageNum: item.page.dataset.pageNum || '',
                            inserted: item.page.dataset.inserted || '',
                        })),
                        visiblePageNum: pdfPage?.page.dataset.pageNum || '',
                        backingWidth: canvas?.width || 0,
                        backingHeight: canvas?.height || 0,
                        clientWidth: canvas?.clientWidth || 0,
                        clientHeight: canvas?.clientHeight || 0,
                        zoomRender: canvas?.dataset.zoomRender || '',
                        zoomRenderReady: fb?.dataset.zoomRenderReady || '',
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            return result?.value;
        };
        const beforePinch = await readPinchState();
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 }, sessionId);
        const pinchDeadline = performance.now() + 12000;
        let pinchZoomed;
        do {
            pinchZoomed = await readPinchState();
            if (pinchZoomed?.zoomRenderReady === '2' && pinchZoomed.backingWidth > beforePinch.backingWidth) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        } while (performance.now() < pinchDeadline);
        if (!pinchZoomed
            || Math.abs(pinchZoomed.visualScale - 2) > 0.05
            || pinchZoomed.zoomRenderReady !== '2'
            || pinchZoomed.backingWidth <= beforePinch.backingWidth
            || pinchZoomed.backingWidth * pinchZoomed.backingHeight > 16_000_000) {
            throw new Error(`手机双指缩放后高清重渲染失败：${JSON.stringify({ beforePinch, pinchZoomed })}`);
        }

        // 放大状态下跳到新的 PDF 页，原生 visualViewport 倍率必须保持，且新页需独立完成高清渲染。
        await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const slider = document.getElementById('pageSlider');
                if (!slider) return false;
                slider.value = '2';
                slider.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`,
        }, sessionId);
        const turnedDeadline = performance.now() + 12000;
        let pinchTurned;
        do {
            pinchTurned = await readPinchState();
            if (pinchTurned?.visiblePageNum === '2'
                && Math.abs(pinchTurned.visualScale - 2) <= 0.05
                && pinchTurned.zoomRenderReady === '2'
                && pinchTurned.zoomRender === '2') break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        } while (performance.now() < turnedDeadline);
        if (pinchTurned?.visiblePageNum !== '2'
            || Math.abs((pinchTurned?.visualScale || 1) - 2) > 0.05
            || pinchTurned.zoomRenderReady !== '2'
            || pinchTurned.zoomRender !== '2'
            || pinchTurned.backingWidth <= beforePinch.backingWidth
            || pinchTurned.backingWidth * pinchTurned.backingHeight > 16_000_000) {
            throw new Error(`手机放大翻页未保持倍率或新页不清晰：${JSON.stringify({ pinchZoomed, pinchTurned })}`);
        }
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const pinchRestored = await readPinchState();
        if (pinchRestored.backingWidth >= pinchTurned.backingWidth || pinchRestored.zoomRender) {
            throw new Error(`手机缩放复位后未释放高清 Canvas：${JSON.stringify({ pinchTurned, pinchRestored })}`);
        }
        console.log(`PASS: 手机双指放大翻页保持倍率并完成高清重渲染：${JSON.stringify({ beforePinch, pinchZoomed, pinchTurned, pinchRestored })}`);
    }

    if (testMobileFirstTurnStability) {
        const readyDeadline = performance.now() + 8000;
        let turnTarget;
        let turnReadiness;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const preview = document.getElementById('firstPagePreview');
                    const page = [...document.querySelectorAll('#flipbook .page')].find((node) => {
                        const rect = node.getBoundingClientRect();
                        return getComputedStyle(node).display !== 'none' && rect.width > 300 && rect.height > 400;
                    });
                    const insert = document.querySelector('#flipbook .page-insert');
                    const iframe = insert?.querySelector('iframe');
                    const rect = page?.getBoundingClientRect();
                    const readiness = {
                        target: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
                        preview: !!preview,
                        insertCount: document.querySelectorAll('#flipbook .page-insert').length,
                        iframeSrc: iframe?.getAttribute('src') || '',
                        fitScale: iframe?.dataset.fitScale || '',
                        opacity: iframe ? getComputedStyle(iframe).opacity : '',
                    };
                    return { readiness, ready: !!(rect && iframe?.dataset.fitScale && Number(getComputedStyle(iframe).opacity) > 0.99 && !preview) };
                })()`,
                returnByValue: true,
            }, sessionId);
            turnReadiness = result?.value?.readiness;
            turnTarget = result?.value?.ready ? turnReadiness.target : null;
            if (!turnTarget) await new Promise((resolve) => setTimeout(resolve, 25));
        } while (!turnTarget && performance.now() < readyDeadline);
        if (!turnTarget) throw new Error(`移动端首页或第二屏插入页未在测试时限内稳定：${JSON.stringify(turnReadiness)}`);

        await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                window.__mobileFirstTurnFrames = [];
                const started = performance.now();
                const sample = () => {
                    const insert = document.querySelector('#flipbook .page-insert');
                    const iframe = insert?.querySelector('iframe');
                    const pageRect = insert?.getBoundingClientRect();
                    const iframeRect = iframe?.getBoundingClientRect();
                    window.__mobileFirstTurnFrames.push({
                        t: Math.round(performance.now() - started),
                        state: document.getElementById('flipbook')?.dataset.flipState || '',
                        display: insert ? getComputedStyle(insert).display : '',
                        pageClientW: insert?.clientWidth || 0,
                        pageClientH: insert?.clientHeight || 0,
                        pageX: pageRect ? Number(pageRect.x.toFixed(3)) : 0,
                        pageY: pageRect ? Number(pageRect.y.toFixed(3)) : 0,
                        pageW: pageRect ? Number(pageRect.width.toFixed(3)) : 0,
                        pageH: pageRect ? Number(pageRect.height.toFixed(3)) : 0,
                        iframeX: iframeRect ? Number(iframeRect.x.toFixed(3)) : 0,
                        iframeY: iframeRect ? Number(iframeRect.y.toFixed(3)) : 0,
                        iframeW: iframeRect ? Number(iframeRect.width.toFixed(3)) : 0,
                        iframeH: iframeRect ? Number(iframeRect.height.toFixed(3)) : 0,
                        scale: iframe?.dataset.fitScale || '',
                        transform: iframe?.style.transform || '',
                        opacity: iframe ? getComputedStyle(iframe).opacity : '',
                    });
                    if (performance.now() - started < 1500) requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            })()`,
        }, sessionId);

        const y = Math.round(turnTarget.y + turnTarget.height * 0.5);
        const start = { x: Math.round(turnTarget.x + turnTarget.width * 0.78), y, id: 1, radiusX: 1, radiusY: 1, force: 1 };
        const end = { ...start, x: Math.round(turnTarget.x + turnTarget.width * 0.22) };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] }, sessionId);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] }, sessionId);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 1650));

        const { result } = await cdp.send('Runtime.evaluate', {
            expression: `window.__mobileFirstTurnFrames || []`,
            returnByValue: true,
        }, sessionId);
        const frames = result?.value || [];
        const visibleFrames = frames.filter((frame) => frame.display !== 'none' && frame.pageW > 20);
        const prefittedWhileHidden = frames.some((frame) => frame.display === 'none' && Number(frame.scale) > 0);
        const settled = visibleFrames.at(-1);
        const maxYDrift = settled
            ? Math.max(...visibleFrames.map((frame) => Math.abs(frame.pageY - settled.pageY)))
            : Infinity;
        const maxScaleDrift = settled
            ? Math.max(...visibleFrames.map((frame) => Math.abs(Number(frame.scale) - Number(settled.scale))))
            : Infinity;
        const stateCoverage = [...new Set(visibleFrames.map((frame) => frame.state).filter(Boolean))];
        const stability = {
            frameCount: frames.length,
            visibleFrameCount: visibleFrames.length,
            prefittedWhileHidden,
            pageY: settled?.pageY,
            pageSize: settled ? `${settled.pageW}x${settled.pageH}` : '',
            iframeSize: settled ? `${settled.iframeW}x${settled.iframeH}` : '',
            scale: settled?.scale,
            maxYDrift,
            maxScaleDrift,
            stateCoverage,
        };
        if (!prefittedWhileHidden
            || visibleFrames.length < 5
            || !stateCoverage.includes('flipping')
            || !stateCoverage.includes('read')
            || maxYDrift > 0.5
            || maxScaleDrift > 0.000001) {
            throw new Error(`移动端首页到第二屏仍有二次落位：${JSON.stringify(stability)}`);
        }
        console.log(`\nPASS: 移动端首页到第二屏逐帧位置稳定：${JSON.stringify(stability)}`);
    }

    if (testPcPageArrowsEarly) {
        const earlyTurnDeadline = performance.now() + 5000;
        let earlyPcArrowAfter;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => ({
                    active: [...document.querySelectorAll('#flipbook .page')]
                        .map((page, index) => ({
                            index,
                            pageNum: page.dataset.pageNum || '',
                            inserted: page.dataset.inserted || '',
                            display: getComputedStyle(page).display,
                        }))
                        .filter((page) => page.display !== 'none'),
                    queued: !!window.__flipbookPreviewNextRequested,
                    previewExists: !!document.getElementById('firstPagePreview'),
                    previewVisible: (() => {
                        const preview = document.getElementById('firstPagePreview');
                        if (!preview) return false;
                        const style = getComputedStyle(preview);
                        return style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
                    })(),
                }))()`,
                returnByValue: true,
            }, sessionId);
            earlyPcArrowAfter = result?.value;
            if (earlyPcArrowAfter?.active?.some((page) => page.inserted === '1') && !earlyPcArrowAfter.previewVisible) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        } while (performance.now() < earlyTurnDeadline);
        if (!earlyPcArrowAfter?.active?.some((page) => page.inserted === '1') || earlyPcArrowAfter.previewVisible) {
            throw new Error(`PC 强制刷新后首次右箭头未翻页：${JSON.stringify({ earlyPcArrowInitial, earlyPcArrowAfter })}`);
        }
        console.log(`PC 强制刷新后首次右箭头已翻页：${JSON.stringify({ earlyPcArrowInitial, earlyPcArrowAfter })}`);
    }

    if (testMobileFirstLoad) {
        const turnDeadline = performance.now() + (testMobileFirstLoadEarly ? 15000 : 5000);
        let firstLoadState;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const active = [...document.querySelectorAll('#flipbook .page')]
                        .map((page, index) => ({
                            index,
                            display: getComputedStyle(page).display,
                            rect: (() => { const r = page.getBoundingClientRect(); return { width: r.width, height: r.height }; })(),
                        }))
                        .filter((page) => page.display !== 'none' && page.rect.width > 20);
                    return {
                        active,
                        queued: !!window.__flipbookPreviewNextRequested,
                        lastPreviewCorner: window.__flipbookLastPreviewCorner || '',
                        firstTurnStartedBeforeCanvas: window.__flipbookFirstTurnStartedBeforeCanvas === true,
                        firstTurnUsedPreviewPlaceholder: window.__flipbookFirstTurnUsedPreviewPlaceholder === true,
                        previewExists: !!document.getElementById('firstPagePreview'),
                        gestureProbe: window.__mobileFirstGestureProbe || [],
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            firstLoadState = result?.value;
            if (firstLoadState?.active?.some((page) => page.index > 0)) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        } while (performance.now() < turnDeadline);
        if (!firstLoadState?.active?.some((page) => page.index > 0)
            || firstLoadState.lastPreviewCorner !== 'bottom'
            || (networkLatencyMs > 0 && !firstLoadState.firstTurnStartedBeforeCanvas)
            || (networkLatencyMs > 0 && !firstLoadState.firstTurnUsedPreviewPlaceholder)
            || firstLoadState.previewExists) {
            throw new Error(`移动端首屏首次左滑未翻页：${JSON.stringify({ mobileFirstLoadPreview, firstLoadState })}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const { result: settledResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => [...document.querySelectorAll('#flipbook .page')]
                .map((page, index) => {
                    const rect = page.getBoundingClientRect();
                    return { index, display: getComputedStyle(page).display, width: rect.width, height: rect.height };
                })
                .filter((page) => page.display !== 'none' && page.width > 20))()`,
            returnByValue: true,
        }, sessionId);
        const settledPages = settledResult?.value || [];
        const settledNext = settledPages.find((page) => page.index > 0);
        if (!settledNext || Math.abs(settledNext.width - mobileFirstLoadPreview.width) > 2) {
            throw new Error(`移动端首屏翻页后的页面尺寸不一致：${JSON.stringify({ mobileFirstLoadPreview, settledPages })}`);
        }
        console.log(`移动端首屏无需预点击即可翻页：${JSON.stringify({ mobileFirstLoadPreview, firstLoadState, settledPages })}`);

        const repeatUrl = new URL(targetUrl);
        repeatUrl.searchParams.set('hint-repeat-check', String(Date.now()));
        await cdp.send('Page.navigate', { url: repeatUrl.href }, sessionId);
        let repeatHintState = null;
        const repeatHintDeadline = performance.now() + 3000;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const bar = document.getElementById('flipHintBar');
                    const gif = bar?.querySelector('.flip-hint-gif');
                    if (!bar || !gif) return null;
                    return {
                        hidden: bar.classList.contains('hidden'),
                        ariaHidden: bar.getAttribute('aria-hidden'),
                        gifSrcAttribute: gif.getAttribute('src') || '',
                        seenStored: localStorage.getItem('flipSwipeGifSeenV1') === '1',
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            repeatHintState = result?.value;
            if (!repeatHintState) await new Promise((resolve) => setTimeout(resolve, 20));
        } while (!repeatHintState && performance.now() < repeatHintDeadline);
        if (!repeatHintState?.hidden
            || repeatHintState.ariaHidden !== 'true'
            || repeatHintState.gifSrcAttribute
            || !repeatHintState.seenStored) {
            throw new Error(`移动端再次进入时 GIF 提示不应重复播放：${JSON.stringify(repeatHintState)}`);
        }
        console.log(`移动端再次进入未重复加载 GIF：${JSON.stringify(repeatHintState)}`);
    }

    if (testMobileDrawerLayout) {
        const hooksDeadline = performance.now() + 15000;
        let hooksReady = false;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `typeof window.__mobileOpenDrawer === 'function' && typeof window.__mobileShowSearchView === 'function' && typeof window.__mobileMountThumbs === 'function'`,
                returnByValue: true,
            }, sessionId);
            hooksReady = !!result?.value;
            if (!hooksReady) await new Promise((resolve) => setTimeout(resolve, 100));
        } while (!hooksReady && performance.now() < hooksDeadline);
        if (!hooksReady) throw new Error('移动端目录/搜索抽屉初始化超时');

        const readDrawerLayout = async () => {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const rectOf = (node) => {
                        const rect = node?.getBoundingClientRect();
                        return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom } : null;
                    };
                    const drawer = document.getElementById('mobileDrawer');
                    const header = drawer?.querySelector('.mobile-drawer-header');
                    return {
                        viewport: { width: innerWidth, height: innerHeight },
                        platform: document.body.dataset.platform || '',
                        drawerOpen: drawer?.classList.contains('open') || false,
                        drawer: rectOf(drawer),
                        header: rectOf(header),
                        title: rectOf(document.getElementById('drawerTitle')),
                        body: rectOf(document.getElementById('drawerBody')),
                        tocList: rectOf(document.getElementById('tocList')),
                        thumbnailList: rectOf(document.getElementById('thumbnailList')),
                        thumbnailParent: document.getElementById('thumbnailList')?.parentElement?.id || '',
                        thumbnailCount: document.querySelectorAll('#thumbnailList .thumbnail-item').length,
                        firstThumbnails: Array.from(document.querySelectorAll('#thumbnailList .thumbnail-item')).slice(0, 2).map(rectOf),
                        searchResults: rectOf(document.getElementById('mobileSearchResults')),
                        tocButton: rectOf(document.getElementById('mobileTocBtn')),
                        thumbButton: rectOf(document.getElementById('mobileThumbBtn')),
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            return result?.value;
        };
        const assertDrawerShell = (state, label) => {
            const { viewport, drawer, title, body } = state || {};
            if (!state?.drawerOpen || !drawer || !title || !body
                || drawer.width < viewport.width * 0.85
                || drawer.y < 68
                || viewport.width - drawer.right < 10
                || viewport.height - drawer.bottom < 10
                || title.x - drawer.x < 16) {
                throw new Error(`${label}安全距离或横向宽度不合格：${JSON.stringify(state)}`);
            }
        };

        await cdp.send('Runtime.evaluate', {
            expression: `document.getElementById('mobileSearchBtn')?.click()`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const { result: searchFocusResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const bar = document.getElementById('mobileSearchBar');
                return {
                    shown: bar?.classList.contains('show') || false,
                    display: bar ? getComputedStyle(bar).display : '',
                    activeId: document.activeElement?.id || '',
                };
            })()`,
            returnByValue: true,
        }, sessionId);
        if (!searchFocusResult?.value?.shown
            || searchFocusResult.value.display !== 'flex'
            || searchFocusResult.value.activeId !== 'mobileSearchInput') {
            throw new Error(`移动端搜索框未能打开并获得焦点：${JSON.stringify(searchFocusResult?.value)}`);
        }
        await cdp.send('Runtime.evaluate', {
            expression: `document.getElementById('mobileSearchInput')?.blur()`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const { result: searchBlurResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const bar = document.getElementById('mobileSearchBar');
                return {
                    shown: bar?.classList.contains('show') || false,
                    display: bar ? getComputedStyle(bar).display : '',
                    activeId: document.activeElement?.id || '',
                };
            })()`,
            returnByValue: true,
        }, sessionId);
        if (searchBlurResult?.value?.shown || searchBlurResult?.value?.display !== 'none') {
            throw new Error(`移动端搜索框失去焦点后仍然显示：${JSON.stringify(searchBlurResult?.value)}`);
        }

        await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                document.getElementById('mobileSearchBtn')?.click();
                const input = document.getElementById('mobileSearchInput');
                if (input) input.value = '';
            })()`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 120));
        const { result: searchSubmitGeometryResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const bar = document.getElementById('mobileSearchBar')?.getBoundingClientRect();
                const input = document.getElementById('mobileSearchInput')?.getBoundingClientRect();
                const button = document.getElementById('mobileSearchSubmit')?.getBoundingClientRect();
                return bar && input && button ? {
                    bar: { x: bar.x, right: bar.right, width: bar.width },
                    input: { x: input.x, right: input.right, width: input.width },
                    button: { x: button.x, y: button.y, right: button.right, width: button.width, height: button.height },
                } : null;
            })()`,
            returnByValue: true,
        }, sessionId);
        const searchSubmitGeometry = searchSubmitGeometryResult?.value;
        if (!searchSubmitGeometry
            || searchSubmitGeometry.button.width < 44
            || searchSubmitGeometry.button.height < 32
            || searchSubmitGeometry.button.x < searchSubmitGeometry.input.right
            || searchSubmitGeometry.bar.right - searchSubmitGeometry.button.right > 14) {
            throw new Error(`移动端搜索按钮尺寸或最右侧位置不合格：${JSON.stringify(searchSubmitGeometry)}`);
        }
        const submitPoint = {
            x: searchSubmitGeometry.button.x + searchSubmitGeometry.button.width / 2,
            y: searchSubmitGeometry.button.y + searchSubmitGeometry.button.height / 2,
        };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [submitPoint] }, sessionId);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const { result: searchSubmitResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => ({
                barShown: document.getElementById('mobileSearchBar')?.classList.contains('show') || false,
                drawerOpen: document.getElementById('mobileDrawer')?.classList.contains('open') || false,
                drawerTitle: document.getElementById('drawerTitle')?.textContent || '',
                resultText: document.getElementById('mobileSearchResults')?.textContent.trim() || '',
            }))()`,
            returnByValue: true,
        }, sessionId);
        if (searchSubmitResult?.value?.barShown
            || !searchSubmitResult?.value?.drawerOpen
            || searchSubmitResult.value.drawerTitle !== '搜索结果'
            || !searchSubmitResult.value.resultText.includes('请输入关键字')) {
            throw new Error(`移动端点击搜索按钮未触发搜索：${JSON.stringify(searchSubmitResult?.value)}`);
        }

        await cdp.send('Runtime.evaluate', {
            expression: `document.getElementById('mobileTocBtn')?.click()`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const tocLayout = await readDrawerLayout();
        assertDrawerShell(tocLayout, '移动端目录');
        if (!tocLayout.tocList
            || tocLayout.tocList.x - tocLayout.drawer.x < 10
            || tocLayout.tocList.width < tocLayout.drawer.width - 30) {
            throw new Error(`移动端目录内容安全距离或横向空间不足：${JSON.stringify(tocLayout)}`);
        }

        await cdp.send('Runtime.evaluate', {
            expression: `document.getElementById('mobileThumbBtn')?.click()`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const thumbLayout = await readDrawerLayout();
        assertDrawerShell(thumbLayout, '移动端页面预览');
        const [firstThumb, secondThumb] = thumbLayout.firstThumbnails || [];
        if (!thumbLayout.thumbButton
            || thumbLayout.thumbnailParent !== 'drawerThumb'
            || thumbLayout.thumbnailCount < 1
            || !thumbLayout.thumbnailList
            || thumbLayout.thumbnailList.width < thumbLayout.drawer.width - 30
            || !firstThumb
            || (secondThumb && secondThumb.x - firstThumb.x < firstThumb.width * 0.8)) {
            throw new Error(`移动端页面预览入口或双列缩略图布局不合格：${JSON.stringify(thumbLayout)}`);
        }
        await cdp.send('Runtime.evaluate', {
            expression: `document.querySelector('#drawerThumb .thumbnail-item')?.click()`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const thumbClickLayout = await readDrawerLayout();
        if (thumbClickLayout.drawerOpen || thumbClickLayout.thumbnailParent !== 'pcViewThumb') {
            throw new Error(`移动端点击缩略图后未关闭预览：${JSON.stringify(thumbClickLayout)}`);
        }

        await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                window.__mobileShowSearchView();
                window.__mobileOpenDrawer('搜索结果');
                document.getElementById('mobileSearchResults').innerHTML =
                    '<div class="search-item"><div class="page-num">第 12 页</div><div class="snippet">用于验证移动端搜索结果的安全边距、长文本换行和横向内容空间。</div></div>' +
                    '<div class="search-item"><div class="page-num">第 28 页</div><div class="snippet">第二条搜索结果布局测试内容。</div></div>';
            })()`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const searchLayout = await readDrawerLayout();
        assertDrawerShell(searchLayout, '移动端搜索结果');
        if (!searchLayout.searchResults || searchLayout.searchResults.width < searchLayout.drawer.width - 30) {
            throw new Error(`移动端搜索结果内容横向空间不足：${JSON.stringify(searchLayout)}`);
        }
        console.log(`\n移动端目录/页面预览/搜索布局：${JSON.stringify({ searchFocus: searchFocusResult.value, searchBlur: searchBlurResult.value, searchSubmitGeometry, searchSubmit: searchSubmitResult.value, tocLayout, thumbLayout, thumbClickLayout, searchLayout })}`);
    }

    if (testMobilePageSlider) {
        const sliderDeadline = performance.now() + 15000;
        let sliderReady = false;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const slider = document.getElementById('pageSlider');
                    const bar = document.getElementById('pageSliderBar');
                    return !!slider && !!bar && getComputedStyle(bar).display !== 'none' && Number(slider.max) > 1;
                })()`,
                returnByValue: true,
            }, sessionId);
            sliderReady = !!result?.value;
            if (!sliderReady) await new Promise((resolve) => setTimeout(resolve, 100));
        } while (!sliderReady && performance.now() < sliderDeadline);
        if (!sliderReady) throw new Error('移动端底部翻页滑块初始化超时');

        const readMobileSlider = async () => {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const bar = document.getElementById('pageSliderBar');
                    const slider = document.getElementById('pageSlider');
                    const tip = document.getElementById('pageSliderTip');
                    const rect = bar?.getBoundingClientRect();
                    const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
                    return {
                        viewport: { width: innerWidth, height: innerHeight },
                        display: bar ? getComputedStyle(bar).display : '',
                        rect: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom } : null,
                        hitInside: !!(bar && hit && bar.contains(hit)),
                        value: slider?.value || '',
                        max: slider?.max || '',
                        ariaValue: bar?.getAttribute('aria-valuenow') || '',
                        tip: tip?.textContent || '',
                        tipVisible: tip?.classList.contains('show') || false,
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            return result?.value;
        };

        const initialSlider = await readMobileSlider();
        if (initialSlider.display !== 'flex'
            || !initialSlider.rect
            || initialSlider.rect.width < 190
            || initialSlider.rect.height < 42
            || initialSlider.viewport.width - initialSlider.rect.right < 40
            || initialSlider.rect.x < 40
            || initialSlider.viewport.height - initialSlider.rect.bottom < 10
            || !initialSlider.hitInside) {
            throw new Error(`移动端底部翻页滑块不可见或安全距离不合格：${JSON.stringify(initialSlider)}`);
        }

        const targetPage = Math.min(3, Number(initialSlider.max));
        await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const slider = document.getElementById('pageSlider');
                slider.value = '${targetPage}';
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            })()`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const changedSlider = await readMobileSlider();
        if (changedSlider.value !== String(targetPage)
            || changedSlider.ariaValue !== String(targetPage)
            || !changedSlider.tipVisible
            || !changedSlider.tip.startsWith(`${targetPage} /`)) {
            throw new Error(`移动端底部翻页滑块未能翻页或显示页码：${JSON.stringify({ initialSlider, changedSlider })}`);
        }
        console.log(`\n移动端底部翻页滑块：${JSON.stringify({ initialSlider, changedSlider })}`);
    }

    if (testPcPageArrows) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const readArrowState = async () => {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const prev = document.getElementById('pcPrevPageBtn');
                    const next = document.getElementById('pcNextPageBtn');
                    const buttonState = (button) => {
                        const rect = button?.getBoundingClientRect();
                        return button && rect ? {
                            disabled: button.disabled,
                            display: getComputedStyle(button).display,
                            opacity: getComputedStyle(button).opacity,
                            x: Math.round(rect.left),
                            y: Math.round(rect.top),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height),
                        } : null;
                    };
                    const active = [...document.querySelectorAll('#flipbook .page')]
                        .map((page, index) => {
                            const rect = page.getBoundingClientRect();
                            return {
                                index,
                                pageNum: page.dataset.pageNum || '',
                                inserted: page.dataset.inserted || '',
                                display: getComputedStyle(page).display,
                                left: rect.left,
                                right: rect.right,
                                top: rect.top,
                                bottom: rect.bottom,
                                width: rect.width,
                                height: rect.height,
                            };
                        })
                        .filter((page) => page.display !== 'none' && page.width > 20 && page.height > 20);
                    const pageBounds = active.length ? {
                        left: Math.min(...active.map((page) => page.left)),
                        right: Math.max(...active.map((page) => page.right)),
                        top: Math.min(...active.map((page) => page.top)),
                        bottom: Math.max(...active.map((page) => page.bottom)),
                    } : null;
                    return {
                        platform: document.body.dataset.platform || '',
                        orientation: document.getElementById('flipbook')?.classList.contains('single-centered')
                            ? 'single' : 'double',
                        slider: document.getElementById('pageSlider')?.value || '',
                        prev: buttonState(prev),
                        next: buttonState(next),
                        pageBounds,
                        active,
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            return result?.value;
        };
        const activeKey = (state) => JSON.stringify(state?.active || []);
        const dispatchArrowClick = async (button, edge = 'center') => {
            const x = button.x + button.width / 2;
            const y = edge === 'top' ? button.y + 8
                : edge === 'bottom' ? button.y + button.height - 8
                : button.y + button.height / 2;
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
        };
        const observePageFlipAnimation = async (label) => {
            const started = performance.now();
            const deadline = started + 2500;
            let sawFlipping = false;
            let sample = null;
            while (performance.now() < deadline) {
                const { result } = await cdp.send('Runtime.evaluate', {
                    expression: `(() => {
                        const visible = (selector) => [...document.querySelectorAll(selector)].some((node) => {
                            const style = getComputedStyle(node);
                            const rect = node.getBoundingClientRect();
                            return style.display !== 'none' && rect.width > 1 && rect.height > 1;
                        });
                        const soft = visible('.stf__outerShadow, .stf__innerShadow');
                        const hard = visible('.stf__hardShadow, .stf__hardInnerShadow');
                        const movingPages = [...document.querySelectorAll('#flipbook .stf__item')]
                            .filter((node) => {
                                const style = getComputedStyle(node);
                                return style.display !== 'none' && !node.classList.contains('--simple') && style.transform !== 'none';
                            })
                            .map((node) => ({
                                pageNum: node.dataset.pageNum || '',
                                density: node.classList.contains('--soft') ? 'soft' : (node.classList.contains('--hard') ? 'hard' : ''),
                                transform: getComputedStyle(node).transform,
                            }));
                        const flipState = document.getElementById('flipbook')?.dataset.flipState || '';
                        return {
                            active: flipState === 'flipping' || soft || hard || movingPages.length > 0,
                            flipState,
                            kind: soft ? 'soft' : (hard ? 'hard' : (movingPages[0]?.density || '')),
                            movingPages,
                        };
                    })()`,
                    returnByValue: true,
                }, sessionId);
                const state = result?.value;
                if (state?.flipState === 'flipping') sawFlipping = true;
                if (state?.kind && !sample) sample = state;
                if (sawFlipping && sample && state?.flipState === 'read') {
                    return { kind: sample.kind, observedFor: Math.round(performance.now() - started), sample };
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error(`${label}未检测到完整 PageFlip 动画：${JSON.stringify({ sawFlipping, sample })}`);
        };
        const assertStableArrowPosition = (before, after, label) => {
            for (const side of ['prev', 'next']) {
                if (Math.abs((before?.[side]?.x || 0) - (after?.[side]?.x || 0)) > 1
                    || Math.abs((before?.[side]?.y || 0) - (after?.[side]?.y || 0)) > 1) {
                    throw new Error(`${label}后${side}箭头发生跳动：${JSON.stringify({ before: before?.[side], after: after?.[side] })}`);
                }
            }
        };
        const assertArrowsAttached = (state, label) => {
            if (!state?.pageBounds || !state?.prev || !state?.next) {
                throw new Error(`${label}缺少箭头或页面边界：${JSON.stringify(state)}`);
            }
            const leftGap = state.pageBounds.left - (state.prev.x + state.prev.width);
            const rightGap = state.next.x - state.pageBounds.right;
            const prevTopGap = state.prev.y - state.pageBounds.top;
            const nextTopGap = state.next.y - state.pageBounds.top;
            const prevBottomGap = (state.prev.y + state.prev.height) - state.pageBounds.bottom;
            const nextBottomGap = (state.next.y + state.next.height) - state.pageBounds.bottom;
            if ([leftGap, rightGap, prevTopGap, nextTopGap, prevBottomGap, nextBottomGap]
                .some((gap) => Math.abs(gap) > 3)) {
                throw new Error(`${label}箭头区域未贴合书页：${JSON.stringify({
                    leftGap, rightGap, prevTopGap, nextTopGap, prevBottomGap, nextBottomGap, state
                })}`);
            }
        };
        const initial = await readArrowState();
        if (initial?.platform !== 'pc' || initial.prev?.display === 'none'
            || initial.prev?.width < 40 || initial.next?.width < 40
            || !initial.prev?.disabled || initial.next?.disabled) {
            throw new Error(`PC 翻页箭头初始状态错误：${JSON.stringify(initial)}`);
        }
        assertArrowsAttached(initial, 'PC 单页');

        await dispatchArrowClick(initial.next, 'top');
        const firstAnimation = await observePageFlipAnimation('PC 首屏');
        await new Promise((resolve) => setTimeout(resolve, 800));
        const afterNext = await readArrowState();
        if (activeKey(afterNext) === activeKey(initial) || afterNext.prev?.disabled) {
            throw new Error(`PC 右箭头未翻到下一页：${JSON.stringify({ initial, afterNext })}`);
        }
        if (afterNext.active?.some((page) => page.index === 1 && page.inserted === '1')
            && afterNext.slider !== '2') {
            throw new Error(`首页后的插入页未将滑动条推进到第 2 页：${JSON.stringify({ initial, afterNext })}`);
        }
        assertArrowsAttached(afterNext, 'PC 单页切双页后');

        await dispatchArrowClick(afterNext.next, 'bottom');
        const laterAnimation = await observePageFlipAnimation('PC 后续页面');
        await new Promise((resolve) => setTimeout(resolve, 800));
        const afterNextAgain = await readArrowState();
        if (activeKey(afterNextAgain) === activeKey(afterNext)) {
            throw new Error(`PC 右箭头连续翻页失败：${JSON.stringify({ afterNext, afterNextAgain })}`);
        }
        if (afterNextAgain.active?.some((page) => page.index === 3 && page.inserted === '1')
            && afterNextAgain.slider !== '4') {
            throw new Error(`第二个双页 spread 未将滑动条推进到第 4 页：${JSON.stringify({ afterNext, afterNextAgain })}`);
        }
        assertArrowsAttached(afterNextAgain, 'PC 双页连续翻页后');
        assertStableArrowPosition(afterNext, afterNextAgain, 'PC 同为双页的连续翻页');
        if (firstAnimation.kind !== 'soft'
            || laterAnimation.kind !== 'soft') {
            throw new Error(`PC 首屏与后续页面翻页效果不一致：${JSON.stringify({ firstAnimation, laterAnimation })}`);
        }

        await dispatchArrowClick(afterNextAgain.prev, 'top');
        await new Promise((resolve) => setTimeout(resolve, 1600));
        const afterPrev = await readArrowState();
        if (activeKey(afterPrev) !== activeKey(afterNext)) {
            throw new Error(`PC 左箭头未返回上一屏：${JSON.stringify({ afterNext, afterNextAgain, afterPrev })}`);
        }
        assertArrowsAttached(afterPrev, 'PC 双页返回后');

        await dispatchArrowClick(afterPrev.prev, 'bottom');
        await new Promise((resolve) => setTimeout(resolve, 1600));
        const afterPrevAgain = await readArrowState();
        if (activeKey(afterPrevAgain) !== activeKey(initial) || !afterPrevAgain.prev?.disabled) {
            throw new Error(`PC 左箭头未返回封面：${JSON.stringify({ initial, afterNext, afterNextAgain, afterPrev, afterPrevAgain })}`);
        }
        assertArrowsAttached(afterPrevAgain, 'PC 双页切单页后');

        await cdp.send('Runtime.evaluate', {
            expression: `window.__app?.goToPage?.(3)`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const afterGotoThree = await readArrowState();
        if (afterGotoThree.slider !== '2'
            || !afterGotoThree.active?.some((page) => page.index === 1)
            || !afterGotoThree.active?.some((page) => page.index === 2)) {
            throw new Error(`跳转第 3 页未落到 2-3 双页：${JSON.stringify({ afterPrevAgain, afterGotoThree })}`);
        }
        assertArrowsAttached(afterGotoThree, 'PC 跳转 2-3 双页后');

        await cdp.send('Runtime.evaluate', {
            expression: `window.store?.pageFlip?.turnToPage?.(55)`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const beforeTailSpreads = await readArrowState();
        if (beforeTailSpreads.slider !== '56'
            || !beforeTailSpreads.active?.some((page) => page.pageNum === '54')
            || !beforeTailSpreads.active?.some((page) => page.pageNum === '55')) {
            throw new Error(`尾部前一屏未显示 56：${JSON.stringify(beforeTailSpreads)}`);
        }

        await cdp.send('Runtime.evaluate', {
            expression: `window.store?.pageFlip?.turnToPage?.(57)`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const firstLastPageSpread = await readArrowState();
        if (firstLastPageSpread.slider !== '58'
            || !firstLastPageSpread.active?.some((page) => page.pageNum === '56')
            || !firstLastPageSpread.active?.some((page) => page.pageNum === '57')) {
            throw new Error(`尾部倒数第二屏未显示 58：${JSON.stringify(firstLastPageSpread)}`);
        }

        await cdp.send('Runtime.evaluate', {
            expression: `window.store?.pageFlip?.turnToPage?.(59)`,
        }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const lastSpread = await readArrowState();
        if (lastSpread.slider !== '58'
            || !lastSpread.active?.some((page) => page.pageNum === '58')) {
            throw new Error(`最后一个双页未保持 58：${JSON.stringify({ firstLastPageSpread, lastSpread })}`);
        }
        const tailSliderValues = [beforeTailSpreads.slider, firstLastPageSpread.slider, lastSpread.slider];
        if (tailSliderValues.join(',') !== '56,58,58') {
            throw new Error(`PC 尾部滑块页码错误：${JSON.stringify({ tailSliderValues, beforeTailSpreads, firstLastPageSpread, lastSpread })}`);
        }
        console.log(`\nPC 左右箭头状态：${JSON.stringify({ initial, firstAnimation, afterNext, laterAnimation, afterNextAgain, afterPrev, afterPrevAgain })}`);
    }

    if (testPcPageClick) {
        const readPcClickState = async () => {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const fb = document.getElementById('flipbook');
                    const rect = fb?.getBoundingClientRect();
                    const active = [...document.querySelectorAll('#flipbook .page')]
                        .map((page, index) => ({
                            index,
                            pageNum: page.dataset.pageNum || '',
                            display: getComputedStyle(page).display,
                            width: page.getBoundingClientRect().width,
                            height: page.getBoundingClientRect().height,
                        }))
                        .filter((page) => page.display !== 'none' && page.width > 20 && page.height > 20);
                    return {
                        platform: document.body.dataset.platform || '',
                        rect: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null,
                        slider: document.getElementById('pageSlider')?.value || '',
                        active,
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            return result?.value;
        };
        const clickDeadline = performance.now() + 8000;
        let beforeClick;
        do {
            beforeClick = await readPcClickState();
            if (beforeClick?.platform === 'pc' && beforeClick.rect?.width > 20 && beforeClick.active?.length) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        } while (performance.now() < clickDeadline);
        if (!beforeClick?.rect?.width || !beforeClick.active?.length) {
            throw new Error(`PC 页面单击测试目标未就绪：${JSON.stringify(beforeClick)}`);
        }
        const clickX = beforeClick.rect.x + beforeClick.rect.width / 2;
        const clickY = beforeClick.rect.y + beforeClick.rect.height / 2;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 400));
        const afterClick = await readPcClickState();
        if (JSON.stringify(afterClick?.active || []) !== JSON.stringify(beforeClick.active || [])
            || afterClick?.slider !== beforeClick.slider) {
            throw new Error(`PC 页面普通单击不应翻页：${JSON.stringify({ beforeClick, afterClick })}`);
        }
        console.log(`\nPASS: PC 页面普通单击未翻页：${JSON.stringify({ beforeClick, afterClick })}`);
    }

    if (testMobileTextSelection) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        const selectionDeadline = performance.now() + 5000;
        let selectionTarget;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const page = document.querySelector('#flipbook .page[data-page-num="1"]');
                    if (!page || getComputedStyle(page).display === 'none') return null;
                    const spans = [...page.querySelectorAll('.textLayer span')];
                    for (const span of spans) {
                        const rect = span.getBoundingClientRect();
                        if (rect.width < 8 || rect.height < 6) continue;
                        const x = Math.max(1, Math.min(innerWidth - 2, rect.left + rect.width / 2));
                        const y = Math.max(1, Math.min(innerHeight - 2, rect.top + rect.height / 2));
                        const hit = document.elementFromPoint(x, y);
                        if (hit === span || hit?.closest?.('.textLayer span') === span) {
                            const style = getComputedStyle(span);
                            return {
                                x, y,
                                spanCount: spans.length,
                                textLength: (span.textContent || '').length,
                                userSelect: style.userSelect,
                                webkitUserSelect: style.webkitUserSelect,
                                pageDisplay: getComputedStyle(page).display,
                                slider: document.getElementById('pageSlider')?.value || '',
                            };
                        }
                    }
                    return { waiting: true, spanCount: spans.length };
                })()`,
                returnByValue: true,
            }, sessionId);
            selectionTarget = result?.value;
            if (selectionTarget?.x != null) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        } while (performance.now() < selectionDeadline);
        if (!selectionTarget?.x || selectionTarget.userSelect !== 'text') {
            throw new Error(`移动端文本层不可选择：${JSON.stringify(selectionTarget)}`);
        }

        const { result: beforeSelectionResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                window.__selectionMoveProbeEvent = null;
                document.addEventListener('touchmove', (event) => {
                    window.__selectionMoveProbeEvent = event;
                }, { capture: true });
                const active = [...document.querySelectorAll('#flipbook .page')]
                    .map((page, index) => ({ index, display: getComputedStyle(page).display }))
                    .filter((page) => page.display !== 'none');
                return { active, slider: document.getElementById('pageSlider')?.value || '' };
            })()`,
            returnByValue: true,
        }, sessionId);
        const point = {
            x: Math.round(selectionTarget.x),
            y: Math.round(selectionTarget.y),
            id: 1,
            radiusX: 1,
            radiusY: 1,
            force: 1,
        };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 520));
        const { result: heldResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => ({
                selecting: document.getElementById('flipbook')?.classList.contains('mobile-text-selecting') || false,
                selectedText: window.getSelection?.().toString() || '',
            }))()`,
            returnByValue: true,
        }, sessionId);
        const movedPoint = { ...point, x: Math.min(388, point.x + 28) };
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [movedPoint] }, sessionId);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const { result: afterSelectionResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const active = [...document.querySelectorAll('#flipbook .page')]
                    .map((page, index) => ({ index, display: getComputedStyle(page).display }))
                    .filter((page) => page.display !== 'none');
                return {
                    active,
                    slider: document.getElementById('pageSlider')?.value || '',
                    moveProbe: window.__selectionMoveProbeEvent
                        ? { defaultPrevented: window.__selectionMoveProbeEvent.defaultPrevented }
                        : null,
                    selectedText: window.getSelection?.().toString() || '',
                };
            })()`,
            returnByValue: true,
        }, sessionId);
        if (!heldResult?.value?.selecting
            || !heldResult.value.selectedText
            || !afterSelectionResult.value.selectedText
            || afterSelectionResult.value.selectedText.length <= heldResult.value.selectedText.length
            || JSON.stringify(afterSelectionResult?.value?.active) !== JSON.stringify(beforeSelectionResult?.value?.active)
            || afterSelectionResult?.value?.slider !== beforeSelectionResult?.value?.slider) {
            throw new Error(`移动端长按选择被翻页手势拦截：${JSON.stringify({ selectionTarget, held: heldResult?.value, before: beforeSelectionResult?.value, after: afterSelectionResult?.value })}`);
        }
        console.log(`\n移动端长按选字状态：${JSON.stringify({ selectionTarget, held: heldResult?.value, after: afterSelectionResult?.value })}`);
    }

    if (testMobileNavigation || testMobileCornerTap) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const readMobileState = async () => {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const fb = document.getElementById('flipbook');
                    const rect = fb?.getBoundingClientRect();
                    const pages = [...document.querySelectorAll('#flipbook .page')];
                    const active = pages.map((page, index) => {
                        const pageRect = page.getBoundingClientRect();
                        return {
                            index,
                            pageNum: page.dataset.pageNum || '',
                            inserted: page.dataset.inserted || '',
                            display: getComputedStyle(page).display,
                            x: Math.round(pageRect.left),
                            y: Math.round(pageRect.top),
                            width: Math.round(pageRect.width),
                            height: Math.round(pageRect.height),
                        };
                    }).filter((page) => page.display !== 'none' && page.width > 20 && page.height > 20);
                    const activeRect = active.length > 0
                        ? { x: active[0].x, y: active[0].y, width: active[0].width, height: active[0].height }
                        : null;
                    return {
                        mobile: matchMedia('(max-width: 768px) and (pointer: coarse)').matches,
                        platform: document.body.dataset.platform || '',
                        pcArrowsHidden: ['pcPrevPageBtn', 'pcNextPageBtn'].every((id) => {
                            const arrow = document.getElementById(id);
                            return arrow && getComputedStyle(arrow).display === 'none';
                        }),
                        rect: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null,
                        pageRect: activeRect,
                        slider: document.getElementById('pageSlider')?.value || '',
                        active,
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            return result?.value;
        };
        const activeKey = (state) => JSON.stringify(state?.active || []);
        const dispatchTap = async (x, y) => {
            const point = { x: Math.round(x), y: Math.round(y), id: 1, radiusX: 1, radiusY: 1, force: 1 };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }, sessionId);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
            await new Promise((resolve) => setTimeout(resolve, 900));
        };
        const dispatchSwipeLeft = async (rect) => {
            const y = Math.round(rect.y + rect.height * 0.5);
            const start = { x: Math.round(rect.x + rect.width * 0.75), y, id: 1, radiusX: 1, radiusY: 1, force: 1 };
            const end = { ...start, x: Math.round(rect.x + rect.width * 0.25) };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] }, sessionId);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] }, sessionId);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
            await new Promise((resolve) => setTimeout(resolve, 900));
        };
        const goToPdfPage = async (page) => {
            await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const slider = document.getElementById('pageSlider');
                    slider.value = '${page}';
                    slider.dispatchEvent(new Event('input', { bubbles: true }));
                })()`,
            }, sessionId);
            await new Promise((resolve) => setTimeout(resolve, 350));
        };

        const initial = await readMobileState();
        if (!initial?.mobile || initial.platform !== 'mobile' || !initial.pageRect || !initial.pcArrowsHidden) {
            throw new Error(`移动端模拟未生效：${JSON.stringify(initial)}`);
        }
        const rect = initial.pageRect;
        await dispatchTap(rect.x + rect.width * 0.5, rect.y + rect.height * 0.5);
        const centerTap = await readMobileState();
        if (activeKey(centerTap) !== activeKey(initial)) throw new Error('移动端页面中部点击仍触发了翻页');

        await dispatchTap(rect.x + rect.width - 6, rect.y + 6);
        const topRight = await readMobileState();
        if (activeKey(topRight) === activeKey(initial)) {
            throw new Error(`移动端右上角点击未翻页：${JSON.stringify({ initial, topRight })}`);
        }

        await goToPdfPage(1);
        await dispatchTap(rect.x + rect.width - 6, rect.y + rect.height - 6);
        const bottomRight = await readMobileState();
        if (activeKey(bottomRight) === activeKey(initial)) throw new Error('移动端右下角点击未翻页');

        await goToPdfPage(3);
        const pdfPage3Top = await readMobileState();
        await dispatchTap(rect.x + 6, rect.y + 6);
        const topLeft = await readMobileState();
        if (activeKey(topLeft) === activeKey(pdfPage3Top)) throw new Error('移动端左上角点击未翻页');

        await goToPdfPage(3);
        const pdfPage3Bottom = await readMobileState();
        await dispatchTap(rect.x + 6, rect.y + rect.height - 6);
        const bottomLeft = await readMobileState();
        if (activeKey(bottomLeft) === activeKey(pdfPage3Bottom)) throw new Error('移动端左下角点击未翻页');

        await goToPdfPage(1);
        const beforeSwipe = await readMobileState();
        await dispatchSwipeLeft(rect);
        const afterSwipe = await readMobileState();
        if (activeKey(afterSwipe) === activeKey(beforeSwipe)) throw new Error('移动端横向滑动未翻页');

        const enterFirstInsert = async () => {
            await goToPdfPage(1);
            const cover = await readMobileState();
            await dispatchSwipeLeft(cover.pageRect || rect);
            const inserted = await readMobileState();
            if (!inserted?.active?.some((page) => page.inserted === '1')) {
                throw new Error(`无法进入手机端第二屏插入页：${JSON.stringify({ cover, inserted })}`);
            }
            return inserted;
        };
        const tapInsertCorner = async (horizontal, vertical) => {
            const inserted = await enterFirstInsert();
            const page = inserted.pageRect;
            const x = horizontal === 'left' ? page.x + 6 : page.x + page.width - 6;
            const y = vertical === 'top' ? page.y + 6 : page.y + page.height - 6;
            await dispatchTap(x, y);
            const turned = await readMobileState();
            if (activeKey(turned) === activeKey(inserted)) {
                throw new Error(`手机端插入页${horizontal}-${vertical}角点击未翻页：${JSON.stringify({ inserted, turned })}`);
            }
            return { inserted, turned };
        };
        const insertCenterBefore = await enterFirstInsert();
        await dispatchTap(
            insertCenterBefore.pageRect.x + insertCenterBefore.pageRect.width / 2,
            insertCenterBefore.pageRect.y + insertCenterBefore.pageRect.height / 2,
        );
        const insertCenterAfter = await readMobileState();
        if (activeKey(insertCenterAfter) !== activeKey(insertCenterBefore)) {
            throw new Error(`手机端插入页中心点击发生误翻页：${JSON.stringify({ insertCenterBefore, insertCenterAfter })}`);
        }
        const insertTopRight = await tapInsertCorner('right', 'top');
        const insertBottomRight = await tapInsertCorner('right', 'bottom');
        const insertTopLeft = await tapInsertCorner('left', 'top');
        const insertBottomLeft = await tapInsertCorner('left', 'bottom');

        console.log(`\n移动端翻页状态：${JSON.stringify({ initial, centerTap, topRight, bottomRight, topLeft, bottomLeft, beforeSwipe, afterSwipe, insertCenterBefore, insertCenterAfter, insertTopRight, insertBottomRight, insertTopLeft, insertBottomLeft })}`);
    }

    if (testDoubleClickZoom || testMousePan || testZoomRerender || testPcZoomRightEdge) {
        const readBookState = async () => {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const fb = document.getElementById('flipbook');
                    const container = document.querySelector('.book-container');
                    const containerRect = container?.getBoundingClientRect();
                    const canvas = [...document.querySelectorAll('#flipbook canvas')].find((node) => {
                        const rect = node.getBoundingClientRect();
                        const page = node.closest('.page');
                        return getComputedStyle(page).display !== 'none'
                            && rect.width > 20 && rect.height > 20
                            && (!containerRect || (rect.right > containerRect.left && rect.left < containerRect.right
                                && rect.bottom > containerRect.top && rect.top < containerRect.bottom));
                    });
                    const rect = (canvas || fb)?.getBoundingClientRect();
                    const pageRects = [...document.querySelectorAll('#flipbook .page')]
                        .filter((page) => getComputedStyle(page).display !== 'none')
                        .map((page) => page.getBoundingClientRect())
                        .filter((pageRect) => pageRect.width > 20 && pageRect.height > 20)
                        .filter((pageRect) => !containerRect || (
                            pageRect.right > containerRect.left && pageRect.left < containerRect.right
                            && pageRect.bottom > containerRect.top && pageRect.top < containerRect.bottom
                        ));
                    const pageBounds = pageRects.length ? {
                        left: Math.min(...pageRects.map((pageRect) => pageRect.left)),
                        right: Math.max(...pageRects.map((pageRect) => pageRect.right)),
                        top: Math.min(...pageRects.map((pageRect) => pageRect.top)),
                        bottom: Math.max(...pageRects.map((pageRect) => pageRect.bottom)),
                    } : null;
                    const arrowState = (id) => {
                        const arrow = document.getElementById(id);
                        const arrowRect = arrow?.getBoundingClientRect();
                        const style = arrow ? getComputedStyle(arrow) : null;
                        return arrow && arrowRect && style ? {
                            x: arrowRect.left,
                            y: arrowRect.top,
                            width: arrowRect.width,
                            height: arrowRect.height,
                            disabled: arrow.disabled,
                            display: style.display,
                            visibility: style.visibility,
                            pointerEvents: style.pointerEvents,
                        } : null;
                    };
                    return rect ? {
                        x: rect.left,
                        y: rect.top,
                        width: rect.width,
                        height: rect.height,
                        viewportWidth: window.innerWidth,
                        viewportHeight: window.innerHeight,
                        transform: fb?.style.transform || '',
                        zoomed: container?.classList.contains('zoomed') || false,
                        arrowRelayout: container?.classList.contains('pc-arrows-relayout') || false,
                        flipState: fb?.dataset.flipState || '',
                        prevArrow: arrowState('pcPrevPageBtn'),
                        nextArrow: arrowState('pcNextPageBtn'),
                         containerBounds: containerRect ? {
                            left: containerRect.left,
                            right: containerRect.right,
                            top: containerRect.top,
                            bottom: containerRect.bottom,
                         } : null,
                         scrollLeft: container?.scrollLeft || 0,
                         scrollWidth: container?.scrollWidth || 0,
                         clientWidth: container?.clientWidth || 0,
                         pageBounds,
                        active: [...document.querySelectorAll('#flipbook .page')]
                            .map((page, index) => ({
                                index,
                                pageNum: page.dataset.pageNum || '',
                                inserted: page.dataset.inserted || '',
                                display: getComputedStyle(page).display,
                            }))
                            .filter((page) => page.display !== 'none'),
                        page: document.getElementById('pageSlider')?.value || '',
                        backingWidth: canvas?.width || 0,
                        backingHeight: canvas?.height || 0,
                        outputScale: Number(canvas?.dataset.outputScale || 0),
                        zoomRender: canvas?.dataset.zoomRender || '',
                        zoomRenderReady: fb?.dataset.zoomRenderReady || '',
                        dpr: window.devicePixelRatio || 1,
                    } : null;
                })()`,
                returnByValue: true,
            }, sessionId);
            return result?.value;
        };
        const dispatchDoubleClick = async (state) => {
            const visibleLeft = Math.max(state.pageBounds?.left ?? state.x, state.containerBounds?.left ?? 0);
            const visibleRight = Math.min(state.pageBounds?.right ?? (state.x + state.width), state.containerBounds?.right ?? state.viewportWidth);
            const visibleTop = Math.max(state.pageBounds?.top ?? state.y, state.containerBounds?.top ?? 0);
            const visibleBottom = Math.min(state.pageBounds?.bottom ?? (state.y + state.height), state.containerBounds?.bottom ?? state.viewportHeight);
            const x = Math.max(visibleLeft + 60, Math.min(visibleLeft + (visibleRight - visibleLeft) * 0.55, visibleRight - 60));
            const y = Math.max(visibleTop + 20, Math.min(visibleTop + (visibleBottom - visibleTop) * 0.5, visibleBottom - 20));
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 }, sessionId);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 }, sessionId);
            await new Promise((resolve) => setTimeout(resolve, 450));
        };
        const dispatchArrowClick = async (arrow) => {
            const x = arrow.x + arrow.width / 2;
            const y = arrow.y + arrow.height / 2;
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
        };
        const activeKey = (state) => JSON.stringify(state?.active || []);

        // 第一页 Canvas 日志早于预览层 220ms 淡出结束；等实际 #flipbook 成为点击目标。
        await new Promise((resolve) => setTimeout(resolve, 350));
        const before = await readBookState();
        if (!before?.width || !before?.height) throw new Error('无法获取双击缩放测试区域');
        await dispatchDoubleClick(before);
        const zoomRenderDeadline = performance.now() + 8000;
        let zoomed;
        do {
            zoomed = await readBookState();
            if (zoomed?.zoomRenderReady === '2' && zoomed.zoomRender === '2') break;
            await new Promise((resolve) => setTimeout(resolve, 80));
        } while (performance.now() < zoomRenderDeadline);

        if (testPcZoomRightEdge) {
            // 宽屏下 200% 内容仍未横向溢出时，按钮 + 页面组合也必须从阅读区左边界开始，
            // 不能被 #zoomWrap 的常规 auto margin 再次居中并在左侧形成大块空白。
            const zoomedMaxScrollLeft = Math.max(0, (zoomed?.scrollWidth || 0) - (zoomed?.clientWidth || 0));
            if (zoomedMaxScrollLeft <= 3) {
                const fitPageLeftGap = zoomed?.containerBounds && zoomed?.pageBounds
                    ? zoomed.pageBounds.left - zoomed.containerBounds.left
                    : Infinity;
                const fitPrevGap = zoomed?.prevArrow && zoomed?.pageBounds
                    ? zoomed.pageBounds.left - (zoomed.prevArrow.x + zoomed.prevArrow.width)
                    : Infinity;
                const fitPrevOuterGap = zoomed?.containerBounds && zoomed?.prevArrow
                    ? zoomed.prevArrow.x - zoomed.containerBounds.left
                    : Infinity;
                console.log(`PC 放大未横向溢出左对齐状态：${JSON.stringify({
                    scrollLeft: zoomed?.scrollLeft,
                    zoomedMaxScrollLeft,
                    fitPageLeftGap,
                    fitPrevGap,
                    fitPrevOuterGap,
                })}`);
                if (!zoomed?.zoomed
                    || Math.abs(fitPageLeftGap - (zoomed.prevArrow?.width || 52)) > 3
                    || Math.abs(fitPrevGap) > 3
                    || Math.abs(fitPrevOuterGap) > 3) {
                    throw new Error(`PC 放大未横向溢出时左侧仍有额外空白：${JSON.stringify({ zoomed, fitPageLeftGap, fitPrevGap, fitPrevOuterGap })}`);
                }
                if (pcZoomFitScreenshotOut) {
                    const screenshot = await cdp.send('Page.captureScreenshot', {
                        format: 'png', captureBeyondViewport: false,
                    }, sessionId);
                    await writeFile(pcZoomFitScreenshotOut, Buffer.from(screenshot.data, 'base64'));
                }
            }
        }

        if (testMousePan) {
            const { result: scrollBeforeResult } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const el = document.querySelector('.book-container');
                    return { left: el?.scrollLeft || 0, top: el?.scrollTop || 0 };
                })()`,
                returnByValue: true,
            }, sessionId);
            const dragX = Math.max(zoomed.x + 20, Math.min(zoomed.x + zoomed.width * 0.5, zoomed.viewportWidth - 40));
            const dragY = Math.max(zoomed.y + 140, Math.min(zoomed.y + zoomed.height * 0.65, zoomed.viewportHeight - 40));
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragX, y: dragY, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragX, y: dragY - 100, button: 'left', buttons: 1 }, sessionId);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragX, y: dragY - 100, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
            await new Promise((resolve) => setTimeout(resolve, 500));
            const { result: scrollAfterResult } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const el = document.querySelector('.book-container');
                    return {
                        left: el?.scrollLeft || 0,
                        top: el?.scrollTop || 0,
                        transform: document.getElementById('flipbook')?.style.transform || '',
                        page: document.getElementById('pageSlider')?.value || '',
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            console.log(`PC 按住拖动状态：${JSON.stringify({ before: scrollBeforeResult?.value, after: scrollAfterResult?.value })}`);
            if (Math.abs((scrollAfterResult?.value?.top || 0) - (scrollBeforeResult?.value?.top || 0)) < 40
                || !/scale\(2\)/.test(scrollAfterResult?.value?.transform || '')
                || scrollAfterResult?.value?.page !== before.page) {
                throw new Error('PC 按住鼠标拖动测试失败，或拖动后发生了误翻页/缩放复位');
            }
            zoomed = await readBookState();
        }

        // 放大态下按钮必须保持可见并可实际翻页；跨封面单页/正文双页重建后倍率仍为 200%。
        if (!zoomed?.nextArrow || zoomed.nextArrow.disabled
            || zoomed.nextArrow.pointerEvents === 'none') {
            throw new Error(`PC 放大态右翻页按钮不可操作：${JSON.stringify(zoomed)}`);
        }
        await dispatchArrowClick(zoomed.nextArrow);
        const turnStartedAt = performance.now();
        const turnDeadline = performance.now() + 7000;
        let zoomedAfterTurn;
        do {
            zoomedAfterTurn = await readBookState();
            const bounds = zoomedAfterTurn?.containerBounds;
            const pageBounds = zoomedAfterTurn?.pageBounds;
            const pageIntersectsViewport = bounds && pageBounds
                && pageBounds.right > bounds.left && pageBounds.left < bounds.right
                && pageBounds.bottom > bounds.top && pageBounds.top < bounds.bottom;
            const arrowsOnOppositeSides = zoomedAfterTurn?.prevArrow && zoomedAfterTurn?.nextArrow
                && zoomedAfterTurn.prevArrow.x + zoomedAfterTurn.prevArrow.width
                    <= zoomedAfterTurn.nextArrow.x + 2;
            if (performance.now() - turnStartedAt > 1100
                && activeKey(zoomedAfterTurn) !== activeKey(zoomed)
                && zoomedAfterTurn?.zoomed
                && /scale\(2\)/.test(zoomedAfterTurn.transform)
                && (!testZoomRerender || (zoomedAfterTurn.zoomRenderReady === '2'
                    && zoomedAfterTurn.zoomRender === '2'))
                && zoomedAfterTurn.flipState !== 'flipping'
                && !zoomedAfterTurn.arrowRelayout
                && !zoomedAfterTurn.prevArrow?.disabled
                && pageIntersectsViewport
                && arrowsOnOppositeSides) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        } while (performance.now() < turnDeadline);

        if (testPcZoomRightEdge) {
            const panToHorizontalEdge = async (edge, initialState) => {
                let state = initialState;
                let attempts = 0;
                const atTarget = () => {
                    const maxScrollLeft = Math.max(0, (state?.scrollWidth || 0) - (state?.clientWidth || 0));
                    return edge === 'max'
                        ? Math.abs((state?.scrollLeft || 0) - maxScrollLeft) <= 3
                        : (state?.scrollLeft || 0) <= 3;
                };
                while (attempts < 12 && !atTarget()) {
                    const bounds = state?.containerBounds;
                    if (!bounds) break;
                    // PageFlip 左页事件层在部分 landscape 状态会截断冒泡；回拖从当前可见右页区域开始。
                    const dragStartX = edge === 'max' ? bounds.right - 120 : bounds.right - 300;
                    const dragEndX = edge === 'max' ? bounds.left + 8 : bounds.right - 8;
                    const visibleTop = Math.max(bounds.top, state?.pageBounds?.top ?? bounds.top);
                    const visibleBottom = Math.min(bounds.bottom, state?.pageBounds?.bottom ?? bounds.bottom);
                    const dragY = Math.max(bounds.top + 80, Math.min((visibleTop + visibleBottom) / 2, bounds.bottom - 80));
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mouseMoved', x: dragStartX, y: dragY, button: 'none', buttons: 0,
                    }, sessionId);
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mousePressed', x: dragStartX, y: dragY, button: 'left', buttons: 1, clickCount: 1,
                    }, sessionId);
                    const dragSteps = Math.max(3, Math.ceil(Math.abs(dragStartX - dragEndX) / 220));
                    for (let step = 1; step <= dragSteps; step += 1) {
                        const x = dragStartX + (dragEndX - dragStartX) * (step / dragSteps);
                        await cdp.send('Input.dispatchMouseEvent', {
                            type: 'mouseMoved', x, y: dragY, button: 'left', buttons: 1,
                        }, sessionId);
                    }
                    await cdp.send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased', x: dragEndX, y: dragY, button: 'left', buttons: 0, clickCount: 1,
                    }, sessionId);
                    attempts += 1;
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    state = await readBookState();
                }
                return { state, attempts };
            };

            // 从当前锚点使用真实鼠标拖到最右；禁止直接写 scrollLeft 冒充拖动成功。
            const rightPan = await panToHorizontalEdge('max', zoomedAfterTurn);
            const edgeAfterPan = rightPan.state;
            const maxScrollLeft = Math.max(0, edgeAfterPan.scrollWidth - edgeAfterPan.clientWidth);
            const pageRightGap = edgeAfterPan.containerBounds && edgeAfterPan.pageBounds
                ? edgeAfterPan.containerBounds.right - edgeAfterPan.pageBounds.right
                : Infinity;
            const nextArrowGap = edgeAfterPan.nextArrow && edgeAfterPan.pageBounds
                ? edgeAfterPan.nextArrow.x - edgeAfterPan.pageBounds.right
                : Infinity;
            const nextArrowOuterGap = edgeAfterPan.containerBounds && edgeAfterPan.nextArrow
                ? edgeAfterPan.containerBounds.right - (edgeAfterPan.nextArrow.x + edgeAfterPan.nextArrow.width)
                : Infinity;
            const arrowInside = edgeAfterPan.containerBounds && edgeAfterPan.nextArrow
                && edgeAfterPan.nextArrow.x >= edgeAfterPan.containerBounds.left - 2
                && edgeAfterPan.nextArrow.x + edgeAfterPan.nextArrow.width <= edgeAfterPan.containerBounds.right + 2;
            console.log(`PC 放大真实拖到最右状态：${JSON.stringify({
                attempts: rightPan.attempts,
                scrollLeft: edgeAfterPan.scrollLeft,
                maxScrollLeft,
                pageRightGap,
                nextArrowGap,
                nextArrowOuterGap,
                arrowInside,
            })}`);
            if (!edgeAfterPan?.zoomed
                || maxScrollLeft < 20
                || Math.abs(edgeAfterPan.scrollLeft - maxScrollLeft) > 3
                || Math.abs(pageRightGap - (edgeAfterPan.nextArrow?.width || 52)) > 3
                || Math.abs(nextArrowGap) > 3
                || Math.abs(nextArrowOuterGap) > 3
                || !arrowInside
                || edgeAfterPan.nextArrow?.pointerEvents === 'none') {
                throw new Error(`PC 放大真实拖到最右后右翻按钮或页面留白不符合预期：${JSON.stringify({ zoomedAfterTurn, edgeAfterPan, pageRightGap, nextArrowGap, nextArrowOuterGap, maxScrollLeft, arrowInside })}`);
            }
            if (pcZoomRightScreenshotOut) {
                const screenshot = await cdp.send('Page.captureScreenshot', {
                    format: 'png', captureBeyondViewport: false,
                }, sessionId);
                await writeFile(pcZoomRightScreenshotOut, Buffer.from(screenshot.data, 'base64'));
            }

            // 再从最右使用真实鼠标拖回最左，确保两个边界都经过实际拖拽路径。
            const leftPan = await panToHorizontalEdge('min', edgeAfterPan);
            const leftEdge = leftPan.state;
            const pageLeftGap = leftEdge.containerBounds && leftEdge.pageBounds
                ? leftEdge.pageBounds.left - leftEdge.containerBounds.left
                : Infinity;
            const prevArrowGap = leftEdge.prevArrow && leftEdge.pageBounds
                ? leftEdge.pageBounds.left - (leftEdge.prevArrow.x + leftEdge.prevArrow.width)
                : Infinity;
            const prevArrowOuterGap = leftEdge.containerBounds && leftEdge.prevArrow
                ? leftEdge.prevArrow.x - leftEdge.containerBounds.left
                : Infinity;
            console.log(`PC 放大真实拖到最左状态：${JSON.stringify({
                attempts: leftPan.attempts,
                scrollLeft: leftEdge.scrollLeft,
                pageLeftGap,
                prevArrowGap,
                prevArrowOuterGap,
            })}`);
            if (!leftEdge?.zoomed
                || leftEdge.scrollLeft > 3
                || Math.abs(pageLeftGap - (leftEdge.prevArrow?.width || 52)) > 3
                || Math.abs(prevArrowGap) > 3
                || Math.abs(prevArrowOuterGap) > 3
                || leftEdge.prevArrow?.pointerEvents === 'none') {
                throw new Error(`PC 放大真实拖到最左后左翻按钮或页面留白不符合预期：${JSON.stringify({ leftEdge, pageLeftGap, prevArrowGap, prevArrowOuterGap })}`);
            }
            if (pcZoomLeftScreenshotOut) {
                const screenshot = await cdp.send('Page.captureScreenshot', {
                    format: 'png', captureBeyondViewport: false,
                }, sessionId);
                await writeFile(pcZoomLeftScreenshotOut, Buffer.from(screenshot.data, 'base64'));
            }
        }

        await dispatchDoubleClick(zoomedAfterTurn);
        const restored = await readBookState();
        console.log(`\nPC 双击缩放状态：${JSON.stringify({ before, zoomed, zoomedAfterTurn, restored })}`);
        const zoomedHasEnoughPixels = zoomed?.backingWidth >= Math.floor(zoomed?.width * zoomed?.dpr)
            && zoomed?.backingHeight >= Math.floor(zoomed?.height * zoomed?.dpr);
        const zoomedArrowsVisible = [zoomed?.prevArrow, zoomed?.nextArrow, zoomedAfterTurn?.prevArrow, zoomedAfterTurn?.nextArrow]
            .every((arrow) => arrow?.display !== 'none' && arrow?.visibility === 'visible'
                && arrow?.pointerEvents !== 'none' && arrow?.width >= 40 && arrow?.height >= 20);
        const zoomedArrowsInsideViewport = [zoomed, zoomedAfterTurn].every((state) => {
            const bounds = state?.containerBounds;
            return bounds && [state?.prevArrow, state?.nextArrow].every((arrow) => arrow
                && arrow.x >= bounds.left - 2
                && arrow.x + arrow.width <= bounds.right + 2
                && arrow.y >= bounds.top - 2
                && arrow.y + arrow.height <= bounds.bottom + 2);
        });
        const restoredArrowsVisible = [restored?.prevArrow, restored?.nextArrow]
            .every((arrow) => arrow?.display !== 'none' && arrow?.visibility === 'visible');
        const restoredArrowGaps = restored?.pageBounds ? [
            restored.pageBounds.left - (restored.prevArrow.x + restored.prevArrow.width),
            restored.nextArrow.x - restored.pageBounds.right,
            restored.prevArrow.y - restored.pageBounds.top,
            (restored.prevArrow.y + restored.prevArrow.height) - restored.pageBounds.bottom,
            restored.nextArrow.y - restored.pageBounds.top,
            (restored.nextArrow.y + restored.nextArrow.height) - restored.pageBounds.bottom,
        ] : [Infinity];
        const restoredPageWidth = restored?.pageBounds
            ? restored.pageBounds.right - restored.pageBounds.left
            : Infinity;
        const restoredContainerWidth = restored?.containerBounds
            ? restored.containerBounds.right - restored.containerBounds.left
            : 0;
        const restoredArrowWidths = (restored?.prevArrow?.width || 52) + (restored?.nextArrow?.width || 52);
        const restoredHasOutsideArrowRoom = restoredPageWidth + restoredArrowWidths <= restoredContainerWidth + 3;
        const restoredArrowsInsideViewport = restored?.containerBounds
            && [restored?.prevArrow, restored?.nextArrow].every((arrow) => arrow
                && arrow.x >= restored.containerBounds.left - 2
                && arrow.x + arrow.width <= restored.containerBounds.right + 2);
        if (!zoomed?.zoomed || !/scale\(2\)/.test(zoomed.transform)
            || zoomed.zoomRenderReady !== '2'
            || (!zoomedHasEnoughPixels && (zoomed.zoomRender !== '2' || zoomed.backingWidth <= before.backingWidth))
            || activeKey(zoomedAfterTurn) === activeKey(zoomed)
            || !zoomedAfterTurn?.zoomed || !/scale\(2\)/.test(zoomedAfterTurn.transform)
            || (testZoomRerender && (zoomedAfterTurn.zoomRenderReady !== '2'
                || zoomedAfterTurn.zoomRender !== '2'))
            || restored?.zoomed || restored?.transform
            || !zoomedArrowsVisible || !zoomedArrowsInsideViewport
            || !restoredArrowsVisible || restored?.arrowRelayout
            || !restoredArrowsInsideViewport
            || (restoredHasOutsideArrowRoom && restoredArrowGaps.some((gap) => Math.abs(gap) > 3))
            || zoomed.page !== before.page || restored.page !== zoomedAfterTurn.page) {
            throw new Error('PC 放大态按钮显示、保持倍率翻页或双击复位测试失败');
        }

        if (testZoomRerender) {
            // 高清重渲染用真实 PDF Canvas 计量；先从插入页 spread 返回封面，避免 iframe 页无
            // 可见 Canvas 时把“无样本”误判为重渲染失败。
            await dispatchArrowClick(restored.prevArrow);
            const coverDeadline = performance.now() + 5000;
            let coverRestored;
            do {
                coverRestored = await readBookState();
                if (activeKey(coverRestored) === activeKey(before)
                    && !coverRestored?.zoomed && !coverRestored?.arrowRelayout) break;
                await new Promise((resolve) => setTimeout(resolve, 100));
            } while (performance.now() < coverDeadline);
            if (activeKey(coverRestored) !== activeKey(before)) {
                throw new Error(`PC 高清重渲染前未能返回 PDF 封面：${JSON.stringify(coverRestored)}`);
            }
            await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const range = document.getElementById('zoomRangeBar');
                    for (const value of [150, 200, 300]) {
                        range.value = String(value);
                        range.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                })()`,
            }, sessionId);
            const renderDeadline = performance.now() + 12000;
            let zoom300;
            do {
                zoom300 = await readBookState();
                if (zoom300?.zoomRenderReady === '3' && zoom300.zoomRender === '3') break;
                await new Promise((resolve) => setTimeout(resolve, 100));
            } while (performance.now() < renderDeadline);
            console.log(`PC 300% 高清重渲染状态：${JSON.stringify(zoom300)}`);
            if (!zoom300?.zoomed
                || !/scale\(3\)/.test(zoom300.transform)
                || zoom300.zoomRenderReady !== '3'
                || zoom300.zoomRender !== '3'
                || zoom300.backingWidth <= zoomed.backingWidth
                || zoom300.backingWidth * zoom300.backingHeight > 16_000_000) {
                throw new Error('PC 300% 高清重渲染未完成或超过像素安全上限');
            }
            await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const range = document.getElementById('zoomRangeBar');
                    range.value = '100';
                    range.dispatchEvent(new Event('input', { bubbles: true }));
                })()`,
            }, sessionId);
        }
    }

    if (testSecondPage || testSecondPageEarly) {
        if (!testSecondPageEarly) {
        if (testInsertDoubleClickZoom) {
        const arrowDeadline = performance.now() + 8000;
        let nextArrow;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const button = document.getElementById('pcNextPageBtn');
                    const rect = button?.getBoundingClientRect();
                    const insertsApplied = document.querySelectorAll('#flipbook .page-insert').length > 0;
                    if (!insertsApplied || !button || !rect || button.disabled || rect.width < 20) return null;
                    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
                })()`,
                returnByValue: true,
            }, sessionId);
            nextArrow = result?.value;
            if (!nextArrow) await new Promise((resolve) => setTimeout(resolve, 100));
        } while (!nextArrow && performance.now() < arrowDeadline);
        if (!nextArrow) throw new Error('PC 插入页双击测试无法获取首页右翻页箭头');
        const clickX = nextArrow.x + nextArrow.width / 2;
        const clickY = nextArrow.y + nextArrow.height / 2;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 }, sessionId);
        } else {
        const { result: rectResult } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const candidates = [...document.querySelectorAll('#flipbook canvas, #flipbook .page')];
                const el = candidates.find((node) => {
                    const rect = node.getBoundingClientRect();
                    return rect.width > 20 && rect.height > 20;
                }) || document.getElementById('flipbook');
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
            })()`,
            returnByValue: true,
        }, sessionId);
        const rect = rectResult?.value;
        if (!rect || !rect.width || !rect.height) throw new Error('无法获取 #flipbook 点击区域');
        const clickX = rect.x + rect.width * 0.82;
        const clickY = rect.y + rect.height * 0.5;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 }, sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 }, sessionId);
        }
        }

        const secondDeadline = performance.now() + 8000;
        let secondState;
        do {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const frames = [...document.querySelectorAll('#flipbook .page-insert iframe')];
                    return {
                        currentPageIndex: window.store?.pageFlip?.getCurrentPageIndex?.(),
                        orientation: window.store?.currentOrientation,
                        frames: frames.map((frame) => ({
                            src: frame.getAttribute('src') || '',
                            dataSrc: frame.dataset.src || '',
                            opacity: getComputedStyle(frame).opacity,
                            readyState: frame.contentDocument?.readyState || '',
                            bodyLength: frame.contentDocument?.body?.innerText?.length || 0,
                            doubleClickZoomInjected: !!frame.contentDocument?.__doubleClickZoomInjected,
                            rect: (() => {
                                const rect = frame.getBoundingClientRect();
                                return { width: Math.round(rect.width), height: Math.round(rect.height) };
                            })(),
                        })),
                    };
                })()`,
                returnByValue: true,
            }, sessionId);
            secondState = result?.value;
            if (Number(secondState?.currentPageIndex) > 0
                && secondState?.frames?.some((frame) =>
                frame.src
                && frame.readyState === 'complete'
                && frame.opacity !== '0'
                && frame.rect?.width > 20
                && frame.rect?.height > 20
            )) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
        } while (performance.now() < secondDeadline);
        console.log(`\n第二屏点击状态：${JSON.stringify(secondState)}`);

        if (secondScreenshotOut) {
            const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
            await writeFile(secondScreenshotOut, Buffer.from(screenshot.data, 'base64'));
            console.log(`第二屏截图：${secondScreenshotOut}`);
        }

        if (testInsertDoubleClickZoom) {
            // 等 page-flip 动画尾帧结束，再从 iframe 内非中心位置触发真实坐标双击。
            await new Promise((resolve) => setTimeout(resolve, 900));
            const dispatchInsertDoubleClick = async (expectedZoomed) => {
                const frameDeadline = performance.now() + 4000;
                let triggerPoint;
                do {
                    const { result } = await cdp.send('Runtime.evaluate', {
                        expression: `(() => {
                            const frame = [...document.querySelectorAll('#flipbook .page-insert iframe')]
                                .find((node) => node.getBoundingClientRect().width > 20 && node.contentDocument?.body);
                            if (!frame) return false;
                            const rect = frame.getBoundingClientRect();
                            const innerX = frame.offsetWidth * 0.68;
                            const innerY = frame.offsetHeight * 0.56;
                            frame.__zoomTestPoint = { innerX, innerY };
                            frame.contentDocument.body.dispatchEvent(new frame.contentWindow.MouseEvent('dblclick', {
                                bubbles: true,
                                cancelable: true,
                                view: frame.contentWindow,
                                clientX: innerX,
                                clientY: innerY,
                            }));
                            return {
                                clientX: rect.left + innerX * rect.width / frame.offsetWidth,
                                clientY: rect.top + innerY * rect.height / frame.offsetHeight,
                            };
                        })()`,
                        returnByValue: true,
                    }, sessionId);
                    triggerPoint = result?.value || null;
                    if (!triggerPoint) await new Promise((resolve) => setTimeout(resolve, 100));
                } while (!triggerPoint && performance.now() < frameDeadline);
                if (!triggerPoint) throw new Error('找不到可见插入页，无法测试 iframe 双击缩放');
                const deadline = performance.now() + 2000;
                let state;
                do {
                    const { result: stateResult } = await cdp.send('Runtime.evaluate', {
                        expression: `(() => {
                            const frame = [...document.querySelectorAll('#flipbook .page-insert iframe')]
                                .find((node) => node.getBoundingClientRect().width > 20 && node.contentDocument?.body);
                            const rect = frame?.getBoundingClientRect();
                            const point = frame?.__zoomTestPoint;
                            const next = document.getElementById('pcNextPageBtn');
                            const nextRect = next?.getBoundingClientRect();
                            return {
                                transform: document.getElementById('flipbook')?.style.transform || '',
                                zoomed: document.querySelector('.book-container')?.classList.contains('zoomed') || false,
                                page: document.getElementById('pageSlider')?.value || '',
                                currentPageIndex: window.store?.pageFlip?.getCurrentPageIndex?.(),
                                focusClientX: rect && point
                                    ? rect.left + point.innerX * rect.width / frame.offsetWidth
                                    : null,
                                focusClientY: rect && point
                                    ? rect.top + point.innerY * rect.height / frame.offsetHeight
                                    : null,
                                nextArrow: nextRect ? {
                                    x: nextRect.left, y: nextRect.top,
                                    width: nextRect.width, height: nextRect.height,
                                    disabled: !!next.disabled,
                                } : null,
                            };
                        })()`,
                        returnByValue: true,
                    }, sessionId);
                    state = { ...stateResult?.value, triggerPoint };
                    if (state?.zoomed === expectedZoomed
                        && (!expectedZoomed || (state.nextArrow && !state.nextArrow.disabled))) return state;
                    await new Promise((resolve) => setTimeout(resolve, 50));
                } while (performance.now() < deadline);
                return state;
            };
            const pageBefore = secondState?.currentPageIndex;
            const insertZoomed = await dispatchInsertDoubleClick(true);
            const focusError = Math.hypot(
                (insertZoomed?.focusClientX ?? Infinity) - (insertZoomed?.triggerPoint?.clientX ?? 0),
                (insertZoomed?.focusClientY ?? Infinity) - (insertZoomed?.triggerPoint?.clientY ?? 0),
            );
            const insertRestoredByDoubleClick = await dispatchInsertDoubleClick(false);
            const insertZoomedForTurn = await dispatchInsertDoubleClick(true);
            const nextArrow = insertZoomedForTurn?.nextArrow;
            if (!nextArrow || nextArrow.disabled) throw new Error('PC 插入页放大后右翻页箭头不可用');
            const nextX = nextArrow.x + nextArrow.width / 2;
            const nextY = nextArrow.y + nextArrow.height / 2;
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nextX, y: nextY, button: 'left', clickCount: 1 }, sessionId);
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nextX, y: nextY, button: 'left', clickCount: 1 }, sessionId);
            await new Promise((resolve) => setTimeout(resolve, 1300));
            const { result: afterTurnResult } = await cdp.send('Runtime.evaluate', {
                expression: `(() => ({
                    transform: document.getElementById('flipbook')?.style.transform || '',
                    zoomed: document.querySelector('.book-container')?.classList.contains('zoomed') || false,
                    currentPageIndex: window.store?.pageFlip?.getCurrentPageIndex?.(),
                }))()`,
                returnByValue: true,
            }, sessionId);
            const insertZoomedAfterTurn = afterTurnResult?.value;
            await cdp.send('Runtime.evaluate', {
                expression: `(() => {
                    const range = document.getElementById('zoomRangeBar');
                    if (!range) return false;
                    range.value = '100';
                    range.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                })()`,
            }, sessionId);
            await new Promise((resolve) => setTimeout(resolve, 350));
            const { result: restoredResult } = await cdp.send('Runtime.evaluate', {
                expression: `(() => ({
                    transform: document.getElementById('flipbook')?.style.transform || '',
                    zoomed: document.querySelector('.book-container')?.classList.contains('zoomed') || false,
                    currentPageIndex: window.store?.pageFlip?.getCurrentPageIndex?.(),
                }))()`,
                returnByValue: true,
            }, sessionId);
            const insertRestored = restoredResult?.value;
            console.log(`插入页双击缩放状态：${JSON.stringify({ focusError, insertZoomed, insertRestoredByDoubleClick, insertZoomedForTurn, insertZoomedAfterTurn, insertRestored })}`);
            if (!insertZoomed?.zoomed || !/scale\(2\)/.test(insertZoomed.transform)
                || focusError > 8
                || insertRestoredByDoubleClick?.zoomed || insertRestoredByDoubleClick?.transform
                || !insertZoomedForTurn?.zoomed || !/scale\(2\)/.test(insertZoomedForTurn.transform)
                || !insertZoomedAfterTurn?.zoomed || !/scale\(2\)/.test(insertZoomedAfterTurn.transform)
                || insertZoomedAfterTurn.currentPageIndex === pageBefore
                || insertRestored?.zoomed || insertRestored?.transform
                || insertRestored?.currentPageIndex !== insertZoomedAfterTurn?.currentPageIndex) {
                throw new Error('PC 插入页定位缩放、翻页保持倍率或复位测试失败');
            }
        }
    }
    await new Promise((resolve) => setTimeout(resolve, 800));

    if (previewOut) {
        const { result } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const canvas = document.querySelector('.page[data-page-num="1"] canvas');
                return canvas ? canvas.toDataURL('image/webp', 0.78) : '';
            })()`,
            returnByValue: true,
        }, sessionId);
        const dataUrl = result?.value || '';
        if (!dataUrl.startsWith('data:image/webp;base64,')) {
            throw new Error('第一页 Canvas 未能导出 WebP 预览图');
        }
        await writeFile(previewOut, Buffer.from(dataUrl.split(',')[1], 'base64'));
        console.log(`已生成首屏预览：${previewOut}`);
    }

    const perfLines = consoleLines.filter(({ line }) => line.includes('[perf]'));
    const relevant = [...requests.values()]
        .filter((row) => /sample\.pdf|first-page-preview|pdf\.worker|finder\.js|debug-web|\/data\//i.test(row.url))
        .sort((a, b) => a.startedAt - b.startedAt);

    console.log(`URL: ${targetUrl}`);
    for (const { line } of perfLines) console.log(line);
    console.log(`CDP observed first canvas: ${Math.round(firstCanvasAt)} ms`);
    console.log('\n关键请求：');
    for (const row of relevant) {
        const name = row.url.split('/').pop();
        const phase = row.startedAt <= firstCanvasAt ? '首屏前' : '首屏后';
        const ttfb = Number.isFinite(row.ttfb) ? `${Math.round(row.ttfb)}ms` : '-';
        const size = Number.isFinite(row.encodedBytes) ? `${Math.round(row.encodedBytes / 1024)}KB` : '-';
        const duration = Number.isFinite(row.finishedAt) ? `${Math.round(row.finishedAt - row.startedAt)}ms` : '-';
        console.log(`${phase.padEnd(4)} +${Math.round(row.startedAt)}ms ${row.status || '-'} ${name} range=${row.range || '-'} ttfb=${ttfb} total=${duration} server=${row.serverTime || '-'} size=${size}${row.failed ? ` failed=${row.failed}` : ''}`);
    }

    const blockingExtras = relevant.filter((row) => row.startedAt <= firstCanvasAt && /finder\.js|debug-web|\/data\//i.test(row.url));
    const nonRangePdfRequests = relevant.filter((row) => /sample\.pdf/i.test(row.url)
        && row.status != null
        && (row.status !== 206 || !/^bytes=/i.test(row.range || '')));
    if (blockingExtras.length && !testDoubleClickZoom && !testZoomRerender && !testNormalClarity && !testInsertDoubleClickZoom && !testMousePan && !testMobileNavigation && !testMobileCornerTap && !testMobileTextSelection && !testMobileFirstLoad && !testMobileFirstLoadEarly && !testMobileFirstTurnStability && !testMobileDrawerLayout && !testMobilePageSlider && !testMobilePinchRerender && !testPcPageArrows && !testPcPageArrowsEarly && !testPcPageClick && !testPcZoomRightEdge) {
        console.error(`\nFAIL: 第一页前仍有 ${blockingExtras.length} 个非关键大资源。`);
        process.exitCode = 2;
    } else {
        console.log((testDoubleClickZoom || testZoomRerender || testNormalClarity || testInsertDoubleClickZoom || testMousePan || testMobileNavigation || testMobileCornerTap || testMobileTextSelection || testMobileFirstLoad || testMobileFirstLoadEarly || testMobileFirstTurnStability || testMobileDrawerLayout || testMobilePageSlider || testMobilePinchRerender || testPcPageArrows || testPcPageArrowsEarly || testPcPageClick || testPcZoomRightEdge)
            ? '\nPASS: 交互测试已完成（跳过首屏附加资源时序守卫）。'
            : '\nPASS: 第一页前没有 finder/debug-web/插入页 HTML 请求。');
    }
    if (nonRangePdfRequests.length) {
        console.error(`FAIL: 检测到 ${nonRangePdfRequests.length} 个非 206 Range 的 sample.pdf 请求。`);
        process.exitCode = 3;
    } else {
        console.log('PASS: sample.pdf 全部通过 206 Range 加载，没有整文件 200 请求。');
    }
} finally {
    if (cdp) {
        try {
            await Promise.race([
                cdp.send('Browser.close'),
                new Promise((resolve) => setTimeout(resolve, 500)),
            ]);
        } catch { /* Chrome may already be gone. */ }
    }
    if (chrome && chrome.exitCode == null) {
        await Promise.race([
            new Promise((resolve) => chrome.once('exit', resolve)),
            new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
    }
    if (chrome && chrome.exitCode == null) chrome.kill();
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await rm(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            break;
        } catch (error) {
            if (attempt === 4) console.warn(`[perf] 临时 Chrome 目录稍后清理：${error.message}`);
            else await new Promise((resolve) => setTimeout(resolve, 300));
        }
    }
}
