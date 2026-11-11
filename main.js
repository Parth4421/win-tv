const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
let QR = null; try { QR = require('qrcode'); } catch {}
const files = require('./files');
const media = require('./media');
let mediaInfo = { ok: false };

const PORT = 8765;
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const modeFile = path.join(os.tmpdir(), 'lounge-mode.txt');
const YT_TV_UA = 'Mozilla/5.0 (Linux armeabi-v7a; Android 9) Cobalt/22.lts.3.306369-gold (unlike Gecko) v8/8.8.278.17-jit gles Starboard/13, Google_ATV_sabrina_2020/STTE.211214.003 (google, Chromecast) com.google.android.youtube.tv/5.20.401';
const ICON = path.join(__dirname, 'TV.ico');
// Smoother animations: let the GPU draw the UI even on graphics drivers Chromium is cautious about
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.setAppUserModelId('com.tv.launcher'); // so the taskbar shows the TV icon, not Electron's
// Only one TV at a time (two copies would fight over the controller). A second launch brings TV to the front.
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => { if (home && !home.isDestroyed()) { home.show(); home.focus(); } });
const KEYS = { up: 0x26, down: 0x28, left: 0x25, right: 0x27, ok: 0x0D, enter: 0x0D, esc: 0x1B, bksp: 0x08,
  volup: 0xAF, voldown: 0xAE, mute: 0xAD, play: 0xB3, next: 0xB0, prev: 0xB1 };
// Keys sent straight into TV-style apps (YouTube TV) so the D-pad drives their own focus system.
const TV_KEYS = { up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'Enter', back: 'Escape' };
// VLC shortcuts: OK = pause (Space), Left/Right = jump 10 s (Alt+arrow), Up/Down = volume (Ctrl+arrow),
// Triangle/Y = next audio language (B), Square/X = next subtitles (V). '-' = no modifier.
const VLC_KEYS = { ok: ['-', 0x20], left: ['a', 0x25], right: ['a', 0x27], up: ['c', 0x26], down: ['c', 0x28], menu: ['-', 0x42], sub: ['-', 0x56] };

// Settings chosen in TV's Settings screen (saved in %APPDATA%\TV\settings.json)
let settings = { scale: 1, sound: 'normal', anim: 'full', ytq: 'max', movies: 'auto' };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() { try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch {} }
function saveSettings(s) {
  if (!s || typeof s !== 'object') return false;
  const scale = Number(s.scale);
  if ([0.9, 1, 1.1, 1.15].includes(scale)) settings.scale = scale;
  if (['off', 'low', 'normal', 'loud'].includes(s.sound)) settings.sound = s.sound;
  if (['full', 'reduced'].includes(s.anim)) settings.anim = s.anim;
  if (['max', 'auto'].includes(s.ytq)) settings.ytq = s.ytq;
  if (['auto', 'vlc'].includes(s.movies)) settings.movies = s.movies;
  if (['s', 'm', 'l', 'xl'].includes(s.subSize)) settings.subSize = s.subSize;
  if (typeof s.tmdbKey === 'string' && /^[A-Za-z0-9._-]{0,400}$/.test(s.tmdbKey.trim())) settings.tmdbKey = s.tmdbKey.trim();
  if (Array.isArray(s.iptv)) settings.iptv = s.iptv.filter(x => typeof x === 'string' && x.length < 2000 && (/^https?:\/\//i.test(x) || path.isAbsolute(x))).slice(0, 20);
  if (typeof s.osKey === 'string' && /^[A-Za-z0-9]{0,100}$/.test(s.osKey.trim())) settings.osKey = s.osKey.trim();
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
  if (appWin && !appWin.isDestroyed() && appWin.__zoom) appWin.webContents.setZoomFactor(settings.scale);
  return true;
}
// Network-level ad blocking for apps opened inside Lounge (YouTube, Twitch, Web).
const AD_URLS = ['*://*.doubleclick.net/*', '*://*.googlesyndication.com/*', '*://*.googleadservices.com/*',
  '*://*.youtube.com/api/stats/ads*', '*://*.youtube.com/pagead/*', '*://*.youtube.com/get_midroll_*',
  '*://*.youtube.com/ptracking*', '*://imasdk.googleapis.com/*'];

// mode: 'nav' = Lounge home, 'keys' = TV-style app, 'mouse' = pointer-driven app (Prime, Netflix, web)
let lastAltF4 = 0;
let ccOverApp = false;   // Control Center opened on top of a running app
const appWins = new Map(), MAX_APPS = 3;   // apps stay open in the background (no restart) until closed
const appKey = a => String(a.url || '').split('#')[0];
let home, appWin = null, external = false, launchedAt = 0, mode = 'nav', token = '', inp = null, padProc = null, xinput = false, quitting = false;

const toHome = (ch, ...a) => { if (home && !home.isDestroyed()) home.webContents.send(ch, ...a); };
// The controller helper reads the mode from this file. If a write collides with a read, retry, and
// rewrite it every second anyway so the helper can never stay stuck in the wrong mode.
function writeMode(tries = 5) {
  try { fs.writeFileSync(modeFile, mode); }
  catch { if (tries > 0) setTimeout(() => writeMode(tries - 1), 40); }
}
const setMode = m => { mode = m; writeMode(); toHome('mode', m); };
setInterval(() => writeMode(0), 1000);
const send = s => { try { if (inp && inp.stdin.writable) inp.stdin.write(s + '\n'); } catch {} };
const script = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'helper.ps1');
const ps = role => {
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, role, modeFile], { windowsHide: true });
  p.on('error', () => {}); if (p.stdin) p.stdin.on('error', () => {}); return p;
};

