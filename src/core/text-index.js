// 文本索引模块（步骤3-2：抽 text-index.js）。
// 平台无关：负责预建文本索引的加载、搜索过滤、搜索高亮渲染。
// 不出现任何 isMobile 判定；DOM 渲染与 store 状态读写构成唯一消费入口。
//
// 数据来源：scripts/prebuild.mjs 产出的 public/text-index.json，
// 形如 [{ page, text, items: [{ str, x, y, h, width }] }, ...]，坐标按 scale=1.5 预计算。

import { store } from './state.js';

/**
 * 加载后台预建文本索引 public/text-index.json（scripts/prebuild.mjs 产出）。
 * 返回 [{ page, text, items }, ...] 或 null（文件不存在/读取失败）。
 * 该索引在 Node 中生成，绕开手机浏览器损坏的 ReadableStream，使搜索/目录跨端一致。
 * 统一架构：索引缺失即"搜索不可用"，绝不回退浏览器端 getTextContent()（手机端会崩溃）。
 */
export async function loadPrebuiltTextIndex() {
    try {
        const url = resolveAppUrl('text-index.json');
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        return data;
    } catch (e) {
        // 索引缺失即"搜索不可用"，绝不回退浏览器端 getTextContent()（手机端会崩溃）。
        // 调用方据此向用户提示，不阻塞翻页/工具栏。
        console.warn('[text-index] 预建索引加载失败，搜索将不可用:', e);
        return null;
    }
}

/**
 * 把预建索引写入 store.textIndex（统一数据源）。
 * 仅当该页有 text 字段才纳入，供搜索与高亮消费。
 */
export function setTextIndex(prebuiltText) {
    const arr = [];
    if (Array.isArray(prebuiltText)) {
        for (let i = 0; i < prebuiltText.length; i++) {
            const entry = prebuiltText[i];
            if (entry && entry.text) {
                arr.push({
                    page: i + 1,
                    text: entry.text,
                    items: Array.isArray(entry.items) ? entry.items : []
                });
            }
        }
    }
    store.textIndex = arr;
    return arr;
}

/**
 * 纯函数：按关键字过滤索引，返回匹配项列表。
 * 索引为空（加载失败/缺失）时返回 null，调用方据此提示"搜索不可用"。
 */
export function searchIndex(keyword) {
    const textData = store.textIndex || [];
    if (textData.length === 0) return null; // 索引缺失 → 搜索不可用
    const lowerKeyword = keyword.toLowerCase();
    return textData.filter(item => item.text.toLowerCase().includes(lowerKeyword));
}

/**
 * 在指定页面上跳转并高亮搜索词。
 * 高亮框坐标直接读取预建索引的 items（scale=1.5 像素，自顶部向下），
 * 彻底脱离运行时 getTextContent()，PC 与手机行为一致。
 */
export async function highlightSearchOnPage(pageNum, keyword) {
    if (!keyword) return;
    const textData = store.textIndex;
    if (!textData) return; // 索引缺失：安静跳过，不回退运行时提取

    const pageDiv = document.querySelector(`.page[data-page-num="${pageNum}"]`);
    if (!pageDiv) return;

    // 移除旧的高亮层
    const oldHighlight = pageDiv.querySelector('.search-highlight-overlay');
    if (oldHighlight) oldHighlight.remove();

    const pageEntry = textData.find((e) => e.page === pageNum);
    if (!pageEntry || !Array.isArray(pageEntry.items) || pageEntry.items.length === 0) return;

    const canvas = pageDiv.querySelector('canvas');
    if (!canvas) return;
    // HiDPI Canvas 的 width/height 是放大后的后备像素；预建索引仍基于 scale=1.5
    // 的逻辑 viewport，因此优先读取渲染时保存的逻辑尺寸，避免搜索高亮缩小/错位。
    const canvasWidth = Number(canvas.dataset.viewportWidth) || canvas.width;
    const canvasHeight = Number(canvas.dataset.viewportHeight) || canvas.height;

    // 覆盖层定位在 pageDiv 的 layout 坐标系（clientWidth 等不受 zoom 影响），
    // 由 pageDiv 的 zoom 同步缩放到屏幕，避免双重缩放。
    const layoutW = canvas.clientWidth;
    const layoutH = canvas.clientHeight;

    const highlightOverlay = document.createElement('div');
    highlightOverlay.className = 'search-highlight-overlay';
    highlightOverlay.style.left = '0px';
    highlightOverlay.style.top = '0px';
    highlightOverlay.style.width = layoutW + 'px';
    highlightOverlay.style.height = layoutH + 'px';

    // 预建坐标（scale=1.5 像素）→ pageDiv layout 坐标的换算比例
    const sX = layoutW / canvasWidth;
    const sY = layoutH / canvasHeight;

    let hasMatch = false;
    const lowerKeyword = keyword.toLowerCase();

    for (const item of pageEntry.items) {
        const itemText = (item.str || '').toLowerCase();
        if (!itemText.includes(lowerKeyword)) continue;
        hasMatch = true;

        const matchIndex = itemText.indexOf(lowerKeyword);
        const measureCanvas = document.createElement('canvas');
        const measureCtx = measureCanvas.getContext('2d');
        const fontSizeInPixels = item.h; // 预存的字高（scale=1.5 像素）
        measureCtx.font = `${fontSizeInPixels}px sans-serif`;

        const textBefore = item.str.substring(0, matchIndex);
        const offsetBefore = measureCtx.measureText(textBefore).width;
        const keywordWidth = measureCtx.measureText(keyword).width;

        const actualX = (item.x + offsetBefore) * sX;
        const actualY = item.y * sY;
        const actualW = keywordWidth * sX;
        const actualH = item.h * sY;

        const clampedLeft = Math.max(0, Math.min(layoutW - 4, actualX));
        const clampedTop = Math.max(0, Math.min(layoutH - 4, actualY));
        const clampedWidth = Math.max(4, Math.min(layoutW - clampedLeft, actualW));
        const clampedHeight = Math.max(4, Math.min(layoutH - clampedTop, actualH));

        const highlightBox = document.createElement('div');
        highlightBox.className = 'search-highlight-box';
        highlightBox.style.cssText = `
            position: absolute;
            left: ${clampedLeft}px;
            top: ${clampedTop}px;
            width: ${clampedWidth}px;
            height: ${clampedHeight}px;
        `;
        highlightOverlay.appendChild(highlightBox);
    }

    if (hasMatch) {
        pageDiv.style.position = 'relative';
        pageDiv.appendChild(highlightOverlay);
    }
}

/**
 * 高亮当前可见的页面（翻页时调用）。
 */
export function highlightSearchOnVisiblePages(currentPage) {
    if (!store.currentSearchKeyword) return;
    const textData = store.textIndex || [];
    const pagesToHighlight = [currentPage - 1, currentPage, currentPage + 1]
        .filter(p => p >= 1 && p <= textData.length);
    pagesToHighlight.forEach(pageNum => {
        highlightSearchOnPage(pageNum, store.currentSearchKeyword);
    });
}

/**
 * 清除所有搜索高亮。
 */
export function clearAllSearchHighlights() {
    document.querySelectorAll('.search-highlight-overlay').forEach(el => el.remove());
}
import { resolveAppUrl } from './app-url.js';
