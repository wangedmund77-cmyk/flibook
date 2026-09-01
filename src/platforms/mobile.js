// 平台模块：移动端专属逻辑。
// 只承接「仅手机相关」的差异点：顶部 3 图标 toolbar、移动抽屉（目录/搜索）、
// 首次翻页提示条、单页强制布局。两端共用逻辑（搜索跳页、翻页、目录渲染）不在此重复。
//
// 兼容性：搜索逻辑（main.js 的 performSearch）通过 window.__mobile* 钩子驱动移动抽屉，
// 本模块继续挂载这些钩子，避免跨模块大改。后续可把搜索也下沉后再移除这些全局钩子。

import { store } from '../core/state.js';
import { isMobile } from '../platform-detect.js';
import { performSearchRef } from '../app.js'; // 延迟引用：由 app.js 注入 performSearch
import { doShare, downloadPdf } from '../app.js'; // 分享、下载逻辑两端共用

// 目录当前是否已被移入移动抽屉（跨函数共享状态）
let tocMountedInDrawer = false;
let thumbsMountedInDrawer = false;

// 首次翻页提示条「是否已隐藏」标记（跨函数共享）
let flipHintHidden = false;
const FLIP_HINT_SEEN_KEY = 'flipSwipeGifSeenV1';
const FLIP_HINT_PLAY_MS = 6000;
let mobileUiInitialized = false;

