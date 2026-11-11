const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lounge', {
  apps: () => ipcRenderer.invoke('apps'),
  saveApps: list => ipcRenderer.invoke('saveApps', list),
  files: {
    roots: () => ipcRenderer.invoke('fs:roots'),
    list: dir => ipcRenderer.invoke('fs:list', dir),
    subs: file => ipcRenderer.invoke('fs:subs', file),
    external: (file, start) => ipcRenderer.invoke('fs:external', file, start)
  },
  media: () => ipcRenderer.invoke('media:info'),
  net: (cmd, arg, input) => ipcRenderer.invoke('net', cmd, arg, input),
  live: () => ipcRenderer.invoke('live:load'),
  meta: file => ipcRenderer.invoke('meta:get', file),
  subs: {
    search: file => ipcRenderer.invoke('subs:search', file),
    download: (file, id, lang) => ipcRenderer.invoke('subs:download', file, id, lang)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: s => ipcRenderer.invoke('settings:set', s)
  },
  info: () => ipcRenderer.invoke('info'),
  launch: a => ipcRenderer.send('launch', a),
  sys: c => ipcRenderer.send('sys', c),
  pad: m => ipcRenderer.send('pad', m),
  onNav: cb => ipcRenderer.on('nav', (_, d) => cb(d)),
  onMode: cb => ipcRenderer.on('mode', (_, m) => cb(m)),
  onXinput: cb => ipcRenderer.on('xinput', (_, v) => cb(v)),
  onHome: cb => ipcRenderer.on('home', () => cb()),
  onToast: cb => ipcRenderer.on('toast', (_, m) => cb(m)),
  onAudioOnly: cb => ipcRenderer.on('audioonly', () => cb()),
  appCtl: c => ipcRenderer.send('appctl', c),
  openApps: () => ipcRenderer.invoke('apps:open'),
  onCcOverApp: cb => ipcRenderer.on('cc-over-app', (_, b) => cb(b)),
  onOverApp: cb => ipcRenderer.on('overapp', (_, v) => cb(v)),
  onAppsOpen: cb => ipcRenderer.on('apps-open', (_, l) => cb(l))
});