function startInput() {
  inp = ps('input');
  inp.on('exit', () => { if (!quitting) setTimeout(startInput, 1000); });
}
function startPad() {
  const p = padProc = ps('pad'); let buf = '';
  p.stdout.on('data', d => {
    buf += d.toString(); const lines = buf.split(/\r?\n/); buf = lines.pop();
    lines.forEach(onPadLine);
  });
  p.on('exit', () => { if (!quitting) setTimeout(startPad, 1500); });
}
function onPadLine(l) {
  const [t, v] = l.trim().split(' ');
  if (t === 'nav') navigate(v);
  else if (t === 'home') goHome();
  else if (t === 'cc') showCC();
  else if (t === 'xi') { xinput = v === '1'; toHome('xinput', xinput); }
}

function tvKey(d) {
  const k = TV_KEYS[d]; if (!k || !appWin || appWin.isDestroyed()) return;
  if (!appWin.isFocused()) appWin.focus();
  const wc = appWin.webContents;
  wc.sendInputEvent({ type: 'keyDown', keyCode: k });
  wc.sendInputEvent({ type: 'keyUp', keyCode: k });
}

let lastBack = 0;
function navigate(d) {
  if (mode === 'nav') return toHome('nav', d);
  // Inside any app: press Back twice quickly to close the app and return to TV Home.
  if (d === 'back') {
    const now = Date.now();
    if (now - lastBack < 650) { lastBack = 0; return goHome(); }
    lastBack = now;
  }
  if (mode === 'keys' && appWin && !appWin.isDestroyed()) return tvKey(d);
  // VLC (movies): controller -> VLC's own shortcuts
  if (mode === 'vlc') { const k = VLC_KEYS[d]; if (k) send(`kc ${k[0]} ${k[1]}`); return; }
  // Pointer apps: OK is "smart" (click under the cursor, or Enter after arrow-key use) — see helper.ps1
  if (d === 'back') send('back');
  else if (d === 'ok') send('ok');
  else if (KEYS[d]) send('k ' + KEYS[d]);
}