export function setupMobileUI() {
    if (mobileUiInitialized) return;
    mobileUiInitialized = true;
    const mql = window.matchMedia('(max-width: 768px) and (pointer: coarse)');
    const drawer = document.getElementById('mobileDrawer');
    const backdrop = document.getElementById('mobileBackdrop');
    const drawerBody = document.getElementById('drawerBody');
    const drawerToc = document.getElementById('drawerToc');
    const drawerThumb = document.getElementById('drawerThumb');
    const drawerSearch = document.getElementById('drawerSearch');
    const drawerTitle = document.getElementById('drawerTitle');
    const tocList = document.getElementById('tocList');
    const thumbnailList = document.getElementById('thumbnailList');
    // PC 端 tocList 的归属容器（回到 PC 布局时挂回此处）
    const pcTocHost = document.getElementById('pcViewToc');
    const pcThumbHost = document.getElementById('pcViewThumb');

    // 切换抽屉内的视图：'toc' 显示目录，'search' 显示搜索结果，互斥
    function showDrawerView(view) {
        drawerToc.style.display = view === 'toc' ? 'block' : 'none';
        drawerThumb.style.display = view === 'thumb' ? 'block' : 'none';
        drawerSearch.style.display = view === 'search' ? 'block' : 'none';
        drawer.classList.toggle('search-results-open', view === 'search');
        drawer.classList.toggle('toc-open', view === 'toc');
        drawer.classList.toggle('thumb-open', view === 'thumb');
        // 搜索结果视图：抽屉顶部不显示关闭叉子（用户用返回/点背景关闭）
        const header = document.querySelector('.mobile-drawer-header');
        if (header) header.classList.toggle('no-close', view === 'search');
    }

    // 打开抽屉：把目录节点挂入 drawerToc（若当前是目录模式）
    function openMobileDrawer(title, view) {
        if (view) showDrawerView(view);
        drawerTitle.textContent = title;
        drawer.classList.add('open');
        backdrop.classList.add('open');
    }
    function closeMobileDrawer() {
        drawer.classList.remove('open');
        backdrop.classList.remove('open');
        // 抽屉关闭后，把目录节点移回 PC 抽屉视图（避免丢失数据与绑定）
        if (tocMountedInDrawer) {
            pcTocHost.appendChild(tocList);
            tocMountedInDrawer = false;
        }
        if (thumbsMountedInDrawer) {
            pcThumbHost.appendChild(thumbnailList);
            thumbsMountedInDrawer = false;
        }
    }
    // 把目录节点移入抽屉目录视图（仅一次）
    function mountTocIntoDrawer() {
        if (!tocMountedInDrawer) {
            drawerToc.appendChild(tocList);
            tocMountedInDrawer = true;
        }
    }
    function mountThumbsIntoDrawer() {
        if (!thumbsMountedInDrawer) {
            drawerThumb.appendChild(thumbnailList);
            thumbsMountedInDrawer = true;
        }
    }

    // 暴露给搜索逻辑使用
    window.__mobileOpenDrawer = openMobileDrawer;
    window.__mobileCloseDrawer = closeMobileDrawer;
    window.__mobileMountToc = mountTocIntoDrawer;
    window.__mobileMountThumbs = mountThumbsIntoDrawer;
    window.__mobileShowSearchView = () => showDrawerView('search');
    window.__isMobile = () => mql.matches;

    // home 按钮
    const homeBtn = document.getElementById('mobileHomeBtn');
    if (homeBtn) homeBtn.addEventListener('click', () => {
        const app = window.__app;
        if (app && typeof app.flipToIndex === 'function') app.flipToIndex(0, 'goto');
        else if (store.pageFlip) store.pageFlip.flip(0);
    });

    // 目录按钮
    const tocBtn = document.getElementById('mobileTocBtn');
    if (tocBtn) tocBtn.addEventListener('click', () => {
        mountTocIntoDrawer();
        openMobileDrawer('目录', 'toc');
    });
    // 目录项自身先执行跳页，事件冒泡到目录容器后再关闭抽屉。
    // 仅监听移动抽屉容器，因此 PC 目录点击后仍保持展开。
    if (drawerToc) drawerToc.addEventListener('click', (event) => {
        if (event.target instanceof Element && event.target.closest('.toc-item')) {
            closeMobileDrawer();
        }
    });

    const downloadBtn = document.getElementById('mobileDownloadBtn');
    if (downloadBtn) downloadBtn.addEventListener('click', downloadPdf);

    const thumbBtn = document.getElementById('mobileThumbBtn');
    if (thumbBtn) thumbBtn.addEventListener('click', () => {
        mountThumbsIntoDrawer();
        openMobileDrawer('页面预览', 'thumb');
    });
    if (drawerThumb) drawerThumb.addEventListener('click', (event) => {
        if (event.target instanceof Element && event.target.closest('.thumbnail-item')) {
            closeMobileDrawer();
        }
    });

    // 关闭按钮 + backdrop
    document.getElementById('closeMobileDrawer').addEventListener('click', closeMobileDrawer);
    backdrop.addEventListener('click', closeMobileDrawer);

    // 搜索图标（移动端顶部栏）：点击从顶部滑下搜索输入框，
    // 用户按回车或点击右侧按钮触发搜索；搜索结果仍用右侧抽屉展示。
    const mobileSearchInput = document.getElementById('mobileSearchInput');
    const mobileSearchBar = document.getElementById('mobileSearchBar');
    const mobileSearchBarClose = document.getElementById('mobileSearchBarClose');
    const mobileSearchBtn = document.getElementById('mobileSearchBtn');
    const mobileSearchSubmit = document.getElementById('mobileSearchSubmit');

    function openMobileSearchBar() {
        if (mobileSearchBar) mobileSearchBar.classList.add('show');
        // 每次打开清空上一次结果，保持干净
        const oldResults = document.getElementById('mobileSearchResults');
        if (oldResults) oldResults.innerHTML = '';
        if (mobileSearchInput) setTimeout(() => mobileSearchInput.focus(), 50);
    }
    function closeMobileSearchBar() {
        if (mobileSearchBar) mobileSearchBar.classList.remove('show');
    }
    function submitMobileSearch() {
        closeMobileSearchBar();
        if (mobileSearchInput) mobileSearchInput.blur();
        performSearchRef()();
    }

    if (mobileSearchBtn) mobileSearchBtn.addEventListener('click', openMobileSearchBar);
    if (mobileSearchBarClose) mobileSearchBarClose.addEventListener('click', () => {
        closeMobileSearchBar();
        closeMobileDrawer();
    });
    if (mobileSearchSubmit) {
        // 保持输入框焦点到 click 触发，避免 blur 先隐藏整个搜索条、吞掉这次点击。
        mobileSearchSubmit.addEventListener('pointerdown', (e) => e.preventDefault());
        mobileSearchSubmit.addEventListener('click', submitMobileSearch);
    }
    if (mobileSearchInput) {
        // 点到搜索框之外、键盘“完成”导致输入框失去焦点时，立即收起顶部搜索框。
        // 这里只隐藏输入框，不关闭右侧搜索结果抽屉。
        mobileSearchInput.addEventListener('blur', closeMobileSearchBar);
        // 回车触发搜索
        mobileSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitMobileSearch();
            }
        });
    }

    // 手机端分享按钮：功能与 PC 端一致（复制当前页链接到剪贴板 + toast 提示）
    const mobileShareBtn = document.getElementById('mobileShareBtn');
    if (mobileShareBtn) mobileShareBtn.addEventListener('click', doShare);

    // 首次翻页提示（方案 C）：常驻翻书区顶部，首次翻页后淡出隐藏
    setupFlipHint();

    // 移动端 UI 切换：仅【触屏 + 窄屏】走手机 toolbar/抽屉布局；
    // PC（鼠标指针）即使窗口很窄也保持 PC 侧栏 + 滚动锁定，不进移动布局。
    function applyMobileLayout(isMobileNow) {
        const container = document.querySelector('.book-container');
        // PC 极窄屏（滚动锁定）强制按 PC 布局处理，避免误入移动 UI
        const scrollLocked = container ? container.classList.contains('scroll-locked') : false;
        const realMobile = isMobileNow && !scrollLocked;
        if (realMobile) {
            // 移动端必单页：single-page-mode 已由 resize 监听统一控制，这里确保加上
            container.classList.add('single-page-mode');
        } else {
            // 回到 PC：若目录曾被移入抽屉，移回
            if (tocMountedInDrawer) {
                pcTocHost.appendChild(tocList);
                tocMountedInDrawer = false;
            }
            if (thumbsMountedInDrawer) {
                pcThumbHost.appendChild(thumbnailList);
                thumbsMountedInDrawer = false;
            }
        }
        // 触发 page-flip 重算 orientation（移动端断点附近必须）
        if (store.pageFlip && store.pageFlip.update) {
            try { store.pageFlip.update(); } catch (e) { /* ignore */ }
        }
    }
    applyMobileLayout(mql.matches);
    mql.addEventListener('change', (e) => applyMobileLayout(e.matches));
}

