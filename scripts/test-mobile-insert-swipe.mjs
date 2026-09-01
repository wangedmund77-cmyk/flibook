import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const targetUrl = process.argv[2] || 'http://127.0.0.1:5173/pdf/';
const chromePath = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find(existsSync);

if (!chromePath) throw new Error('未找到 Chrome，可通过 CHROME_PATH 指定 chrome.exe');

class CdpClient {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
    }
    async open() {
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        this.ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result || {});
        });
    }
    send(method, params = {}, sessionId) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }
}

function waitForBrowserWs(chrome) {
    return new Promise((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(new Error(`Chrome 启动超时：${output.slice(-500)}`)), 10000);
        chrome.stderr.setEncoding('utf8');
        chrome.stderr.on('data', (chunk) => {
            output += chunk;
            const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
            if (!match) return;
            clearTimeout(timeout);
            resolve(match[1]);
        });
    });
}

const waitForValue = async (cdp, sessionId, expression, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { result } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
        if (result?.value) return result.value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const { result: diagnostic } = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
            mobile: window.__isMobile?.(),
            platform: document.body?.dataset?.platform,
            current: window.store?.pageFlip?.getCurrentPageIndex?.(),
            frames: Array.from(document.querySelectorAll('.page-insert iframe')).map((frame) => {
                const rect = frame.getBoundingClientRect();
                return { src: frame.src, pending: frame.dataset.src, ready: !!frame.contentDocument?.__insertGestureBridgeInstalled, width: rect.width, height: rect.height };
            })
        })`,
        returnByValue: true,
    }, sessionId);
    throw new Error(`等待页面状态超时：${expression.slice(0, 120)}；诊断=${diagnostic?.value}`);
};

const dispatchSwipe = async (cdp, sessionId, rect, direction) => {
    const fromX = direction === 'next' ? rect.left + rect.width * 0.78 : rect.left + rect.width * 0.22;
    const toX = direction === 'next' ? rect.left + rect.width * 0.22 : rect.left + rect.width * 0.78;
    const y = rect.top + rect.height * 0.72;
    const point = (x) => ({ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(fromX)] }, sessionId);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point((fromX + toX) / 2)] }, sessionId);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(toX)] }, sessionId);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
};

const dispatchPinch = async (cdp, sessionId, center, fromHalfDistance, toHalfDistance) => {
    const points = (halfDistance) => [
        { x: center.x - halfDistance, y: center.y, id: 1, radiusX: 1, radiusY: 1, force: 1 },
        { x: center.x + halfDistance, y: center.y, id: 2, radiusX: 1, radiusY: 1, force: 1 },
    ];
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: points(fromHalfDistance),
    }, sessionId);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: points((fromHalfDistance + toHalfDistance) / 2),
    }, sessionId);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: points(toHalfDistance),
    }, sessionId);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
};

const profileDir = await mkdtemp(join(tmpdir(), 'flipbook-insert-swipe-'));
let chrome;
let cdp;
try {
    chrome = spawn(chromePath, [
        '--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run',
        '--remote-debugging-port=0', '--remote-allow-origins=*',
        `--user-data-dir=${profileDir}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    cdp = new CdpClient(await waitForBrowserWs(chrome));
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await Promise.all([
        cdp.send('Runtime.enable', {}, sessionId),
        cdp.send('Page.enable', {}, sessionId),
        cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId),
        cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 }, sessionId),
        cdp.send('Emulation.setUserAgentOverride', {
            userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
            platform: 'Android',
        }, sessionId),
    ]);
    await cdp.send('Page.navigate', { url: targetUrl }, sessionId);

    await waitForValue(cdp, sessionId, `window.store?.pageFlip && window.store.insertVisible === true`);
    await waitForValue(cdp, sessionId, `!document.getElementById('firstPagePreview')
        && window.store.pageFlip.getCurrentPageIndex() === 0`);
    await cdp.send('Runtime.evaluate', { expression: `(() => {
        const nativeFetch = window.fetch.bind(window);
        const nativeAnchorClick = HTMLAnchorElement.prototype.click;
        window.__downloadTestRestore = () => {
            window.fetch = nativeFetch;
            HTMLAnchorElement.prototype.click = nativeAnchorClick;
        };
        window.fetch = (input, init) => String(input).includes('/previewByUrl/')
            ? Promise.resolve(new Response(
                new Blob(['%PDF-1.7\\n%%EOF'], { type: 'application/pdf' }),
                { status: 200, headers: { 'content-type': 'application/pdf' } }
            ))
            : nativeFetch(input, init);
        HTMLAnchorElement.prototype.click = function () {
            window.__downloadTriggered = { href: this.href, download: this.download };
        };
        document.getElementById('mobileDownloadBtn').click();
    })()` }, sessionId);
    const downloadResult = await waitForValue(cdp, sessionId, `window.__downloadTriggered`);
    if (!downloadResult.href.startsWith('blob:') || !downloadResult.download.endsWith('.pdf')) {
        throw new Error(`WAP 下载未使用 PDF Blob：${JSON.stringify(downloadResult)}`);
    }
    await cdp.send('Runtime.evaluate', {
        expression: `window.__downloadTestRestore?.(); delete window.__downloadTestRestore;`,
    }, sessionId);
    await waitForValue(cdp, sessionId, `!document.getElementById('shareToast')?.classList.contains('show')`, 5000);
    const zoomTarget = await waitForValue(cdp, sessionId, `(() => {
        const canvas = document.querySelector('#flipbook .page[data-page-num="1"] canvas');
        const rect = canvas?.getBoundingClientRect();
        if (!rect || rect.width <= 100 || rect.height <= 100) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    const fixedUiBefore = await waitForValue(cdp, sessionId, `(() => {
        const toolbar = document.querySelector('.mobile-toolbar').getBoundingClientRect();
        const slider = document.querySelector('.page-slider-bar').getBoundingClientRect();
        return { toolbar: [toolbar.width, toolbar.height], slider: [slider.width, slider.height] };
    })()`);
    await dispatchPinch(cdp, sessionId, zoomTarget, 40, 100);
    await waitForValue(cdp, sessionId, `window.store.currentZoom > 2`);
    const fixedUiAfter = await waitForValue(cdp, sessionId, `(() => {
        const toolbar = document.querySelector('.mobile-toolbar').getBoundingClientRect();
        const slider = document.querySelector('.page-slider-bar').getBoundingClientRect();
        return {
            toolbar: [toolbar.width, toolbar.height],
            slider: [slider.width, slider.height],
            viewportScale: window.visualViewport?.scale || 1,
            contentTransform: getComputedStyle(document.getElementById('zoomWrap')).transform,
        };
    })()`);
    const stable = [...fixedUiBefore.toolbar, ...fixedUiBefore.slider].every(
        (value, index) => Math.abs(value - [...fixedUiAfter.toolbar, ...fixedUiAfter.slider][index]) < 0.5
    );
    if (!stable || Math.abs(fixedUiAfter.viewportScale - 1) > 0.01
        || fixedUiAfter.contentTransform === 'none') {
        throw new Error(`双指缩放错误地改变了固定 UI：${JSON.stringify({ fixedUiBefore, fixedUiAfter })}`);
    }
    await dispatchPinch(cdp, sessionId, zoomTarget, 100, 40);
    await waitForValue(cdp, sessionId, `window.store.currentZoom <= 1.01`);

    await cdp.send('Runtime.evaluate', { expression: `window.store.pageFlip.flip(1)` }, sessionId);
    await waitForValue(cdp, sessionId, `window.store.pageFlip.getCurrentPageIndex() === 1`, 5000);
    const rect = await waitForValue(cdp, sessionId, `(() => {
        for (const frame of document.querySelectorAll('.page-insert iframe')) {
            const rect = frame.getBoundingClientRect();
            if (frame.contentDocument?.__insertGestureBridgeInstalled && rect.width > 100 && rect.height > 100) {
                return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            }
        }
        return null;
    })()`);

    const insertCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    await dispatchPinch(cdp, sessionId, insertCenter, 40, 100);
    await waitForValue(cdp, sessionId, `window.store.currentZoom > 2`);
    await dispatchPinch(cdp, sessionId, insertCenter, 100, 40);
    await waitForValue(cdp, sessionId, `window.store.currentZoom <= 1.01`);

    await dispatchSwipe(cdp, sessionId, rect, 'next');
    await waitForValue(cdp, sessionId, `window.store.pageFlip.getCurrentPageIndex() > 1`, 5000);
    await cdp.send('Runtime.evaluate', { expression: `window.store.pageFlip.turnToPage(1)` }, sessionId);
    await waitForValue(cdp, sessionId, `window.store.pageFlip.getCurrentPageIndex() === 1`, 5000);
    await dispatchSwipe(cdp, sessionId, rect, 'prev');
    await waitForValue(cdp, sessionId, `window.store.pageFlip.getCurrentPageIndex() === 0`, 5000);

    await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Mobile MicroMessenger/8.0.50',
        platform: 'Android',
    }, sessionId);
    await cdp.send('Runtime.evaluate', { expression: `window.__waitingForWechatReload = true` }, sessionId);
    await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
    await waitForValue(cdp, sessionId, `!window.__waitingForWechatReload
        && window.store?.pageFlip && document.body?.dataset?.platform === 'mobile'`);
    await cdp.send('Runtime.evaluate', { expression: `(() => {
        window.__wechatDownloadNavigated = false;
        HTMLAnchorElement.prototype.click = function () { window.__wechatDownloadNavigated = true; };
        document.getElementById('mobileDownloadBtn').click();
    })()` }, sessionId);
    await waitForValue(cdp, sessionId, `document.getElementById('wechatIosDownloadGuide')?.hidden === false`);
    const wechatResult = await waitForValue(cdp, sessionId, `({
        navigated: window.__wechatDownloadNavigated,
        hasLegacyHandoff: new URL(location.href).searchParams.has('se_download')
    })`);
    if (wechatResult.navigated || wechatResult.hasLegacyHandoff) {
        throw new Error(`微信端不应直接下载或跳转附件：${JSON.stringify(wechatResult)}`);
    }
    console.log('PASS: WAP 使用 Blob 下载；微信保留当前阅读页引导；内容缩放与左右翻页正常');
} finally {
    if (cdp) {
        try { await cdp.send('Browser.close'); } catch { /* browser may already be gone */ }
    }
    if (chrome && chrome.exitCode == null) chrome.kill();
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