function goHome() {
  if (ccOverApp) {   // Home pressed while Control Center was open over an app: the app stays open, paused, in the background
    const o = ccOverApp; ccOverApp = false; toHome('overapp', null);
    if (o.behind === 'app' && appWin) { hideApp(appWin); appWin = null; }
    external = false;
  }
  if (mode === 'nav') { toHome('nav', 'home'); return; }
  const wasExternal = external && !appWin;
  if (appWin) { hideApp(appWin); appWin = null; }
  else if (external) { lastAltF4 = Date.now(); send('altf4'); }
  external = false; setMode('nav');
  // Give Alt+F4 time to reach Edge before Lounge takes focus, so it can never hit Lounge itself.
  setTimeout(() => {
    if (!home || home.isDestroyed()) return;
    home.show(); home.focus(); toHome('home');
  }, wasExternal ? 350 : 0);
}

const openKeys = () => [...appWins.keys()];
function pauseApp(w) {
  if (!w || w.isDestroyed()) return;
  w.webContents.executeJavaScript("document.querySelectorAll('video,audio').forEach(v=>{try{v.pause()}catch(e){}})", true).catch(() => {});
}
function hideApp(w) {
  if (!w || w.isDestroyed()) return;
  pauseApp(w); try { w.webContents.setBackgroundThrottling(true); } catch {}   // hidden apps use almost no CPU
  w.hide();
}
function showApp(w) { try { w.webContents.setBackgroundThrottling(false); } catch {} w.show(); w.focus(); }
function closeApp(w) {
  if (!w) return;
  for (const [k, v] of appWins) if (v === w) appWins.delete(k);
  if (appWin === w) appWin = null;
  if (!w.isDestroyed()) w.destroy();
  toHome('apps-open', openKeys());
}
// Share / View inside an app: Control Center slides in on top of the app; closing it goes straight back to the app.
function showCC() {
  if (mode === 'nav') return toHome('nav', 'quick');
  const behind = appWin && !appWin.isDestroyed() ? 'app' : external ? 'ext' : null;
  if (!behind || !home || home.isDestroyed()) return goHome();
  ccOverApp = { mode, behind };
  setMode('nav');
  home.show(); home.focus(); try { home.moveTop(); } catch {}
  toHome('cc-over-app', behind);
}
function resumeApp() {
  const o = ccOverApp; ccOverApp = false; if (!o) return;
  if (o.behind === 'app' && appWin && !appWin.isDestroyed()) { setMode(o.mode); showApp(appWin); }
  else if (o.behind === 'ext') { setMode(o.mode); external = true; send('kc a 9'); }   // Alt+Tab back to the Edge app
  else setMode('nav');
}

function edgePath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  return roots.map(r => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(p => fs.existsSync(p));
}

// Non-web links the Store may add, opened by Windows itself (Steam Big Picture, Microsoft Store, Epic)
const SHELL_OK = /^(steam|ms-windows-store|com\.epicgames\.launcher):/i;
const isWeb = u => /^https?:\/\//i.test(u);