// ========== 手机端首次进入翻页 GIF 提示 ==========
// index.html 会在首屏 DOM 创建时立即判断并显示，避免等待 PDF.js 初始化。
// 本模块负责自动收起，并在用户提前翻页时立即结束提示。
export function hideFlipHint() {
    if (flipHintHidden) return;
    const bar = document.getElementById('flipHintBar');
    if (!bar) return;
    flipHintHidden = true;
    if (window.__flipSwipeHintTimer) {
        clearTimeout(window.__flipSwipeHintTimer);
        window.__flipSwipeHintTimer = null;
    }
    if (window.__flipSwipeHintDismissHandler) {
        document.removeEventListener('pointerdown', window.__flipSwipeHintDismissHandler, true);
        document.removeEventListener('touchstart', window.__flipSwipeHintDismissHandler, true);
        document.removeEventListener('mousedown', window.__flipSwipeHintDismissHandler, true);
        document.removeEventListener('click', window.__flipSwipeHintDismissHandler, true);
        window.__flipSwipeHintDismissHandler = null;
    }
    bar.classList.add('hidden');
    bar.setAttribute('aria-hidden', 'true');
    try { localStorage.setItem(FLIP_HINT_SEEN_KEY, '1'); } catch (e) { /* 隐私模式忽略 */ }
}

function setupFlipHint() {
    const bar = document.getElementById('flipHintBar');
    if (!bar) return;

    if (!isMobile()) {
        bar.classList.add('hidden');
        bar.setAttribute('aria-hidden', 'true');
        flipHintHidden = true;
        return;
    }

    // 分享深链优先展示目标页，不让首次 GIF 覆盖目标页加载过程。
    const sharedPage = Number.parseInt(new URLSearchParams(window.location.search).get('page'), 10);
    if (Number.isInteger(sharedPage) && sharedPage >= 1) {
        hideFlipHint();
        return;
    }

    // 首屏内联逻辑已经展示过时，只补齐剩余播放时间；不要因初始化较晚重新播放。
    if (window.__flipSwipeHintShownAt) {
        flipHintHidden = bar.classList.contains('hidden');
        if (flipHintHidden) return;
        const remaining = Math.max(0, FLIP_HINT_PLAY_MS - (Date.now() - window.__flipSwipeHintShownAt));
        if (window.__flipSwipeHintTimer) clearTimeout(window.__flipSwipeHintTimer);
        window.__flipSwipeHintTimer = setTimeout(hideFlipHint, remaining);
        return;
    }

    // 内联脚本未执行时的兜底；同一浏览器中只展示一次。
    let seen = false;
    try { seen = localStorage.getItem(FLIP_HINT_SEEN_KEY) === '1'; } catch (e) { /* 隐私模式默认显示 */ }
    if (seen) {
        bar.classList.add('hidden');
        bar.setAttribute('aria-hidden', 'true');
        flipHintHidden = true;
        return;
    }

    const gif = bar.querySelector('.flip-hint-gif');
    if (gif && !gif.getAttribute('src')) gif.src = gif.dataset.src;
    bar.classList.remove('hidden');
    bar.setAttribute('aria-hidden', 'false');
    flipHintHidden = false;
    window.__flipSwipeHintShownAt = Date.now();
    try { localStorage.setItem(FLIP_HINT_SEEN_KEY, '1'); } catch (e) { /* 隐私模式忽略 */ }
    window.__flipSwipeHintDismissHandler = hideFlipHint;
    document.addEventListener('pointerdown', hideFlipHint, { capture: true, passive: true });
    document.addEventListener('touchstart', hideFlipHint, { capture: true, passive: true });
    document.addEventListener('mousedown', hideFlipHint, { capture: true, passive: true });
    document.addEventListener('click', hideFlipHint, { capture: true, passive: true });
    window.__flipSwipeHintTimer = setTimeout(hideFlipHint, FLIP_HINT_PLAY_MS);
}
