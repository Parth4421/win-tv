// TV's media engine: a private local server (127.0.0.1 + random key) that lets the built-in player play
// any movie. Files the player supports stream straight from disk; Dolby/DTS/TrueHD sound or several audio
// languages are converted to AAC on the fly with ffmpeg while the picture is copied untouched.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');

function bin(mod) { try { const p = require(mod).path.replace('app.asar', 'app.asar.unpacked'); return fs.existsSync(p) ? p : null; } catch { return null; } }
const FFMPEG = bin('@ffmpeg-installer/ffmpeg'), FFPROBE = bin('@ffprobe-installer/ffprobe');
const BROWSER_V = new Set(['h264', 'vp8', 'vp9', 'av1', 'hevc']);
const BROWSER_A = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
// Picture-based subtitles (Blu-ray / DVD rips): drawn into the picture while streaming
const IMAGE_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
const TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg' };

const run = (exe, args, max = 20e6) => new Promise((res, rej) =>
  execFile(exe, args, { windowsHide: true, maxBuffer: max }, (e, out) => e ? rej(e) : res(out)));
const tag = (s, k) => (s.tags && (s.tags[k] || s.tags[k.toUpperCase()])) || '';

// What's inside a file: duration, picture codec, every audio language and subtitle track.
// Results are remembered (per file version) so re-opening a movie is instant.
const probeCache = new Map();
async function probe(file) {
  const st = fs.statSync(file), key = file + '|' + st.size + '|' + st.mtimeMs;
  if (probeCache.has(key)) return probeCache.get(key);
  const r = await probeRaw(file);
  probeCache.set(key, r); if (probeCache.size > 300) probeCache.delete(probeCache.keys().next().value);
  return r;
}
async function probeRaw(file) {
  const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const st = j.streams || [], fmt = j.format || {};
  const v = st.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = st.filter(s => s.codec_type === 'audio').map((s, n) => ({ n, codec: s.codec_name, lang: tag(s, 'language'), title: tag(s, 'title'),
    ch: s.channels || 0, def: !!(s.disposition && s.disposition.default) }));
  const subs = st.filter(s => s.codec_type === 'subtitle').map((s, n) => ({ n, codec: s.codec_name, lang: tag(s, 'language'), title: tag(s, 'title'),
    forced: !!(s.disposition && s.disposition.forced), text: TEXT_SUBS.has(s.codec_name), image: IMAGE_SUBS.has(s.codec_name) }));
  const container = String(fmt.format_name || '');
  const vcopy = !v || BROWSER_V.has(v.codec_name);
  const direct = /mp4|mov|webm|matroska|mp3|flac|ogg|wav|aac/.test(container) && vcopy &&
    audio.length <= 1 && (audio.length === 0 || BROWSER_A.has(audio[0].codec));
  return { duration: +fmt.duration || +(v && v.duration) || 0, container, video: v ? { codec: v.codec_name, w: v.width, h: v.height } : null,
    audio, subs, vcopy, direct };
}

// Last keyframe at or before t, so a converted stream starts exactly where the picture can start.
async function keyframe(file, t) {
  if (!(t > 0)) return 0;
  try {
    const out = await run(FFPROBE, ['-v', 'error', '-select_streams', 'V:0', '-skip_frame', 'nokey', '-read_intervals', `${Math.max(0, t - 20)}%${t + 0.5}`,
      '-show_entries', 'frame=pts_time,best_effort_timestamp_time', '-of', 'csv=p=0', file]);
    let best = -1;
    for (const line of out.split(/\r?\n/)) { const x = line.split(',').map(Number).find(n => isFinite(n)); if (isFinite(x) && x <= t + 0.01 && x > best) best = x; }
    return best >= 0 ? best : t;
  } catch { return t; }
}

function serveFile(req, res, file) {
  const st = fs.statSync(file), size = st.size, type = TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (m) {
    let start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? +m[2] : size - 1;
    if (!(start >= 0) || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...head }); return res.end(); }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else { res.writeHead(200, { ...head, 'Content-Length': size }); fs.createReadStream(file).pipe(res); }
}