function launch(a) {
  if (!a || typeof a.url !== 'string') return;
  if (!isWeb(a.url) && !(a.via === 'shell' && SHELL_OK.test(a.url))) return;
  launchedAt = Date.now();
  setMode(a.input === 'tv' ? 'keys' : 'mouse');
  if (a.via === 'shell') { external = true; shell.openExternal(a.url); return; }
  if (a.via === 'edge') {
    external = true;
    const edge = edgePath();
    // Interface size for Edge apps (Edge applies it when it isn't already running in the background)
    const scaleArg = settings.scale !== 1 ? ['--force-device-scale-factor=' + settings.scale] : [];
    if (edge) spawn(edge, ['--start-fullscreen', ...scaleArg, '--app=' + a.url], { detached: true, stdio: 'ignore' }).unref();
    else shell.openExternal(a.url);
    return;
  }
  const key = appKey(a), kept = appWins.get(key);
  if (appWin && appWin !== kept) { hideApp(appWin); appWin = null; }
  if (kept && !kept.isDestroyed()) {   // already open: show it again exactly where it was
    appWins.delete(key); appWins.set(key, kept); appWin = kept; setMode(kept.__mode); showApp(kept); return;
  }
  while (appWins.size >= MAX_APPS) closeApp(appWins.values().next().value);   // keep memory in check: close the oldest
  const w = appWin = new BrowserWindow({ fullscreen: true, backgroundColor: '#000', autoHideMenuBar: true, icon: ICON,
    webPreferences: { partition: 'persist:lounge', preload: path.join(__dirname, 'app-preload.js'),
      autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, spellcheck: false } });
  w.__mode = a.input === 'tv' ? 'keys' : 'mouse'; appWins.set(key, w); toHome('apps-open', openKeys());
  // YouTube: the old PS4 identity made YouTube switch to its low-end mode with no animations.
  // Saved app lists from older versions still have it, so upgrade it here.
  const ua = a.ua && /PS4; Leanback Shell/.test(a.ua) ? YT_TV_UA : a.ua;
  if (ua) w.webContents.setUserAgent(ua);
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) w.loadURL(url); return { action: 'deny' }; });
  w.on('closed', () => {
    for (const [k, v] of appWins) if (v === w) appWins.delete(k);
    toHome('apps-open', openKeys());
    if (appWin === w) { appWin = null; goHome(); }
  });
  // Interface size for web apps opened inside TV (TV-style apps like YouTube size themselves)
  w.__zoom = a.input !== 'tv';
  if (w.__zoom) w.webContents.on('did-finish-load', () => { if (!w.isDestroyed()) w.webContents.setZoomFactor(settings.scale); });
  w.loadURL(a.url);
}

// Files that TV's own player can't decode open in VLC (full screen) or, without VLC, the Windows default player.
// The controller then works as a mouse/keys there, and Home / Back twice returns to TV as for other apps.
function playExternal(file, start) {
  try { if (typeof file !== 'string' || !path.isAbsolute(file) || !fs.statSync(file).isFile() || !files.kindOf(file)) return null; }
  catch { return null; }
  launchedAt = Date.now(); external = true;
  const vlc = files.vlcPath();
  if (vlc) {
    // In VLC the controller drives VLC's shortcuts (pause, seek, volume, audio language, subtitles)
    setMode('vlc');
    const t = Math.floor(Number(start) || 0);
    spawn(vlc, ['--fullscreen', '--play-and-exit', ...(t > 0 ? ['--start-time=' + t] : []), file], { detached: true, stdio: 'ignore' }).unref();
    return 'vlc';
  }
  setMode('mouse'); shell.openPath(file); return 'windows';
}

const held = { l: false, r: false };
function onPad(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'nav': navigate(m.d); break;
    case 'move': send(`m ${Math.round(m.x) || 0} ${Math.round(m.y) || 0}`); break;
    case 'scroll': send('s ' + (Math.round(m.y) || 0)); break;
    case 'btn': { const b = m.b === 'r' ? 'r' : 'l'; held[b] = !!m.down; send(b + (m.down ? 'd' : 'u')); break; }
    case 'okd': send('okd'); break;
    case 'oku': send('oku'); break;
    case 'key': if (KEYS[m.k]) send('k ' + KEYS[m.k]); break;
    case 'osk': send('osk'); break;
    case 'home': goHome(); break;
    case 'cc': showCC(); break;
  }
}

function onRemote(m) {
  switch (m.t) {
    case 'nav': navigate(m.d); break;
    case 'move': send(`m ${Math.round(m.x) || 0} ${Math.round(m.y) || 0}`); break;
    case 'click': send('c ' + (m.b === 'r' ? 'r' : 'l')); break;
    case 'scroll': send('s ' + (Math.round(m.y) || 0)); break;
    case 'text': send('t ' + Buffer.from(String(m.v)).toString('base64')); break;
    case 'key': if (m.k === 'back') navigate('back'); else if (KEYS[m.k]) send('k ' + KEYS[m.k]); break;
    case 'home': goHome(); break;
    case 'audioonly': audioOnly(); break;
  }
}

