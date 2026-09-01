// 埋点追踪模块（主线版）
// 封装 finder.js / SeDataFinder 的初始化与上报，供 PDF 翻页阅读器主线各业务点调用。
// 与 POC 的 src/poc/tracking.js 解耦：POC 用于探测多候选通道，主线只用稳定通道 + 轻量容错。
//
// 验证方式（本地核对 webID / 事件属性）：
//   SDK init 后右下角会自动出现 AppLog 调试按钮；若点击无响应，在控制台执行
//   window.applogDevToolsWeb && window.applogDevToolsWeb()
//   然后 AppLog → 埋点列表 → 事件 → user 字段查看 webID 与上报属性。

const APP_ID = 'NSMA_UAT';
const FINDER_SDK_URL = 'https://nsma-web.schneider-electric.cn/finder_prod.js';
const PDF_VIEW_PLUGIN_STORAGE_KEY = 'se_pdf_view_plugin';
const MAX_PENDING_EVENTS = 100;
const MAX_INIT_RETRIES = 3;
const INIT_RETRY_DELAYS_MS = [1000, 2000, 4000];
const WHITEPAPER_NAME = '“化”解之道-赢得化工企业绿色竞争力转型';
const DEFAULT_PDF_VIEW_PLUGIN = {
    // 当前白皮书的固定标识；后续微页面接入后可由 item.id 覆盖。
    page_id: '47d83bf8-5c64-4c42-9b17-e05e05c9a5af',
    page_name: WHITEPAPER_NAME,
    title: WHITEPAPER_NAME,
    file_url: 'https://nsma-web.schneider-electric.cn/platform/file/attachment/previewByUrl/eda08d684b1944bda08cbac02f128da0',
    file_name: `${WHITEPAPER_NAME}.pdf`,
    file_size: 12894208,
    file_id: 'cb3416ec172e481f9752d83a00992bc0',
    activity_id: 'CN_202605_ALL-SBD-CHEMICAL-INDUSTRY-GREEN-TRANSFORM-WP',
    activity_name: 'CN_202605_All-SBD-Chemical-Industry-Green-Transform-WP',
};
const LEGACY_DEFAULT_PDF_VIEW_PLUGIN = {
    page_id: 'test1',
    page_name: '名称1',
    title: '标题1',
    file_url: 'https://nsma-web.schneider-electric.cn/pdf/CN_202605_ALL-SBD-CHEMICAL-INDUSTRY-GREEN-TRANSFORM-WP.pdf',
    file_name: '4a517dd54c224910a0744918cfa45530d (1).pdf',
};
const LEGACY_FILE_URLS = new Set([
    LEGACY_DEFAULT_PDF_VIEW_PLUGIN.file_url,
    'https://nsma-web.schneider-electric.cn/pdf/sample.pdf',
]);
let initialized = false;
let initPromise = null;
let finderScriptPromise = null;
let commonConfig = {};   // 预置的公共/上下文字段（来自埋点需求.pdf）
let pendingEvents = [];
let initRetryTimer = null;
let initRetryCount = 0;

function isDebug() {
    try {
        return new URLSearchParams(window.location.search).get('debug') === '1';
    } catch (e) {
        return false;
    }
}

const DEBUG_FIELDS = {
    predefine_pageview: ['title', 'url', 'url_path', 'page_id', 'page_name', 'content_from', 'page_num'],
    predefine_page_alive: ['title', 'url', 'url_path', 'page_id', 'page_name', 'content_from', 'duration'],
    predefine_page_close: ['title', 'url', 'url_path', 'page_id', 'page_name', 'content_from', 'page_num', 'duration', 'active_time', 'total_duration'],
    pdf_page_view: ['title', 'url', 'url_path', 'page_id', 'page_name', 'content_from', 'page_num', 'from_page_num', 'to_page_num', 'jump_trigger', 'duration'],
    click_link_in_page: ['page_id', 'page_name', 'content_from', 'page_num', 'title', 'url', 'page_url'],
    search_keywords: ['page_id', 'page_name', 'content_from', 'title', 'url', 'page_num', 'search_keywords'],
    search_result: ['title', 'url', 'page_id', 'page_name', 'content_from', 'page_num', 'search_keywords', 'result_count', 'result'],
    share: ['content_from', 'page_id', 'page_name', 'title', 'url', 'page_num'],
    file_download: ['title', 'url', 'page_id', 'page_name', 'content_from', 'file_url', 'file_name', 'file_size', 'file_id'],
};

