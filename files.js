// Local files for the "Files" app: lists folders, videos and music on this PC. Plain Node, no Electron.
const fs = require('fs'), path = require('path');

const VIDEO = ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', '3gp', 'ogv', 'vob'];
const AUDIO = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma'];
// Formats TV's built-in player can usually play. Everything else opens in VLC (or the Windows player).
const INTERNAL = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus']);
const SKIP = /^(\$.*|\..*|System Volume Information|desktop\.ini|Thumbs\.db|ntuser\..*|pagefile\.sys|hiberfil\.sys|swapfile\.sys)$/i;

const extOf = name => path.extname(name).slice(1).toLowerCase();
function kindOf(name) {
  const e = extOf(name);
  return VIDEO.includes(e) ? 'video' : AUDIO.includes(e) ? 'audio' : null;
}

// Start screen: the usual media folders plus every drive that is ready.
function roots(places) {
  const out = [];
  for (const [name, p] of places) { try { if (p && fs.statSync(p).isDirectory()) out.push({ name, path: p, kind: 'place' }); } catch {} }
  for (let c = 67; c <= 90; c++) {           // C: .. Z:
    const d = String.fromCharCode(c) + ':\\';
    try { fs.readdirSync(d); out.push({ name: 'Drive ' + d.slice(0, 2), path: d, kind: 'drive' }); } catch {}
  }
  return out;
}

// One folder: sub-folders first, then videos and music, in natural order ("Ep 2" before "Ep 10").
async function list(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw Object.assign(new Error('bad path'), { code: 'EBADPATH' });
  dir = path.resolve(dir);
  const ents = await fs.promises.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of ents) {
    if (SKIP.test(e.name) || e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { items.push({ name: e.name, path: full, kind: 'folder' }); continue; }
    if (!e.isFile()) continue;
    const kind = kindOf(e.name); if (!kind) continue;
    let size = 0, mtime = 0;
    try { const st = await fs.promises.stat(full); size = st.size; mtime = st.mtimeMs; } catch {}
    items.push({ name: e.name, path: full, kind, size, mtime, internal: INTERNAL.has(extOf(e.name)) });
  }
  const col = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  items.sort((a, b) => (a.kind === 'folder') !== (b.kind === 'folder') ? (a.kind === 'folder' ? -1 : 1) : col.compare(a.name, b.name));
  const parent = path.dirname(dir);
  return { dir, parent: parent !== dir ? parent : null, items: items.slice(0, 3000) };
}

// Subtitles next to a video: "Movie.srt", "Movie.en.srt" or "Movie.vtt" (max 3 MB).
function subtitleFor(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const base = file.slice(0, file.length - path.extname(file).length);
  for (const cand of [base + '.srt', base + '.en.srt', base + '.eng.srt', base + '.vtt', base + '.en.vtt']) {
    try { const st = fs.statSync(cand); if (st.isFile() && st.size < 3e6) return { type: cand.endsWith('.vtt') ? 'vtt' : 'srt', text: fs.readFileSync(cand, 'utf8') }; } catch {}
  }
  return null;
}

// External player: VLC if installed, otherwise null (caller falls back to the Windows default player).
function vlcPath() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  return roots.map(r => path.join(r, 'VideoLAN', 'VLC', 'vlc.exe')).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

module.exports = { roots, list, subtitleFor, kindOf, vlcPath, INTERNAL };
