// Runs before every page opened inside Lounge. On YouTube it removes ads from the player data
// before the page sees it, and skips any ad that still slips through.
const { webFrame, ipcRenderer } = require('electron');
let tvSettings = {}; try { tvSettings = ipcRenderer.sendSync('settings:sync') || {}; } catch (e) {}

// "Highest quality" setting: as soon as a YouTube video starts, lock the player to the best quality
// YouTube offers, so its automatic mode can't drop to a low resolution.
function maxQuality() {
  if (window.__tvMaxQ) return; window.__tvMaxQ = true;
  const done = new Set();
  setInterval(() => {
    const p = document.querySelector('.html5-video-player');
    if (!p || !p.getAvailableQualityLevels || !p.setPlaybackQualityRange) return;
    const levels = p.getAvailableQualityLevels().filter(q => q && q !== 'auto');
    if (!levels.length) return;
    let id = ''; try { id = (p.getVideoData && p.getVideoData().video_id) || ''; } catch (e) {}
    const key = id + '|' + levels[0];
    if (done.has(key)) return;
    done.add(key);
    try { p.setPlaybackQualityRange(levels[0], levels[0]); if (p.setPlaybackQuality) p.setPlaybackQuality(levels[0]); } catch (e) {}
  }, 1500);
}

function adFree() {
  if (window.__loungeAdFree) return; window.__loungeAdFree = true;
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adBreakParams'];
  const strip = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 4) return o;
    if (Array.isArray(o)) { for (const x of o) strip(x, depth + 1); return o; }
    for (const k of AD_KEYS) if (k in o) { try { delete o[k]; } catch (e) {} }
    if (o.playerResponse) strip(o.playerResponse, depth + 1);
    if (o.response) strip(o.response, depth + 1);
    return o;
  };
  const parse = JSON.parse;
  JSON.parse = function () { const v = parse.apply(this, arguments); try { strip(v); } catch (e) {} return v; };
  const json = Response.prototype.json;
  Response.prototype.json = function () { return json.call(this).then(v => { try { strip(v); } catch (e) {} return v; }); };
  let ipr;
  try { Object.defineProperty(window, 'ytInitialPlayerResponse', { configurable: true, get: () => ipr, set: v => { ipr = strip(v); } }); } catch (e) {}

  let mutedByUs = null;
  setInterval(() => {
    const v = document.querySelector('.ad-showing video, .ad-interrupting video');
    if (v) {
      if (!v.muted) { v.muted = true; mutedByUs = v; }
      if (isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.2) { try { v.currentTime = v.duration; } catch (e) {} }
    } else if (mutedByUs) { mutedByUs.muted = false; mutedByUs = null; }
    document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button, ytlr-skip-button-renderer')
      .forEach(b => { try { b.click(); } catch (e) {} });
  }, 250);
}

if (/(^|\.)youtube\.com$/i.test(location.hostname)) {
  webFrame.executeJavaScript(`(${adFree.toString()})()`).catch(() => {});
  if (tvSettings.ytq !== 'auto') webFrame.executeJavaScript(`(${maxQuality.toString()})()`).catch(() => {});
}


// Keep apps playing when you switch to another window on the PC (Alt+Tab): the page is told it is still visible
// and focused, so YouTube & co. don't pause themselves. (TV pauses apps itself when you go back to Home.)
function stayVisible() {
  if (window.__tvVisible) return; window.__tvVisible = true;
  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(Document.prototype, 'webkitHidden', { configurable: true, get: () => false });
    Document.prototype.hasFocus = function () { return true; };
  } catch (e) {}
  const stop = e => { if (e.target === window || e.target === document) e.stopImmediatePropagation(); };
  for (const ev of ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze']) {
    window.addEventListener(ev, stop, true); document.addEventListener(ev, stop, true);
  }
}
webFrame.executeJavaScript(`(${stayVisible.toString()})()`).catch(() => {});

// Hide the mouse pointer after 2.5 seconds without movement (it comes back as soon as the mouse moves).
(() => {
  let t = 0, styled = false;
  const root = () => document.documentElement;
  const addStyle = () => {
    if (styled || !document.head) return; styled = true;
    const st = document.createElement('style'); st.textContent = 'html.tv-nocur,html.tv-nocur *{cursor:none!important}'; document.head.appendChild(st);
  };
  const hide = () => { addStyle(); if (root()) root().classList.add('tv-nocur'); };
  const show = () => { if (root()) root().classList.remove('tv-nocur'); clearTimeout(t); t = setTimeout(hide, 2500); };
  window.addEventListener('mousemove', show, true); window.addEventListener('mousedown', show, true);
  document.addEventListener('DOMContentLoaded', () => { addStyle(); show(); });
})();