const FILE_DOWNLOAD_FIELDS = ['file_url', 'file_name', 'file_size', 'file_id'];

function pickDebugFields(eventName, payload) {
    const fields = DEBUG_FIELDS[eventName];
    if (!fields) return payload;
    const result = {};
    for (const field of fields) result[field] = payload[field];
    return result;
}

// pdf_page_view 的触发来源与上一屏停留时长状态。
let _pendingJumpTrigger = '';
let _lastPageStayStart = 0;
let _lastPageStayVisible = true;
let _pageStayAccumMs = 0;

function normalizePdfViewPluginParams(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const normalized = { ...value };
    if (!Object.prototype.hasOwnProperty.call(normalized, 'page_id')
        && Object.prototype.hasOwnProperty.call(normalized, 'pageId')) {
        normalized.page_id = normalized.pageId;
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, 'page_name')
        && Object.prototype.hasOwnProperty.call(normalized, 'pageName')) {
        normalized.page_name = normalized.pageName;
    }
    delete normalized.pageId;
    delete normalized.pageName;
    return normalized;
}

function getDefaultPdfViewPlugin() {
    return { ...DEFAULT_PDF_VIEW_PLUGIN };
}

function fileSizeBytesToKb(value) {
    return Number.isFinite(value) && value >= 0
        ? Math.round((value / 1024) * 100) / 100
        : value;
}

function ensurePdfViewPluginStorage() {
    try {
        const storage = window.localStorage;
        const raw = storage.getItem(PDF_VIEW_PLUGIN_STORAGE_KEY);
        if (raw === null) {
            storage.setItem(PDF_VIEW_PLUGIN_STORAGE_KEY, JSON.stringify(getDefaultPdfViewPlugin()));
            return;
        }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
        const existing = normalizePdfViewPluginParams(parsed);
        const merged = { ...getDefaultPdfViewPlugin(), ...existing };
        // 仅迁移此前本地调试版本写入的占位值，避免覆盖微页面注入的真实配置。
        Object.entries(LEGACY_DEFAULT_PDF_VIEW_PLUGIN).forEach(([field, legacyValue]) => {
            if (existing[field] === legacyValue) merged[field] = DEFAULT_PDF_VIEW_PLUGIN[field];
        });
        if (LEGACY_FILE_URLS.has(existing.file_url)) {
            merged.file_url = DEFAULT_PDF_VIEW_PLUGIN.file_url;
        }
        try {
            const fileUrl = new URL(merged.file_url, window.location.href);
            if (fileUrl.hostname === 'localhost' || fileUrl.hostname === '127.0.0.1' || fileUrl.hostname === '::1') {
                merged.file_url = DEFAULT_PDF_VIEW_PLUGIN.file_url;
            }
        } catch (e) {
            merged.file_url = DEFAULT_PDF_VIEW_PLUGIN.file_url;
        }
        const normalized = JSON.stringify(merged);
        if (normalized !== raw) storage.setItem(PDF_VIEW_PLUGIN_STORAGE_KEY, normalized);
    } catch (e) {
        // localStorage 受限时不影响 PDF 和埋点主流程。
    }
}