// "Audio only": in TV's own player the screen goes dark and sound keeps playing.
// Inside a TV app window (like YouTube) the picture is blacked out while the sound plays on.
async function audioOnly() {
  if (mode === 'nav' || !appWin || appWin.isDestroyed()) return toHome('audioonly');
  const wc = appWin.webContents;
  try {
    if (appWin.__black) { const k = appWin.__black; appWin.__black = null; await wc.removeInsertedCSS(k); }
    else appWin.__black = await wc.insertCSS('html{filter:brightness(0)!important;background:#000!important}');
  } catch (e) {}
}

function lanIP() {
  const all = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal);
  return (all.find(i => /^(192\.168|10\.)/.test(i.address)) || all[0] || { address: 'localhost' }).address;
}

function startRemote() {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname, 'remote.html')));
  });
  srv.on('error', e => console.log('remote server:', e.message));
  new WebSocketServer({ server: srv }).on('connection', (ws, req) => {
    if (new URL(req.url, 'http://x').searchParams.get('k') !== token) return ws.close();
    ws.on('message', d => { try { onRemote(JSON.parse(d)); } catch {} });
  });
  srv.listen(PORT, '0.0.0.0');
}

const customApps = () => path.join(app.getPath('userData'), 'apps.json');
function loadApps() {
  try { const l = JSON.parse(fs.readFileSync(customApps(), 'utf8')); if (Array.isArray(l) && l.length) return l; } catch {}
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'apps.json'), 'utf8'));
}
// The Store / Remove-from-Home save the Home app list here. Only known, safe fields are kept.
function saveApps(list) {
  if (!Array.isArray(list)) return false;
  const str = (v, max = 300) => (typeof v === 'string' && v.length <= max ? v : undefined);
  const clean = list.slice(0, 80).map(a => {
    if (!a || typeof a !== 'object') return null;
    const o = { name: str(a.name, 60), tag: str(a.tag), url: str(a.url, 2000), color: str(a.color, 20), icon: str(a.icon, 60),
      logo: str(a.logo, 2000), ua: str(a.ua, 400),
      via: ['edge', 'shell'].includes(a.via) ? a.via : undefined, input: a.input === 'tv' ? 'tv' : undefined };
    if (!o.name || !o.url) return null;
    if (!isWeb(o.url) && !(o.via === 'shell' && SHELL_OK.test(o.url))) return null;
    return o;
  }).filter(Boolean);
  if (!clean.length) return false;
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(customApps(), JSON.stringify(clean, null, 2)); return true; }
  catch { return false; }
}

