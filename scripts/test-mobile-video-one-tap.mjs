import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const targetUrl = process.argv[2]
    || 'http://127.0.0.1:5174/pdf/data/v19_single_pages/C3_纵向专题｜视频与要点_单页.html';
const useRealCC = process.env.TEST_REAL_CC === '1';
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
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(message));
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

const profileDir = await mkdtemp(join(tmpdir(), 'flipbook-video-one-tap-'));
let chrome;
let cdp;

try {
    chrome = spawn(chromePath, [
        '--headless=new',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        `--user-data-dir=${profileDir}`,
        'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    cdp = new CdpClient(await waitForBrowserWs(chrome));
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await Promise.all([
        cdp.send('Runtime.enable', {}, sessionId),
        cdp.send('Page.enable', {}, sessionId),
        cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 390,
            height: 844,
            deviceScaleFactor: 1,
            mobile: true,
        }, sessionId),
        cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }, sessionId),
        cdp.send('Emulation.setUserAgentOverride', {
            userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
            platform: 'Android',
        }, sessionId),
    ]);

    if (!useRealCC) {
        // 用可观测的播放器工厂替代外部 SDK，隔离网络波动，只验证一次真实触摸的事件链。
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `
            window.__ccOneTapProbe = { createCalls: 0, playCalls: 0, activeAtCreate: false, activeAtPlay: false };
            window.createCCH5Player = function (options) {
                window.__ccOneTapProbe.createCalls += 1;
                window.__ccOneTapProbe.activeAtCreate = !!navigator.userActivation?.isActive;
                window.__ccOneTapProbe.autoStart = options.autoStart;
                window.__ccOneTapProbe.realAutoPlay = options.realAutoPlay;
                const marker = document.createElement('div');
                marker.dataset.ccOneTapPlayer = 'true';
                options.parentNode.appendChild(marker);
                const video = document.createElement('video');
                video.play = function () {
                    window.__ccOneTapProbe.playCalls += 1;
                    window.__ccOneTapProbe.activeAtPlay = !!navigator.userActivation?.isActive;
                    Object.defineProperty(video, 'paused', { configurable: true, value: false });
                    return Promise.resolve();
                };
                options.parentNode.appendChild(video);
                setTimeout(function () {
                    if (typeof window.on_CCH5player_ready === 'function') {
                        window.on_CCH5player_ready({ vid: options.vid, videoElement: video, container: options.parentNode });
                    }
                }, 0);
                return {
                    play: function () { return video.play(); },
                    destroy: function () {}
                };
            };
            `,
        }, sessionId);
    }

    await cdp.send('Page.navigate', { url: targetUrl }, sessionId);
    if (useRealCC) {
        const factoryDeadline = Date.now() + 20000;
        let factoryReady = false;
        while (!factoryReady && Date.now() < factoryDeadline) {
            const { result } = await cdp.send('Runtime.evaluate', {
                expression: `typeof window.createCCH5Player === 'function'`,
                returnByValue: true,
            }, sessionId);
            factoryReady = result?.value === true;
            if (!factoryReady) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!factoryReady) throw new Error('真实 CC 播放器工厂加载超时');
        await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                window.__ccOneTapProbe = { createCalls: 0, playCalls: 0, readyCalls: 0, playingCalls: 0 };
                const originalFactory = window.createCCH5Player;
                window.createCCH5Player = function (options) {
                    window.__ccOneTapProbe.createCalls += 1;
                    window.__ccOneTapProbe.active = !!navigator.userActivation?.isActive;
                    const player = originalFactory.apply(this, arguments);
                    window.__ccOneTapProbe.playerKeys = player ? Object.keys(player) : [];
                    return player;
                };
                const originalReady = window.on_CCH5player_ready;
                window.on_CCH5player_ready = function (payload) {
                    window.__ccOneTapProbe.readyCalls += 1;
                    const video = payload?.videoElement;
                    window.__ccOneTapProbe.readyVideo = !!video;
                    if (video) {
                        window.__ccOneTapProbe.pausedAtReady = video.paused;
                        video.addEventListener('playing', () => { window.__ccOneTapProbe.playingCalls += 1; });
                    }
                    if (typeof originalReady === 'function') return originalReady.apply(this, arguments);
                };
            })()`,
        }, sessionId);
    }
    const deadline = Date.now() + 10000;
    let button;
    while (!button && Date.now() < deadline) {
        const { result } = await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const element = document.querySelector('.video-poster');
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                const shell = element.closest('.cc-video-shell');
                return rect.width > 20 && rect.height > 20 && !element.disabled && shell?.dataset.playerReady === 'true'
                    ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
                    : null;
            })()`,
            returnByValue: true,
        }, sessionId);
        button = result?.value;
        if (!button) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!button) throw new Error('移动端视频播放按钮未出现');
    if (useRealCC) {
        await cdp.send('Runtime.evaluate', {
            expression: `(() => {
                const video = document.querySelector('.cc-player-host video');
                window.__ccOneTapProbe = window.__ccOneTapProbe || {};
                window.__ccOneTapProbe.videoReadyBeforeTap = !!video;
                window.__ccOneTapProbe.pausedBeforeTap = video?.paused;
                if (video) video.addEventListener('playing', () => { window.__ccOneTapProbe.playingCalls = (window.__ccOneTapProbe.playingCalls || 0) + 1; });
            })()`,
        }, sessionId);
    }

    const point = {
        x: Math.max(2, Math.min(388, button.x + button.width / 2)),
        y: Math.max(2, Math.min(842, button.y + button.height / 2)),
        id: 1,
        radiusX: 1,
        radiusY: 1,
        force: 1,
    };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }, sessionId);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    await new Promise((resolve) => setTimeout(resolve, useRealCC ? 6000 : 150));

    const { result } = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
            const shell = document.querySelector('.cc-video-shell');
            const poster = shell?.querySelector('.video-poster');
            const host = shell?.querySelector('.cc-player-host');
            return {
                ...window.__ccOneTapProbe,
                started: shell?.dataset.started,
                posterHidden: !!poster?.hidden,
                hostHidden: !!host?.hidden,
                playerCreated: !!host?.querySelector('[data-cc-one-tap-player="true"]'),
                videoCount: host?.querySelectorAll('video').length || 0,
                videoPaused: host?.querySelector('video')?.paused,
                videoReadyState: host?.querySelector('video')?.readyState,
            };
        })()`,
        returnByValue: true,
    }, sessionId);
    const state = result?.value;
    if (useRealCC) {
        console.log(`REAL_CC_STATE: ${JSON.stringify(state)}`);
        if (!state?.videoReadyBeforeTap
            || state.pausedBeforeTap !== true
            || state.videoPaused !== false
            || state.playingCalls < 1
            || state.started !== 'true'
            || !state.posterHidden
            || state.hostHidden) {
            throw new Error(`真实 CC 播放器一次触摸未开始播放：${JSON.stringify(state)}`);
        }
        console.log(`PASS: 真实 CC 播放器一次点击即播放：${JSON.stringify(state)}`);
    } else {
        if (state?.createCalls !== 1
            || state.playCalls !== 1
            || state.started !== 'true'
            || !state.posterHidden
            || state.hostHidden
            || !state.playerCreated
            || state.autoStart !== false
            || state.realAutoPlay !== false
            || state.activeAtPlay !== true) {
            throw new Error(`一次触摸未完成播放链路：${JSON.stringify(state)}`);
        }
        console.log(`PASS: 手机端一次点击即创建并启动播放器：${JSON.stringify(state)}`);
    }
} finally {
    if (cdp) {
        try { await cdp.send('Browser.close'); } catch { /* Chrome may already be gone. */ }
    }
    if (chrome && chrome.exitCode == null) chrome.kill();
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