function getPdfViewPluginParams() {
    try {
        const raw = window.localStorage.getItem(PDF_VIEW_PLUGIN_STORAGE_KEY);
        if (!raw) return {};
        const params = normalizePdfViewPluginParams(JSON.parse(raw));
        // se_pdf_view_plugin 的 file_size 原始单位为字节，上报统一转换为 KB。
        if (Object.prototype.hasOwnProperty.call(params, 'file_size')) {
            params.file_size = fileSizeBytesToKb(params.file_size);
        }
        return params;
    } catch (e) {
        if (isDebug()) console.warn('[tracker] se_pdf_view_plugin JSON 解析失败');
        return {};
    }
}

function buildPhysicalPageTitle(pluginParams, pageNum) {
    const whitepaperName = String(pluginParams?.title ?? '').trim();
    if (!whitepaperName) return '';
    return pageNum == null || pageNum === ''
        ? whitepaperName
        : `${whitepaperName}_${pageNum}`;
}

function scheduleTrackerRetry() {
    if (initialized || initRetryTimer != null || pendingEvents.length === 0
        || initRetryCount >= MAX_INIT_RETRIES) return;
    const delay = INIT_RETRY_DELAYS_MS[initRetryCount]
        || INIT_RETRY_DELAYS_MS[INIT_RETRY_DELAYS_MS.length - 1];
    initRetryCount += 1;
    initRetryTimer = window.setTimeout(() => {
        initRetryTimer = null;
        if (initialized || pendingEvents.length === 0) return;
        const retryPromise = initTracker();
        retryPromise.then((ok) => {
            if (!ok) scheduleTrackerRetry();
        });
    }, delay);
}

export function setJumpTrigger(trigger) {
    if (trigger) _pendingJumpTrigger = trigger;
}

function consumeJumpTrigger() {
    const trigger = _pendingJumpTrigger || 'unknown';
    _pendingJumpTrigger = '';
    return trigger;
}

export function peekJumpTrigger() {
    return _pendingJumpTrigger || 'unknown';
}

export function clearJumpTrigger() {
    _pendingJumpTrigger = '';
}

export function markPageStayStart() {
    _lastPageStayStart = performance.now();
    _lastPageStayVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    _pageStayAccumMs = 0;
}

export function measurePrevPageStayMs() {
    if (!_lastPageStayStart) return 0;
    const segment = (_lastPageStayVisible ? performance.now() : _lastPageStayStart) - _lastPageStayStart;
    return Math.round(_pageStayAccumMs + Math.max(0, segment));
}

export function updatePageStayVisibility() {
    if (document.visibilityState === 'hidden') {
        if (_lastPageStayVisible && _lastPageStayStart) {
            _pageStayAccumMs += performance.now() - _lastPageStayStart;
        }
        _lastPageStayVisible = false;
    } else {
        _lastPageStayStart = performance.now();
        _lastPageStayVisible = true;
    }
}

export function trackPdfPageView({ pageNum, fromPageNum, toPageNum, trigger, durationMs, isInsert, insertTitle }) {
    const params = {
        page_num: pageNum ?? toPageNum,
        from_page_num: fromPageNum,
        to_page_num: toPageNum,
        jump_trigger: trigger || consumeJumpTrigger(),
        // 客户最新事件定义暂未包含这两个字段，保留参数但暂停上报。
        // is_insert: !!isInsert,
        // insert_title: insertTitle || '',
    };
    // duration 由调用方按事件口径传入；PC 双页按客户最新要求，两条事件携带相同停留时长。
    if (durationMs !== null) params.duration = durationMs ?? measurePrevPageStayMs();
    track('pdf_page_view', params);
}