app.whenReady().then(async () => {
  const ud = app.getPath('userData');
  loadSettings();
  const tf = path.join(ud, 'token.txt');
  try { token = fs.readFileSync(tf, 'utf8').trim(); } catch {}
  if (!token) { token = crypto.randomBytes(3).toString('hex'); fs.mkdirSync(ud, { recursive: true }); fs.writeFileSync(tf, token); }

  // Session for the apps Lounge opens itself
  const ses = session.fromPartition('persist:lounge');
  ses.setUserAgent(UA);
  ses.webRequest.onBeforeRequest({ urls: AD_URLS }, (_, cb) => cb({ cancel: true }));
  const extDir = path.join(ud, 'extensions'); fs.mkdirSync(extDir, { recursive: true });
  for (const d of fs.readdirSync(extDir)) {
    try { await (ses.extensions || ses).loadExtension(path.join(extDir, d), { allowFileAccess: true }); } catch (e) { console.log('ext fail', d, e.message); }
  }

  // Let the Lounge home page read PlayStation controllers directly (WebHID): buttons, sticks and touchpad.
  const ds = session.defaultSession;
  ds.setPermissionCheckHandler(() => true);
  ds.setDevicePermissionHandler(d => d.deviceType === 'hid');
  ds.on('select-hid-device', (e, details, cb) => {
    e.preventDefault();
    const list = details.deviceList || [];
    const pick = list.find(d => d.vendorId === 0x054c) || list.find(d => d.vendorId !== 0x045e);
    cb(pick ? pick.deviceId : null);
  });

  setMode('nav');
  startPad();
  startInput();
  startRemote();

  ipcMain.handle('apps', () => loadApps());
  ipcMain.handle('saveApps', (_, list) => saveApps(list));

  // Files app: browse this PC for videos and music
  ipcMain.handle('fs:roots', () => files.roots([['Videos', app.getPath('videos')], ['Downloads', app.getPath('downloads')],
    ['Desktop', app.getPath('desktop')], ['Music', app.getPath('music')]]));
  ipcMain.handle('fs:list', async (_, dir) => {
    try { return await files.list(dir); }
    catch (e) { return { error: e.code === 'EPERM' || e.code === 'EACCES' ? 'Windows does not allow opening this folder.' : e.code === 'ENOENT' ? 'This folder no longer exists.' : 'This folder could not be opened.' }; }
  });
  ipcMain.handle('fs:subs', (_, f) => files.subtitleFor(f));
  ipcMain.handle('fs:external', (_, f, start) => playExternal(f, start));
  // Media engine (built-in player: any sound format, audio languages, embedded subtitles)
  try { mediaInfo = await media.start({ isMedia: f => !!files.kindOf(f), cache: path.join(ud, 'subcache'), thumbs: path.join(ud, 'thumbs') }); } catch (e) { mediaInfo = { ok: false }; }
  ipcMain.handle('media:info', () => mediaInfo);
  const mediaFile = f => { try { return typeof f === 'string' && path.isAbsolute(f) && fs.statSync(f).isFile() && !!files.kindOf(f); } catch { return false; } };
  ipcMain.handle('subs:search', async (_, f) => {
    if (!settings.osKey) return { error: 'nokey' }; if (!mediaFile(f)) return { error: 'This file could not be read.' };
    try { return { results: await media.osSearch(settings.osKey, f) }; } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('subs:download', async (_, f, id, lang) => {
    if (!settings.osKey || !mediaFile(f) || !Number.isInteger(id)) return { error: 'Download failed.' };
    try { return await media.osDownload(settings.osKey, f, id, typeof lang === 'string' ? lang.slice(0, 5) : ''); } catch (e) { return { error: e.message }; }
  });
  // Wi-Fi and Bluetooth (net.ps1), only these commands
  const NET = new Set(['audio-list', 'audio-set', 'wifi-status', 'wifi-scan', 'wifi-connect', 'wifi-disconnect', 'wifi-forget', 'bt-status', 'bt-power', 'bt-scan', 'bt-pair', 'bt-unpair']);
  const netScript = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'net.ps1');
  ipcMain.handle('net', (_, cmd, arg, input) => new Promise(resolve => {
    if (!NET.has(cmd)) return resolve({ error: 'unknown' });
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', netScript, cmd];
    if (typeof arg === 'string' && arg) args.push(arg.slice(0, 300));
    const p = spawn('powershell', args, { windowsHide: true }); let out = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ error: 'Took too long. Try again.' }); }, 45000);
    p.stdout.on('data', d => { out += d; }); p.on('error', () => { clearTimeout(timer); resolve({ error: 'unavailable' }); });
    p.on('exit', () => { clearTimeout(timer); try { resolve(JSON.parse(out.trim().split(/\r?\n/).pop())); } catch { resolve({ error: 'Something went wrong.' }); } });
    if (input && typeof input === 'object') p.stdin.end(JSON.stringify(input)); else p.stdin.end();
  }));
  // Live TV: channel lists from the user's own M3U links / files
  ipcMain.handle('live:load', async () => {
    const extra = [];   // .m3u / .m3u8 files dropped in Videos or Downloads are picked up too
    for (const dir of [app.getPath('videos'), app.getPath('downloads')]) {
      try { for (const f of fs.readdirSync(dir)) if (/\.m3u8?$/i.test(f)) extra.push(path.join(dir, f)); } catch {}
    }
    return media.loadPlaylists([...(settings.iptv || []), ...extra]);
  });
  // Movie posters + info (TMDB), cached on disk so each movie is looked up once
  const metaFile = path.join(ud, 'movieinfo.json'); let metaCache = {};
  try { metaCache = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch {}
  ipcMain.handle('meta:get', async (_, f) => {
    if (!settings.tmdbKey || !mediaFile(f)) return null;
    const k = path.basename(f).toLowerCase();
    if (metaCache[k] && Date.now() - metaCache[k].at < 30 * 864e5) return metaCache[k].info;
    try {
      const info = await media.movieInfo(settings.tmdbKey, f);
      metaCache[k] = { at: Date.now(), info }; fs.writeFile(metaFile, JSON.stringify(metaCache), () => {});
      return info;
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_, s) => saveSettings(s));
  ipcMain.on('settings:sync', e => { e.returnValue = settings; });   // read by app-preload (YouTube quality)
  ipcMain.handle('info', async () => {
    const url = `http://${lanIP()}:${PORT}/?k=${token}`;
    let qr = null;
    if (QR) { try { qr = await QR.toDataURL(url, { margin: 1, width: 480 }); } catch {} }
    return { url, qr };
  });
  ipcMain.on('launch', (_, a) => launch(a));
  ipcMain.on('pad', (_, m) => onPad(m));
  ipcMain.on('appctl', (_, c) => {
    if (c === 'resume') return resumeApp();
    if (c === 'close') { const o = ccOverApp; ccOverApp = false; if (o && o.behind === 'app' && appWin) closeApp(appWin); external = false; setMode('nav'); return; }
    if (c === 'closeall') { [...appWins.values()].forEach(closeApp); return; }
    if (typeof c === 'string' && c.startsWith('close:')) closeApp(appWins.get(c.slice(6)));
  });
  ipcMain.handle('apps:open', () => openKeys());
  ipcMain.on('sys', (_, c) => {
    if (c === 'exit') { quitting = true; app.quit(); }
    if (c === 'sleep') exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
    if (c === 'restart') { quitting = true; exec('shutdown /r /t 5'); }
    if (c === 'bluetooth') { launchedAt = Date.now(); external = true; setMode('mouse'); shell.openExternal('ms-settings:bluetooth'); }
  });

  home = new BrowserWindow({ fullscreen: true, backgroundColor: '#050508', autoHideMenuBar: true, icon: ICON, title: 'TV',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false,
      enableBlinkFeatures: 'AudioVideoTracks' } });   // lets the built-in player list and switch audio languages
  // Alt+F4 on the Home screen closes TV. The Alt+F4 that TV itself sends to close an Edge app
  // (and anything while an app is open) is ignored, so TV never closes by accident.
  home.on('close', e => {
    if (quitting) return;
    if (mode === 'nav' && Date.now() - lastAltF4 > 2500) { quitting = true; return; }
    e.preventDefault();
  });
  // If the user closes an Edge app by hand, Lounge gets focus back: switch to home navigation.
  home.on('focus', () => {
    if (external && !appWin && mode !== 'nav' && Date.now() - launchedAt > 3000) { external = false; setMode('nav'); toHome('home'); }
  });
  const scan = () => { if (home && !home.isDestroyed() && !home.webContents.isLoading())
    home.webContents.executeJavaScript('window.__padScan && window.__padScan(true)', true).catch(() => {}); };
  home.webContents.on('did-finish-load', () => { toHome('mode', mode); toHome('xinput', xinput); scan(); });
  setInterval(scan, 5000);
  home.loadFile('index.html');
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  try { if (held.l) send('lu'); if (held.r) send('ru'); } catch {}
  for (const p of [inp, padProc]) { try { p && p.kill(); } catch {} }
});
app.on('window-all-closed', () => app.quit());
