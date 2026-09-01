// core/toc.js —— 平台无关的目录解析与渲染（不依赖 isMobile / 平台特定 DOM）
import { store } from './state.js';

// 转义 HTML 特殊字符，防止目录标题注入
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 解析目录，按优先级回退：
 *   1) 业务团队手工整理的 chapters.json
 *   2) PDF 内嵌 outline（书签）
 *   3) 基于文本内容的启发式推断（仅 PC，由调用方传 isMobile=false 开启）
 * @param {PDFDocumentProxy} pdf
 * @param {boolean} isMobile - 是否移动端（移动端跳过启发式）
 * @param {Array} textData - 预建文本索引（启发式来源需要）
 * @returns {Promise<{items: TOCItem[], source: string}>}
 */
export async function resolveTOC(pdf, isMobile = false, textData = []) {
    // 1) 优先：业务团队手工整理的 chapters.json
    try {
        const url = resolveAppUrl('chapters.json');
        const res = await fetch(url);
        if (res.ok) {
            let raw;
            try {
                raw = await res.json();
            } catch (parseErr) {
                // JSON 语法错误（如字段缺失值）会被这里捕获，明确提示避免静默回退
                console.error('[TOC] ⚠️ chapters.json 不是合法 JSON，已跳过，请检查格式:', parseErr.message);
                throw parseErr;
            }
            const items = validateChapters(raw);
            if (items.length > 0) {
                console.log('[TOC] 📄 来源: chapters.json, 共', items.length, '章节');
                return { items, source: 'json' };
            }
        }
    } catch (e) {
        console.warn('[TOC] chapters.json 读取/解析失败，回退其他来源:', e.message || e);
    }

    // 2) 次选：PDF 内嵌 outline（书签 / bookmarks）
    try {
        const items = await loadPdfOutline(pdf);
        if (items.length > 0) {
            console.log('[TOC] 📕 来源: PDF outline, 共', items.length, '章节');
            return { items, source: 'pdf' };
        }
    } catch (e) {
        console.warn('[TOC] PDF outline 解析失败:', e);
    }

    // 3) 兜底：基于文本内容的启发式推断（仅 PC 端）
    if (!isMobile) {
        const items = generateTOCFromText(textData);
        if (items.length > 0) {
            console.log('[TOC] 🔍 来源: 启发式文本分析, 共', items.length, '章节');
            return { items, source: 'heuristic' };
        }
    } else {
        console.log('[TOC] 移动端跳过启发式（无 chapters.json / outline 时目录为空）');
    }

    // 全无来源
    return { items: [], source: 'empty' };
}

/**
 * 校验 chapters.json 的 schema，过滤掉不合法的项
 * 合法 schema：{ title: 非空字符串, page: >=1 的整数, level?: 1或2, description?: 字符串 }
 */
export function validateChapters(raw) {
    if (!Array.isArray(raw)) return [];
    const valid = [];
    raw.forEach(c => {
        if (!c || typeof c !== 'object') return;
        if (typeof c.title !== 'string' || !c.title.trim()) return;
        if (!Number.isInteger(c.page) || c.page < 1) return;
        valid.push({
            title: c.title.trim(),
            page: c.page,
            level: Number.isInteger(c.level) ? c.level : 1,
            description: typeof c.description === 'string' ? c.description : undefined,
            source: 'json'
        });
    });
    if (valid.length !== raw.length) {
        console.warn(`[TOC] chapters.json 共 ${raw.length} 项，其中 ${raw.length - valid.length} 项校验失败被丢弃`);
    }
    return valid;
}

/**
 * 加载并展开 PDF 内嵌 outline 为扁平的 TOCItem[]
 */
export async function loadPdfOutline(pdf) {
    const outline = await pdf.getOutline();
    if (!outline || outline.length === 0) return [];
    return await flattenPdfOutline(pdf, outline, 1);
}

/**
 * 递归展开 PDF outline 树为扁平的 TOCItem[]
 * depth 表示层级（1=章节，2=小节）
 */
export async function flattenPdfOutline(pdf, items, depth = 1, result = []) {
    for (const item of items) {
        try {
            const page = await resolveDest(pdf, item.dest);
            if (page != null) {
                result.push({
                    title: decodePdfString(item.title),
                    page,
                    level: depth,
                    source: 'pdf'
                });
            }
        } catch (e) {
            console.warn('[TOC] outline 项跳过:', item.title, e);
        }
        if (item.items && item.items.length > 0) {
            await flattenPdfOutline(pdf, item.items, depth + 1, result);
        }
    }
    return result;
}

/**
 * 解析 PDF outline item 的 dest 字段（处理两种 PDF dest 格式）
 *   格式 1（新式）：[pageRef, /XYZ, x, y, zoom]
 *   格式 2（旧式）：字符串命名目标（需要二次解析）
 * 返回 1-based 页码，失败返回 null
 */