// 埋点不是首屏必需资源。动态加载可确保 finder/debug-web 不会阻塞 PDF.js
// Worker、PDF Range 分片和第一页 Canvas。
function loadFinderSdk() {
    if (window.SeDataFinder && typeof window.SeDataFinder.init === 'function') {
        return Promise.resolve(true);
    }
    if (finderScriptPromise) return finderScriptPromise;

    finderScriptPromise = new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };
        const script = document.createElement('script');
        script.src = FINDER_SDK_URL;
        script.async = true;
        script.onload = () => finish(!!window.SeDataFinder);
        script.onerror = () => finish(false);
        document.head.appendChild(script);
        window.setTimeout(() => finish(!!window.SeDataFinder), 8000);
    });
    return finderScriptPromise;
}

// ---- 构造 SDK 公共属性（事件参数中的 page_id / page_name 统一由 localStorage 覆盖）----
function buildCommonConfig() {
    const search = new URLSearchParams(window.location.search);
    const pdfName = (window.store && window.store.pdfName) || search.get('file') || 'unknown_whitepaper';
    // page_id：PDF 要求 flipbook 的 id。无真实来源时按文件名稳定派生一个 fake id。
    const pageId = 'flipbook_' + encodeURIComponent(pdfName);
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const screen_width = (typeof window !== 'undefined' && window.screen) ? window.screen.width : 0;
    const screen_height = (typeof window !== 'undefined' && window.screen) ? window.screen.height : 0;
    let os_name = 'unknown';
    if (/Windows NT/i.test(ua)) os_name = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) os_name = 'macOS';
    else if (/Android/i.test(ua)) os_name = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) os_name = 'iOS';
    else if (/Linux/i.test(ua)) os_name = 'Linux';
    const cfg = {
        // event_platform: 'SMA',
        // content_from: 'flipbook',                 // PDF：固定 flipbook
        // page_id: pageId,                          // fake：由文件名派生
        // page_name: pdfName,                       // PDF：白皮书的名称
        // url: window.location.href,                // PDF：当前页面 url
        // url_path: window.location.pathname,       // PDF：当前页面 url_path
        // ---- utm 系列：PDF 要求"从 url 获取" ----
        // utm_source: search.get('utm_source') || '',
        // utm_medium: search.get('utm_medium') || '',
        // utm_campaign: search.get('utm_campaign') || '',
        // utm_content: search.get('utm_content') || '',
        // utm_term: search.get('utm_term') || '',
        // ---- se_ 系列（部分来源）：无则空 ----
        // se_sr: search.get('se_sr') || '',
        // se_md: search.get('se_md') || '',
        // se_ct: search.get('se_ct') || '',
        // se_tr: search.get('se_tr') || '',
        // referral: search.get('referral') || '',
        // activity_id: 'CN_202605_ALL-SBD-CHEMICAL-INDUSTRY-GREEN-TRANSFORM-WP',
        // activity_name: 'CN_202605_All-SBD-Chemical-Industry-Green-Transform-WP',
        // country: 'China',
        // province: '',
        // city: '',
        // app_version: (typeof window !== 'undefined' && window.__APP_VERSION__) || 'v1.0.0',
        // device_model: '',
        // os_name,
        // screen_width,
        // screen_height,
        // width: screen_width,
        // height: screen_height,
        // task_id: pdfName,
        // sub_task_id: '',
        // device: ua,
        // user_agent: ua,
        // _ip_int: 0,
        // referer: (typeof document !== 'undefined' ? document.referrer || '' : ''),
        // referer_page: '',
        // referer_page_id: '',
        // referral_source: search.get('referral_source') || '',
        // referral_medium: search.get('referral_medium') || '',
        // referral_campaign: search.get('referral_campaign') || '',
        // url_full_domain: (typeof location !== 'undefined' ? location.host : ''),
        // referer_full_domain: (typeof document !== 'undefined' && document.referrer)
        //     ? (() => { try { return new URL(document.referrer).host; } catch { return ''; } })() : '',
        // referer_site_name: '',
        // referer_type: '',
        // network_type: (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.effectiveType)
        //     ? navigator.connection.effectiveType : '',
        // os_version: (() => {
        //     const match = ua.match(/(?:Windows NT |Android |OS |Mac OS X )([\d._]+)/i);
        //     return match ? match[1] : '';
        // })(),
        // aid: 0,
        // title: pdfName,
    };
    return cfg;
}