// Live stream: picture copied (or converted to H.264 only if the player can't show it), chosen audio
// language converted to AAC stereo, packed as fragmented MP4 that plays while it is being made.
// burn >= 0: draw that picture-subtitle track into the image (needs re-encoding the picture).
// sync (ms): audio sync correction. Positive = sound later, negative = sound earlier. Read from a second copy
// of the file with shifted timestamps, so picture and sound stay locked together after seeks.
function stream(req, res, file, a, t, vcopy, hevc, burn, night, sync) {
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'film', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '48'];
  const video = burn >= 0
    ? ['-filter_complex', `[0:V:0][0:s:${burn}]overlay=(W-w)/2:H-h[v]`, '-map', '[v]', ...enc]
    : ['-map', '0:V:0?', ...(vcopy ? ['-c:v', 'copy', ...(hevc ? ['-tag:v', 'hvc1'] : [])] : enc)];
  const shift = Math.max(-2000, Math.min(2000, Math.round(sync || 0))) / 1000;
  const inputs = ['-ss', String(t), '-i', file, ...(shift ? ['-itsoffset', String(shift), '-ss', String(t), '-i', file] : [])];
  const args = ['-hide_banner', '-loglevel', 'error', ...inputs, ...video, '-map', `${shift ? 1 : 0}:a:${a}?`, '-sn', '-dn',
    // Night mode: compress loud peaks and lift quiet dialogue (done here so sound stays in sync with the picture)
    ...(night ? ['-af', 'acompressor=threshold=0.06:ratio=5:attack=5:release=250:makeup=3,alimiter=limit=0.9'] : []),
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-avoid_negative_ts', 'make_zero',
    // small fragments so playback starts (and resumes after a seek) quickly
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', 'pipe:1'];
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  const p = spawn(FFMPEG, args, { windowsHide: true });
  p.stdout.pipe(res); p.stderr.on('data', () => {}); p.on('error', () => res.end());
  p.on('exit', () => res.end());
  res.on('close', () => { try { p.kill(); } catch {} });
}

