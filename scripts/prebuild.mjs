// 预抽取 PDF 每页文本坐标 + 纯文本为 public/text-index.json。
//
// 背景：手机浏览器上 PDF.js 的 ReadableStream / async iterator 实现损坏，
// 导致浏览器端 getTextContent() 崩溃，进而：
//   1) 全文搜索高亮（highlightSearchOnPage）若依赖运行时 getTextContent 会崩溃；
//   2) 启发式目录（generateTOCFromText）无文本可分析 -> 目录为空。
// 本脚本在 Node 中预抽取（Node 的 ReadableStream 是标准的，无此问题），
// 产出静态 JSON，浏览器（含手机）直接 fetch 使用，彻底绕开坏掉的文本流。
//
// 统一架构核心：索引携带【预计算文本坐标 items】，坐标用固定 scale = 1.5 计算，
// 与前端渲染/高亮的 getViewport({scale:1.5}) 完全一致，因此高亮框映射不错位，
// 且高亮彻底脱离运行时 getTextContent（手机端不再崩溃，高亮真正可用）。
// images 字段预留给后续"图片区域选中"升级，本期留空数组。
//
// 用法：node scripts/prebuild.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const PDF_PATH = resolve(root, 'public/sample.pdf');
const OUT_PATH = resolve(root, 'public/text-index.json');

const STANDARD_FONTS = resolve(root, 'node_modules/pdfjs-dist/standard_fonts');
const CMAPS = resolve(root, 'node_modules/pdfjs-dist/cmaps');

async function main() {
    const data = new Uint8Array(await readFile(PDF_PATH));
    const pdf = await pdfjs.getDocument({
        data,
        standardFontDataUrl: STANDARD_FONTS + '/',
        cMapUrl: CMAPS + '/',
        cMapPacked: true
    }).promise;

    const total = pdf.numPages;
    const index = [];
    // 统一坐标 scale：与前端渲染/高亮的 getViewport({scale:1.5}) 一致，
    // 预建坐标即按此 scale 计算，保证高亮框映射不错位。
    const COORD_SCALE = 1.5;
    for (let i = 1; i <= total; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        const text = tc.items.map((it) => it.str).join(' ');

        // 预计算文本项坐标（viewport 像素，scale = COORD_SCALE）。
        // 每项：{ str, x, y, w, h }
        //   x/y 为文本项左上角（已转成"自顶部向下"坐标系，便于前端直接定位）；
        //   w/h 为包围盒宽高（像素）。
        // 同时保留纯文本 text 供搜索/目录启发式使用。
        const viewport = page.getViewport({ scale: COORD_SCALE });
        const items = tc.items
            .filter((it) => it.str && typeof it.str === 'string')
            .map((it) => {
                const transform = it.transform; // [a, b, c, d, e, f]
                const xPt = transform[4];       // 左下角原点 → 向右偏移（pt）
                const yBasePt = transform[5];   // 基线 Y（pt）
                const fontHeightPt = Math.abs(transform[3] || 12);
                const wPt = it.width || (it.str.length * fontHeightPt * 0.6);
                // 转换到 scale 像素
                const x = xPt * COORD_SCALE;
                const fontHeightPx = fontHeightPt * COORD_SCALE;
                const wPx = wPt * COORD_SCALE;
                // 自顶部向下的 Y：viewport 高(像素) - (基线Y + 字号)(先转像素)
                // 注意 viewport.height 已是 scale 像素，故 (yBasePt+fontHeightPt) 需先乘 COORD_SCALE
                const y = viewport.height - (yBasePt + fontHeightPt) * COORD_SCALE;
                return { str: it.str, x, y, w: wPx, h: fontHeightPx };
            });
        const images = []; // 预留：后续"图片区域选中"升级时填充

        index.push({ page: i, text, items, images });
        console.log(`[prebuild] 第 ${i}/${total} 页已抽取 (文本 ${text.length} 字, 坐标项 ${items.length})`);
    }

    await mkdir(dirname(OUT_PATH), { recursive: true });
    await writeFile(OUT_PATH, JSON.stringify(index), 'utf8');
    console.log(`[prebuild] 已写出 ${index.length} 页文本索引 -> ${OUT_PATH}`);
}

main().catch((e) => {
    console.error('[prebuild] 失败:', e);
    process.exit(1);
});