// 翻页或切页时刷新公共 title；每条事件仍会根据自身 page_num 重新生成最终 title。
export function setCommonTitle(label) {
    const plugin = getPdfViewPluginParams();
    commonConfig.title = buildPhysicalPageTitle(plugin, label);
}

// ---- 初始化：init + 预置公共属性（合并 SDK 公共参数 + 我们的公共字段）----
export function initTracker() {
    if (initPromise) return initPromise;
    ensurePdfViewPluginStorage();
    initPromise = (async () => {
        const loaded = await loadFinderSdk();
        if (!loaded) {
            console.warn('[tracker] finder.js 加载失败，跳过埋点初始化');
            initPromise = null;
            finderScriptPromise = null;
            scheduleTrackerRetry();
            return false;
        }
        const SDF = window.SeDataFinder;
        if (!SDF || typeof SDF.init !== 'function') {
            console.warn('[tracker] SeDataFinder 未加载，跳过埋点初始化');
            initPromise = null;
            finderScriptPromise = null;
            scheduleTrackerRetry();
            return false;
        }
        try {
            // 1) init（appId + 配置）
            if (SDF.init.length <= 1) {
                SDF.init({ app_id: APP_ID, log: false });
            } else {
                SDF.init(APP_ID, { log: false });
            }
            // 2) 预置公共属性：SDK 自带公共参数 + 我们的公共字段
            commonConfig = buildCommonConfig();
            let common = { ...commonConfig };
            try {
                const pub = (typeof SDF.getPublicEventParams === 'function') ? SDF.getPublicEventParams() : null;
                if (pub && typeof pub === 'object') common = { ...pub, ...commonConfig };
            } catch (e) { /* 失败则仅用 commonConfig */ }
            if (typeof SDF.setConfigForPdf === 'function') {
                SDF.setConfigForPdf(common);
            } else if (typeof window.collectEvent === 'function') {
                // finder_prod.js 的 setConfig 会额外触发一次内置 predefinePageView。
                // 这里直接完成 config/start，页面曝光统一由业务代码携带完整参数上报。
                window.collectEvent('config', common);
                window.collectEvent('start');
            }

            // 3) 调试面板仅按需启用。生产访问不加载 debug-web；需要核对埋点时
            // 使用 ?debug=1，正式埋点初始化和上报不受影响。
            const debugEnabled = new URLSearchParams(window.location.search).get('debug') === '1';
            if (debugEnabled) {
                try {
                    if (typeof window.applogDevToolsWeb === 'function') window.applogDevToolsWeb();
                    else if (window.applogDevToolsWeb && typeof window.applogDevToolsWeb.open === 'function') window.applogDevToolsWeb.open();
                } catch (e) { /* 不影响上报 */ }
            }

            initialized = true;
            initRetryCount = 0;
            if (initRetryTimer != null) {
                window.clearTimeout(initRetryTimer);
                initRetryTimer = null;
            }
            flushPendingEvents();
            console.log('[tracker] init 完成', { appId: APP_ID });
            return true;
        } catch (e) {
            console.error('[tracker] init 失败', e);
            initPromise = null;
            scheduleTrackerRetry();
            return false;
        }
    })();
    return initPromise;
}

export function isTrackerReady() {
    return initialized;
}

// ---- 当前页码（供各事件取 page_num）----
// 埋点 page_num 使用翻页序列的物理页码（物理索引 + 1），插入页同样占一个页码。
function getCurPage() {
    const st = (typeof window !== 'undefined' && window.store);
    const pf = st && st.pageFlip;
    if (!pf || typeof pf.getCurrentPageIndex !== 'function') return 1;
    const idx = pf.getCurrentPageIndex();
    return Number.isInteger(idx) && idx >= 0 ? idx + 1 : 1;
}

