// 集中式应用状态（步骤2：抽 state.js）。
// 把原 main.js 顶部的模块级可变全局变量统一收归到单一 store，
// 消除“散落全局状态”耦合，并为后续 core / platforms 模块共享状态提供唯一入口。
//
// 设计：
// - store：纯对象，持有所有共享状态字段。
// - getState()：返回 store 快照（只读引用，勿直接改字段，请用 setState）。
// - setState(patch)：浅合并 patch 到 store，并通知订阅者。
// - subscribe(fn)：注册变更监听，返回取消函数。fn 收到 (next, prev)。
//
// 注意：textData 因在 main.js 中作为函数参数名局部遮蔽，本次暂不搬入 store，仍保留原全局声明。

const store = {
    pageFlip: undefined,            // PageFlip 实例
    pageCanvases: [],               // 每页 canvas，用于缩略图
    pdfBaseWidth: 0,                // PDF 单页基准宽（init 赋值，resize 复用）
    pdfBaseHeight: 0,               // PDF 单页基准高
    currentZoom: 1.0,               // 当前缩放
    currentPageIndex: 0,            // 当前页索引（0-based），重建后恢复页码
    currentModeIsFixed: false,      // page-flip 是否以 size:'fixed'（手机单页）运行
    currentSearchKeyword: '',       // 当前搜索关键词
    textIndex: [],                  // 预建文本索引（步骤3-2 迁入 store，替代原 main.js 的 textData 全局）
    basePageWidth: 0,               // page-flip 基准单页宽（init 后赋值）
    basePageHeight: 0,              // page-flip 基准单页高
    pdfName: '',                    // 当前加载的 PDF 文件名（分享链接用，两端共用）
    pdfFileSize: null,              // 当前 PDF 文件大小（字节；由 Range/HEAD 响应取得）

    /** 首页/尾页单页居中（仅首/尾页居中，中间双页并排）。
     *  渐进渲染阶段绝不重建实例；仅当后台全部页渲染完成后，
     *  首次翻到首/尾页才重建为单页 orientation。 */
    coverCentered: true,
    /** 后台渐进渲染是否全部结束（canvas 已全部填入占位）。
     *  未结束前任何跳转都走 flip()，绝不重建，以保护渐进渲染。 */
    renderComplete: false,
    /** 当前渐进渲染代次。翻页器重建会递增，旧代次检测到后立即停止，避免重复渲染。 */
    renderGeneration: 0,
    /** 最新一次 refillPages Promise，供首次加载在发生重建时等待真正的活动任务完成。 */
    activeRenderPromise: null,
    /** 前三页 Canvas 完成通知；重建替换首次渲染时继续复用。 */
    onInitialBatchFilled: null,
    /** 当前翻页器 orientation：'double'（PC stretch 双页）或 'single'（单页居中）。 */
    currentOrientation: 'double',
    /** 重建锁，防止重建期间重复触发跨模式重建。 */
    isRebuilding: false,
    /** 重建完成后的一次性标志：重建时为定位目标页会触发 flip 事件，
     *  该次（及动画残余的）flip 不应再触发 orientation 切换判定，否则单页模式
     *  flip(57) 的动画序列会被误判为"离开尾页"而回退双页。 */
    justRebuilt: false,

    // ===== 插入 HTML 单页（主线集成） =====
    /** 插入功能是否可用（配置已加载 + 当前 PDF 与配置匹配）。false 时图标禁用。 */
    insertEnabled: false,
    /** 是否显示插入页。true = 加载即显示插入 HTML 后的 PDF（默认）；false = 纯 PDF 翻页器。
     *  初始 false，由 app.js 在插入配置匹配成功时置 true（无需用户点击图标）。 */
    insertVisible: false,
    /** 配置解析后的插入项数组：{afterPage, htmlUrl, title}。 */
    insertedPages: [],
    /** 当前翻页器实际 .page 总数（= PDF 页数 + 插入页数 + 可能的补位），
     *  与 PDF 语义页数 totalPages 区分。边界判断 / 滑块 max 用它。 */
    renderedPageCount: 0,
};

const listeners = new Set();

export function getState() {
    return store;
}

export function setState(patch) {
    const prev = { ...store };
    Object.assign(store, patch);
    for (const fn of listeners) {
        try { fn(store, prev); } catch (e) { /* 单个订阅者异常不影响其他 */ }
    }
}

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// 便捷访问：store.xxx 直接读写（与 getState().xxx 等价，赋值时建议用 setState 以触发通知）。
export { store };

// 供非模块埋点链路读取共享状态；引用与模块内 store 保持一致。
if (typeof window !== 'undefined') {
    window.store = store;
}
