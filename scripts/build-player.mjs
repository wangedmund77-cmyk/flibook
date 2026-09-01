import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'data', '化解之道_Flipbook_v17_四支案例真实关键帧Thumbnail_修正版.html'), 'utf8');

const siteMatch = html.match(/CC_SITE_ID\s*=\s*"([^"]+)"/);
const CC_SITE_ID = siteMatch ? siteMatch[1] : '5888B34E7994FD49';
// 直接拼接正确的 URL，避免原文件模板字符串字面量被原样写入
const CC_PLAYER_SCRIPT_URL = 'https://p.bokecc.com/player?siteid=' + CC_SITE_ID + '&newversion=true';

const playerJs = `/* CC 云视频播放引擎（对齐原大 HTML 的激活钩子版本）
 * 关键点：必须定义 window.onCCH5PlayerLoaded，CC SDK 加载后才会把 createCCH5Player 挂到 window。
 */
(function () {
  const CC_SITE_ID = "${CC_SITE_ID}";
  const CC_PLAYER_SCRIPT_URL = ${JSON.stringify(CC_PLAYER_SCRIPT_URL)};

  function clampCCRatio(r) { r = Number(r); if (isNaN(r)) return 0; return Math.max(0, Math.min(1, r)); }

  // ---- 最小 record 体系（替代原文件 CC_ACTIVE_PLAYERS）----
  const records = new Map();
  function getCCRecord(vid) { return records.get(String(vid)) || null; }
  function getCCMeta(vid) { return { vid: String(vid) }; }

  // ---- SDK 加载：靠 onCCH5PlayerLoaded 激活（与原文件一致）----
  let ccPlayerLibraryPromise = null;
  let ccLibraryResolver = null, ccLibraryRejecter = null, ccLibraryTimeout = null;
  function settleCCLibrary(success, error) {
    if (ccLibraryTimeout) { clearTimeout(ccLibraryTimeout); ccLibraryTimeout = null; }
    if (success && ccLibraryResolver) ccLibraryResolver();
    if (!success && ccLibraryRejecter) ccLibraryRejecter(error || new Error('CC 视频播放器加载失败'));
    ccLibraryResolver = null; ccLibraryRejecter = null;
  }
  window.onCCH5PlayerLoaded = function () {
    document.documentElement.dataset.ccPlayerReady = 'true';
    if (typeof window.createCCH5Player === 'function') settleCCLibrary(true);
  };
  function loadCCPlayerLibrary() {
    if (typeof window.createCCH5Player === 'function') return Promise.resolve();
    if (ccPlayerLibraryPromise) return ccPlayerLibraryPromise;
    ccPlayerLibraryPromise = new Promise((resolve, reject) => {
      ccLibraryResolver = resolve; ccLibraryRejecter = reject;
      let script = document.getElementById('cc-official-player-script');
      if (script && !script.dataset.loaded) { script.remove(); script = null; }
      if (!script) {
        script = document.createElement('script');
        script.id = 'cc-official-player-script';
        script.src = CC_PLAYER_SCRIPT_URL;
        script.async = true;
        script.referrerPolicy = 'strict-origin-when-cross-origin';
        script.onload = () => { script.dataset.loaded = 'true'; if (typeof window.createCCH5Player === 'function') settleCCLibrary(true); };
        script.onerror = () => settleCCLibrary(false, new Error('无法连接施耐德官网 CC 视频服务'));
        document.head.appendChild(script);
      }
      ccLibraryTimeout = setTimeout(() => {
        if (typeof window.createCCH5Player === 'function') settleCCLibrary(true);
        else settleCCLibrary(false, new Error('施耐德官网 CC 播放器加载超时'));
      }, 18000);
    });
    ccPlayerLibraryPromise = ccPlayerLibraryPromise.catch(error => { ccPlayerLibraryPromise = null; throw error; });
    return ccPlayerLibraryPromise;
  }

  // ---- 播放器创建（对齐原 startCCVideo 参数）----
  function startCCVideo(shell, seekRatio, chapterButton) {
    if (!shell) return;
    const vid = String(shell.dataset.ccVid || '');
    const meta = getCCMeta(vid);
    if (!vid) { showError(shell, new Error('缺少 data-cc-vid')); return; }
    if (shell.__ccRecord && !shell.__ccRecord.destroyed) { requestCCSeek(shell.__ccRecord, seekRatio, chapterButton); return; }
    shell.classList.add('is-playing', 'is-loading');
    const poster = shell.querySelector('.video-poster');
    if (poster) poster.hidden = true;
    const host = document.createElement('div');
    host.className = 'cc-player-host';
    host.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    shell.appendChild(host);
    const record = { vid, meta, shell, host, player: null, videoElement: null, pendingRatio: clampCCRatio(seekRatio || 0), duration: 0, destroyed: false };
    shell.__ccRecord = record; records.set(vid, record);
    loadCCPlayerLibrary().then(() => {
      if (record.destroyed || !record.host.isConnected) return;
      if (typeof window.createCCH5Player !== 'function') throw new Error('CC H5 播放器未就绪（SDK 未注入）');
      const player = window.createCCH5Player({
        vid, siteid: CC_SITE_ID, mediatype: 1, playtype: 1,
        autoStart: true, width: '100%', height: '100%',
        isShare: false, banDrag: false, progressbar_enable: 1, closeHistoryTime: 1,
        parentNode: record.host
      });
      record.player = player;
      try { if (player && typeof player.play === 'function') player.play(); } catch (e) {}
      if (chapterButton) {
        const section = shell.closest('section');
        if (section) section.querySelectorAll('.chapter[data-seek-ratio]').forEach(item => item.classList.toggle('active', item === chapterButton));
      }
    }).catch(error => showError(shell, error));
  }

  function showError(shell, error) {
    console.error('[CC] 播放失败:', error);
    shell.dataset.ccStarted = '0';
    shell.classList.remove('is-playing', 'is-loading');
    const old = shell.querySelector('.cc-video-status'); if (old) old.remove();
    const badge = document.createElement('div');
    badge.className = 'cc-video-status';
    badge.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;color:#fff;background:rgba(0,0,0,.6);font-size:13px;padding:16px;text-align:center;z-index:5;line-height:1.6';
    const msg = (error && error.message) ? error.message : String(error);
    badge.innerHTML = '视频加载失败：<br>' + msg + '<br><span style="opacity:.7;font-size:11px">若提示需授权，说明 CC 平台限制该来源域名播放</span>';
    shell.appendChild(badge);
  }

  function requestCCSeek(record, ratio, chapterButton) {
    const shell = record.shell;
    ratio = clampCCRatio(ratio);
    if (chapterButton) {
      const section = shell.closest('section');
      if (section) section.querySelectorAll('.chapter[data-seek-ratio]').forEach(it => it.classList.toggle('active', it === chapterButton));
    }
    if (record.player && typeof record.player.seek === 'function') {
      try { record.player.seek(ratio * (record.duration || 0)); record.player.play && record.player.play(); } catch (e) {}
    } else {
      record.pendingRatio = ratio;
    }
  }

  // ---- 全局回调（与原文件一致，靠 record 体系激活视频）----
  window.on_CCH5player_ready = function (obj) {
    const vid = String(obj && obj.vid || '');
    const record = getCCRecord(vid); if (!record || record.destroyed) return;
    record.videoElement = (obj && obj.videoElement) || null;
    if (record.videoElement) {
      record.videoElement.setAttribute('playsinline', '');
      record.videoElement.setAttribute('webkit-playsinline', '');
      const onMeta = () => { record.shell.classList.remove('is-loading'); };
      record.videoElement.addEventListener('loadedmetadata', onMeta, { once: true });
    }
    record.shell.classList.remove('is-loading');
    if (record.pendingRatio) { try { record.player && record.player.seek(record.pendingRatio * (record.duration || 0)); } catch (e) {} record.pendingRatio = 0; }
  };
  window.on_CCH5player_play = function (video, vid) {
    const record = getCCRecord(String(vid)); if (record) { record.shell.classList.remove('is-loading'); }
  };
  window.on_CCH5player_error = function (errInfo) {
    const vid = String(errInfo && errInfo.vid || '');
    const record = getCCRecord(vid); if (record) showError(record.shell, errInfo || new Error('视频播放错误'));
  };
  window.on_h5player_error = function (errInfo) {
    const vid = String(errInfo && errInfo.vid || '');
    const record = getCCRecord(vid); if (record) showError(record.shell, errInfo || new Error('视频播放错误'));
  };

  // ---- 绑定（与原 bindOfficialVideos 一致）----
  // 章节按钮→视频壳：定位视频壳时按（1）章节所在 section 内、（2）否则文档级兜底
  function resolveChapterShell(button) {
    const sec = button.closest('section');
    return (sec && sec.querySelector('.video-shell[data-cc-vid]'))
        || document.querySelector('.video-shell[data-cc-vid]');
  }
  function bindChapterButton(button) {
    if (button.__ccBound) return;
    button.__ccBound = true;
    button.addEventListener('click', () => {
      const sh = resolveChapterShell(button);
      if (sh) startCCVideo(sh, button.dataset.seekRatio, button);
    });
  }
  function bindCCVideos(root) {
    root = root || document;
    // 入口 A：video-shell 内的 poster click + 同 shell 内的章节（基线 POC）
    root.querySelectorAll('.video-shell[data-cc-vid]').forEach(shell => {
      const poster = shell.querySelector('.video-poster');
      if (poster && !poster.__ccBound) {
        poster.__ccBound = true;
        poster.addEventListener('click', () => startCCVideo(shell, 0, null));
      }
      shell.querySelectorAll('.chapter[data-seek-ratio]').forEach(bindChapterButton);
    });
    // 入口 B：document 全局兜底——给未绑过的章节补上 click（extracted HTML：chapters 不嵌套在 video-shell 内）
    root.querySelectorAll('.chapter[data-seek-ratio]').forEach(bindChapterButton);
  }

  window.bindCCVideos = bindCCVideos;
  // 预热 SDK（与原文件 render() 末尾一致）
  loadCCPlayerLibrary().catch(() => {});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bindCCVideos(document));
  else bindCCVideos(document);
})();
`;

const outDir = path.join(root, 'data', 'extracted');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'player.js'), playerJs, 'utf8');
console.log('player.js (hook-aligned) written:', playerJs.length, 'bytes');
console.log('CC_SITE_ID:', CC_SITE_ID);
console.log('CC_PLAYER_SCRIPT_URL:', CC_PLAYER_SCRIPT_URL);