// ---- 生命周期 + 页内链接埋点（POC 验证后并入主线）----
// 实现埋点需求.pdf 规定的 6 个事件中的：
//   predefine_pageview  / predefine_page_alive / predefine_page_close / click_link_in_page
// 公共字段（page_id/page_name/content_from/title/url/utm_* 等）由 track() 自动合并 commonConfig。
// 活跃时长：累计"页面可见"的秒数，离开/周期上报。
let _aliveSeconds = 0;
let _lastReportedSeconds = 0;
let _aliveTimer = null;
let _aliveReported = null;
let _lastVisible = true;
let _lifecycleStarted = false;

let _pageviewSent = false;
export function trackPredefinePageview() {
    if (_pageviewSent) return;
    _pageviewSent = true;
    const name = (window.store && window.store.pdfName) || '';
    if (name) {
        const pageNum = getCurPage();
        setCommonTitle(String(pageNum));
        track('predefine_pageview', { title: commonConfig.title, page_num: pageNum });
        return;
    }
    let waited = 0;
    const poll = setInterval(() => {
        const currentName = (window.store && window.store.pdfName) || '';
        waited += 200;
        if (currentName || waited >= 5000) {
            clearInterval(poll);
            const pageNum = getCurPage();
            setCommonTitle(String(pageNum));
            track('predefine_pageview', { title: commonConfig.title, page_num: pageNum });
        }
    }, 200);
}

export function setupLifecycleTracking() {
    if (!initialized) {
        console.warn('[tracker] 未 init，跳过生命周期埋点');
        return;
    }

    if (_lifecycleStarted) return;
    _lifecycleStarted = true;

    // 1) predefine_pageview：白皮书单次曝光，等待 PDF 名称就绪。
    trackPredefinePageview();

    // 2) 活跃时长累计（仅可见时计时，5s 为一个 tick）
    _aliveTimer = setInterval(() => {
        if (_lastVisible) _aliveSeconds += 5;
    }, 5000);

    // 3) predefine_page_alive：每 30s 上报一次本周期可见活跃时长（毫秒）。
    const scheduleAlive = () => {
        _aliveReported = setTimeout(() => {
            if (_lastVisible && _aliveSeconds > _lastReportedSeconds) {
                const duration = (_aliveSeconds - _lastReportedSeconds) * 1000;
                track('predefine_page_alive', { duration });
                _lastReportedSeconds = _aliveSeconds;
            }
            scheduleAlive();
        }, 30000);
    };
    scheduleAlive();

    // 可见性只暂停计时；predefine_page_close 统一在真正卸载时上报。
    document.addEventListener('visibilitychange', () => {
        const hidden = document.visibilityState === 'hidden';
        updatePageStayVisibility();
        _lastVisible = !hidden;
    });

    // 关闭/刷新事件暂停上报：App + H5 场景下 predefine_page_close 不保证可靠到达。
    window.addEventListener('beforeunload', () => {
        // track('predefine_page_close', { page_num: getCurPage() });
        window.collectEvent('config', { page_num: getCurPage() });
    });

    // 页内链接：排除阅读器自身控件，避免把翻页、缩放、抽屉按钮记成链接点击。
    document.addEventListener('click', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('a, button') : null;
        if (!el || !el.closest('.book-container')) return;
        if (el.closest('.page-arrow, .pc-page-arrow, #pcPrevPageBtn, #pcNextPageBtn, .left-rail, .zoom-bar, .mobile-toolbar, .mobile-drawer, .goto-bar')) return;
        const linkUrl = el.getAttribute('href') || el.dataset.url || el.dataset.linkUrl || '';
        let linkText = (el.textContent || '').trim().slice(0, 200);
        if (!linkText && el.dataset.linkUrl) linkText = el.dataset.linkUrl.slice(0, 200);
        const linkType = el.dataset.linkType || (el.closest('.page-insert') ? 'insert-html' : 'other');
        track('click_link_in_page', {
            title: linkText || linkUrl,
            url: linkUrl,
            page_url: (typeof location !== 'undefined' ? location.href : ''),
            link_url: linkUrl,
            link_text: linkText,
            link_type: linkType,
            page_num: getCurPage(),
        });
    }, true);
}