// Embedded subtitle track -> WebVTT text (cached, because the whole file has to be read once).
let cacheDir = null;
function subtitle(file, n) {
  return new Promise(resolve => {
    const st = fs.statSync(file);
    const key = crypto.createHash('sha1').update(file + '|' + st.size + '|' + st.mtimeMs + '|' + n).digest('hex');
    const cached = cacheDir && path.join(cacheDir, key + '.vtt');
    if (cached && fs.existsSync(cached)) return resolve(fs.readFileSync(cached, 'utf8'));
    let out = '';
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:s:${n}`, '-f', 'webvtt', 'pipe:1'], { windowsHide: true });
    p.stdout.on('data', d => { out += d; }); p.on('error', () => resolve(''));
    p.on('exit', () => { if (out && cached) { try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cached, out); } catch {} } resolve(out); });
  });
}

// ---- Live TV: an IPTV channel (HLS / HTTP stream) repackaged for the player, sound converted to AAC ----
function live(req, res, src, night) {
  const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TV/2.5',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', src,
    '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn', '-c:v', 'copy',
    ...(night ? ['-af', 'acompressor=threshold=0.06:ratio=5:attack=5:release=250:makeup=3,alimiter=limit=0.9'] : []),
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', 'pipe:1'];
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  const p = spawn(FFMPEG, args, { windowsHide: true });
  p.stdout.pipe(res); p.stderr.on('data', () => {}); p.on('error', () => res.end()); p.on('exit', () => res.end());
  res.on('close', () => { try { p.kill(); } catch {} });
}

// ---- M3U playlists (IPTV channel lists) ----
function parseM3U(text) {
  const out = []; let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      const attr = k => { const m = line.match(new RegExp(k + '="([^"]*)"', 'i')); return m ? m[1] : ''; };
      cur = { name: line.slice(line.lastIndexOf(',') + 1).trim() || attr('tvg-name') || 'Channel', logo: attr('tvg-logo'), group: attr('group-title') || 'Channels' };
    } else if (line && !line.startsWith('#') && cur) {
      if (/^https?:\/\//i.test(line)) out.push({ ...cur, url: line });
      cur = null;
    }
    if (out.length >= 5000) break;
  }
  return out;
}
async function loadPlaylists(sources) {
  const channels = [], errors = [];
  for (const s of (sources || []).slice(0, 20)) {
    try {
      let text;
      if (/^https?:\/\//i.test(s)) { const r = await fetch(s, { headers: { 'User-Agent': 'TV/2.5' } }); if (!r.ok) throw new Error('HTTP ' + r.status); text = await r.text(); }
      else { if (!path.isAbsolute(s)) throw new Error('bad path'); text = fs.readFileSync(s, 'utf8'); }
      const list = parseM3U(text); if (!list.length) throw new Error('no channels');
      channels.push(...list);
    } catch (e) { errors.push({ source: s, error: e.message }); }
  }
  return { channels: channels.slice(0, 5000), errors };
}

// ---- Movie info from TMDB (only when the user has added their own free key) ----
function parseName(file) {
  const base = path.basename(file, path.extname(file)).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const ep = base.match(/^(.*?)\s*[-\s]?\s*S(\d{1,2})\s*E(\d{1,3})/i) || base.match(/^(.*?)\s*(\d{1,2})x(\d{2})\b/);
  if (ep) return { type: 'tv', title: ep[1].replace(/[-\s]+$/, '').trim(), season: +ep[2], episode: +ep[3] };
  const y = base.match(/^(.*?)\s*\(?\b((?:19|20)\d\d)\b/);
  if (y && y[1].trim()) return { type: 'movie', title: y[1].replace(/[-(\s]+$/, '').trim(), year: +y[2] };
  return { type: 'movie', title: cleanName(file) };
}
async function tmdb(key, p) {
  const bearer = /^eyJ/.test(key), url = 'https://api.themoviedb.org/3' + p + (bearer ? '' : (p.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key));
  const r = await fetch(url, { headers: bearer ? { Authorization: 'Bearer ' + key, Accept: 'application/json' } : { Accept: 'application/json' } });
  if (r.status === 401) throw new Error('The movie-info key was not accepted.');
  if (!r.ok) throw new Error('Movie info is not reachable right now.');
  return r.json();
}
async function movieInfo(key, file) {
  const n = parseName(file), img = (p, s) => p ? 'https://image.tmdb.org/t/p/' + s + p : '';
  if (n.type === 'tv') {
    const s = await tmdb(key, '/search/tv?query=' + encodeURIComponent(n.title));
    const show = (s.results || [])[0]; if (!show) return { found: false };
    let ep = {}; try { ep = await tmdb(key, `/tv/${show.id}/season/${n.season}/episode/${n.episode}`); } catch {}
    return { found: true, type: 'tv', title: show.name, year: (show.first_air_date || '').slice(0, 4), rating: show.vote_average || 0,
      overview: ep.overview || show.overview || '', episode: `S${n.season} E${n.episode}` + (ep.name ? ' · ' + ep.name : ''),
      poster: img(show.poster_path, 'w342'), backdrop: img(ep.still_path || show.backdrop_path, 'w780') };
  }
  const q = '/search/movie?query=' + encodeURIComponent(n.title) + (n.year ? '&year=' + n.year : '');
  const s = await tmdb(key, q), m = (s.results || [])[0]; if (!m) return { found: false };
  return { found: true, type: 'movie', title: m.title, year: (m.release_date || '').slice(0, 4), rating: m.vote_average || 0, overview: m.overview || '',
    poster: img(m.poster_path, 'w342'), backdrop: img(m.backdrop_path, 'w780') };
}

// ---- Thumbnails: one frame from about 10% into the video, cached as a small JPEG ----
let thumbDir = null; const thumbQueue = []; let thumbBusy = 0; const thumbWait = new Map();
function thumb(file) {
  const st = fs.statSync(file);
  const out = path.join(thumbDir, crypto.createHash('sha1').update(file + '|' + st.size + '|' + st.mtimeMs).digest('hex') + '.jpg');
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (thumbWait.has(out)) return thumbWait.get(out);
  const p = new Promise(resolve => thumbQueue.push({ file, out, resolve }));
  thumbWait.set(out, p); pumpThumbs(); return p;
}
function pumpThumbs() {
  while (thumbBusy < 2 && thumbQueue.length) {
    const job = thumbQueue.shift(); thumbBusy++;
    (async () => {
      let ok = false;
      try {
        let d = 0; try { d = (await probe(job.file)).duration; } catch {}
        const at = d > 0 ? Math.min(Math.max(d * 0.1, 3), 600) : 3;
        fs.mkdirSync(thumbDir, { recursive: true });
        await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', job.file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', job.out]);
        ok = fs.existsSync(job.out);
      } catch {}
      thumbBusy--; thumbWait.delete(job.out); job.resolve(ok ? job.out : null); pumpThumbs();
    })();
  }
}

// ---- OpenSubtitles (needs the user's free API key) ----
function movieHash(file) {
  const size = fs.statSync(file).size, CH = 65536;
  if (size < CH * 2) return null;
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(CH * 2);
  try { fs.readSync(fd, buf, 0, CH, 0); fs.readSync(fd, buf, CH, CH, size - CH); } finally { fs.closeSync(fd); }
  let h = BigInt(size);
  for (let i = 0; i < buf.length; i += 8) h = (h + buf.readBigUInt64LE(i)) & 0xFFFFFFFFFFFFFFFFn;
  return h.toString(16).padStart(16, '0');
}
const OS = 'https://api.opensubtitles.com/api/v1';
const osHead = key => ({ 'Api-Key': key, 'User-Agent': 'TV v2.1', 'Content-Type': 'application/json', Accept: 'application/json' });
function cleanName(file) {
  return path.basename(file, path.extname(file)).replace(/[._]+/g, ' ')
    .replace(/\b(19|20)\d\d\b.*$/, m => m.slice(0, 4)).replace(/\b(1080p|720p|2160p|4k|x264|x265|hevc|web(-?dl)?|bluray|hdrip|brrip|dvdrip|aac|ddp?5 ?1|hindi|english|dual audio)\b.*$/i, '').trim();
}
async function osSearch(key, file, langs) {
  const q = new URLSearchParams({ languages: langs || 'en,hi', query: cleanName(file) });
  const h = movieHash(file); if (h) q.set('moviehash', h);
  const r = await fetch(`${OS}/subtitles?${q}`, { headers: osHead(key) });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'The OpenSubtitles key was not accepted.' : 'OpenSubtitles is not reachable right now.');
  const j = await r.json();
  return (j.data || []).slice(0, 10).map(d => { const a = d.attributes || {}, f = (a.files || [])[0] || {};
    return { id: f.file_id, lang: a.language || '', name: a.release || f.file_name || 'Subtitles', downloads: a.download_count || 0, exact: !!a.moviehash_match }; })
    .filter(x => x.id);
}
async function osDownload(key, file, id, lang) {
  const r = await fetch(`${OS}/download`, { method: 'POST', headers: osHead(key), body: JSON.stringify({ file_id: id }) });
  if (!r.ok) throw new Error(r.status === 406 ? 'Daily download limit reached. Try again tomorrow.' : 'Download failed.');
  const j = await r.json(); if (!j.link) throw new Error('Download failed.');
  const text = await (await fetch(j.link)).text();
  const base = file.slice(0, file.length - path.extname(file).length);
  const target = base + (lang && lang !== 'en' ? '.' + lang : '.en') + '.srt';
  try { fs.writeFileSync(target, text); } catch {}
  return { text, saved: path.basename(target) };
}

// ---- server ----
function start({ isMedia, cache, thumbs }) {
  cacheDir = cache; thumbDir = thumbs || path.join(cache, '..', 'thumbs');
  const token = crypto.randomBytes(16).toString('hex');
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), q = u.searchParams;
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range' }); return res.end(); }
    const file = q.get('f') || '';
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
    try {
      if (q.get('k') !== token) return json(403, { error: 'forbidden' });
      if (u.pathname === '/live') {
        const src = q.get('u') || '';
        if (!/^https?:\/\//i.test(src)) return json(400, { error: 'bad url' });
        return live(req, res, src, q.get('night') === '1');
      }
      if (!path.isAbsolute(file) || !fs.statSync(file).isFile() || !isMedia(file)) return json(404, { error: 'not found' });
      switch (u.pathname) {
        case '/probe': return json(200, await probe(file));
        case '/kf': return json(200, { t: await keyframe(file, +q.get('t') || 0) });
        case '/file': return serveFile(req, res, file);
        case '/stream': return stream(req, res, file, +q.get('a') || 0, +q.get('t') || 0, q.get('vcopy') !== '0', q.get('hevc') === '1',
          q.has('burn') ? +q.get('burn') : -1, q.get('night') === '1', +q.get('sync') || 0);
        case '/thumb': {
          const img = await thumb(file);
          if (!img) return json(404, { error: 'no thumbnail' });
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=86400' });
          return fs.createReadStream(img).pipe(res);
        }
        case '/sub': { const t = await subtitle(file, +q.get('s') || 0); res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); return res.end(t); }
        default: return json(404, { error: 'not found' });
      }
    } catch (e) { if (!res.headersSent) json(500, { error: 'could not read this file' }); else res.end(); }
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, token, ok: !!(FFMPEG && FFPROBE) })));
}

module.exports = { start, probe, keyframe, movieHash, osSearch, osDownload, cleanName, parseM3U, loadPlaylists, parseName, movieInfo, FFMPEG, FFPROBE };