export async function resolveDest(pdf, dest) {
    // 格式 1：数组 dest（PDF 2.0+ 主流写法）
    if (Array.isArray(dest)) {
        const pageIndex = await pdf.getPageIndex(dest[0]);
        return pageIndex + 1;
    }
    // 格式 2：命名目标字符串（PDF 1.x 旧式）
    if (typeof dest === 'string') {
        try {
            const explicitDest = await pdf.getDestination(dest);
            if (Array.isArray(explicitDest) && explicitDest.length > 0) {
                const pageIndex = await pdf.getPageIndex(explicitDest[0]);
                return pageIndex + 1;
            }
        } catch (e) {
            console.warn('[TOC] named dest 解析失败:', dest);
        }
    }
    return null;
}

/**
 * 解码 PDF 内嵌字符串，处理中文老 PDF 常见的乱码
 * PDF.js 通常自动尝试解码，但中文老 PDF 偶尔仍返回 Latin-1 字符。
 * 这里用 GB18030 (兼容 GBK) 做兜底解码。
 */
export function decodePdfString(str) {
    if (!str) return '';
    if (typeof str !== 'string') str = String(str);
    // 已经是有效 UTF-8（含中文字符），直接返回
    if (/[\u4e00-\u9fff]/.test(str)) return str;
    try {
        // 把字符串每个 char 转换为字节，用 GB18030 解码
        const bytes = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
        const decoded = new TextDecoder('gb18030', { fatal: false }).decode(bytes);
        const chineseInDecoded = (decoded.match(/[\u4e00-\u9fff]/g) || []).length;
        // 解码结果含合理量中文字符 → 认定为 GBK
        if (chineseInDecoded >= 2 && chineseInDecoded < decoded.length * 0.5) {
            return decoded;
        }
    } catch (e) {
        // 忽略解码异常
    }
    return str;  // 解码失败回退到原字符串
}

/**
 * 启发式 TOC：基于文本内容特征推断章节（兜底来源）
 * 返回 TOCItem[]，不直接渲染 DOM
 */
export function generateTOCFromText(textData) {
    const tocItems = [];
    textData.forEach((item, index) => {
        const text = item.text.trim();
        const heuristic = detectTitle(text, index);
        if (heuristic) {
            tocItems.push({
                title: extractTitle(text),
                page: item.page,
                level: heuristic.level || 1,
                source: 'heuristic'
            });
        }
    });
    // 启发式完全没结果时，用每页一个条目的兜底
    if (tocItems.length === 0) {
        textData.forEach(item => {
            tocItems.push({
                title: `第 ${item.page} 页`,
                page: item.page,
                level: 1,
                source: 'heuristic'
            });
        });
    }
    return tocItems;
}

export function detectTitle(text, pageIndex) {
    if (!text || text.length > 80) return false;
    if (pageIndex === 0) return { level: 1 };
    const titleKeywords = ['目录', 'contents', 'chapter', '章', '节', 'section', '介绍', '简介', '概述', '总结', '结论', '附录'];
    const lowerText = text.toLowerCase();
    for (const keyword of titleKeywords) {
        if (lowerText.includes(keyword.toLowerCase())) {
            return { level: 1 };
        }
    }
    if (/^(\d+[\.\、]|第[一二三四五六七八九十\d]+章|Chapter\s+\d+)/i.test(text)) {
        return { level: 1 };
    }
    if (text.length < 30 && !/[，。！？；,.!?;]$/.test(text)) {
        return { level: 2 };
    }
    return false;
}

export function extractTitle(text) {
    let title = text.trim().substring(0, 50);
    if (text.length > 50) title += '...';
    return title || '无标题';
}

/**
 * 渲染目录到 DOM（接受任一来源的数据，统一展示）
 * @param {Object} tocResult - resolveTOC 的返回
 */
export function renderTOC(tocResult) {
    const { items } = tocResult;
    const tocList = document.getElementById('tocList');
    tocList.innerHTML = '';

    if (items.length === 0) {
        tocList.innerHTML = '<p class="empty-state">暂无目录</p>';
        return;
    }

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'toc-item';
        // 二级小节缩进
        div.style.paddingLeft = `${0.6 + (item.level - 1) * 0.8}rem`;
        div.innerHTML = `
            <div class="toc-title">${escapeHtml(item.title)}</div>
            <div class="toc-page">第 ${item.page} 页</div>
        `;
        div.addEventListener('click', () => {
            // 统一走 flipToIndex（内部按 data-page-num 换算物理索引），
            // 正确处理「显示插入页时物理索引 ≠ 真实页号-1」的偏移，保证目录跳转精准。
            const app = window.__app;
            if (app && typeof app.flipToIndex === 'function') {
                app.flipToIndex(item.page - 1, 'toc');
            } else if (store.pageFlip) {
                store.pageFlip.flip(item.page - 1);
            }
        });
        tocList.appendChild(div);
    });
}

export function updateActiveTOC(currentPage) {
    const tocItems = document.querySelectorAll('.toc-item');
    let activeIndex = -1;
    tocItems.forEach((item, index) => {
        const pageNum = parseInt(item.querySelector('.toc-page').textContent.match(/\d+/)[0]);
        item.classList.remove('active');
        if (pageNum <= currentPage) {
            activeIndex = index;
        }
    });
    if (activeIndex >= 0) {
        tocItems[activeIndex].classList.add('active');
        tocItems[activeIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}
import { resolveAppUrl } from './app-url.js';