// ---- 上报：直接走稳定通道，带容错 ----
// params 为事件专属属性；公共/上下文字段由 commonConfig 合并进来，确保各通道都带上。
function buildEventParams(eventName, params = {}) {
    // localStorage 中的业务信息属于事件参数；页面上下文字段同时显式进入 params，
    // 避免只藏在 SDK 的 header.custom 中而无法按事件直接核对。
    const pluginParams = getPdfViewPluginParams();
    const physicalPageNum = params.page_num ?? getCurPage();
    const eventContext = {
        page_id: pluginParams.page_id ?? '',
        page_name: pluginParams.page_name ?? '',
        content_from: pluginParams.content_from || commonConfig.content_from || 'flipbook',
        title: buildPhysicalPageTitle(pluginParams, physicalPageNum),
        url: commonConfig.url || window.location.href,
        url_path: commonConfig.url_path || window.location.pathname,
    };
    const eventParams = { ...pluginParams, ...eventContext, ...params };
    // 这三个字段统一由 se_pdf_view_plugin 和当前物理页码生成，调用方参数不能覆盖。
    eventParams.page_id = pluginParams.page_id ?? '';
    eventParams.page_name = pluginParams.page_name ?? '';
    eventParams.title = buildPhysicalPageTitle(pluginParams, physicalPageNum);
    if (eventName !== 'file_download') {
        FILE_DOWNLOAD_FIELDS.forEach((field) => delete eventParams[field]);
    }
    return eventParams;
}

function sendEvent(eventName, params = {}) {
    const eventParams = buildEventParams(eventName, params);
    const payload = { event: eventName, ...commonConfig, ...eventParams };
    const SDF = window.SeDataFinder;
    let ok = false;
    if (SDF && typeof SDF.track === 'function') {
        try {
            SDF.track(eventName, eventParams);
            ok = true;
        } catch (e) {
            console.warn('[tracker] SeDataFinder.track 失败:', eventName, e);
        }
    }
    if (!ok && typeof window.collectEvent === 'function') {
        try {
            window.collectEvent(eventName, eventParams);
            ok = true;
        } catch (e) {
            console.warn('[tracker] collectEvent 失败:', eventName, e);
        }
    }
    if (ok) {
        if (isDebug()) {
            const picked = pickDebugFields(eventName, payload);
            if (eventName === 'predefine_page_close') {
                console.log(`[tracker] ✅ ${eventName}`, picked, JSON.stringify(picked));
            } else {
                console.log(`[tracker] ✅ ${eventName}`, picked);
            }
        } else {
            console.log('[tracker] 上报:', eventName, params);
        }
    }
    return ok;
}

function flushPendingEvents() {
    if (!initialized || pendingEvents.length === 0) return;
    const queued = pendingEvents;
    pendingEvents = [];
    queued.forEach(({ eventName, params }) => {
        if (!sendEvent(eventName, params)) pendingEvents.push({ eventName, params });
    });
}

export function track(eventName, params = {}) {
    if (!initialized) {
        if (pendingEvents.length >= MAX_PENDING_EVENTS) pendingEvents.shift();
        pendingEvents.push({ eventName, params: buildEventParams(eventName, params) });
        if (isDebug()) console.warn('[tracker] 尚未 init，暂存事件:', eventName);
        const currentInit = initPromise || initTracker();
        currentInit.then((ok) => {
            if (!ok) scheduleTrackerRetry();
        });
        return false;
    }
    return sendEvent(eventName, params);
}
