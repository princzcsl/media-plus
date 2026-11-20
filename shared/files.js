const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/x-mpegurl': 'm3u8',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/dash+xml': 'mpd'
};

const KNOWN_EXT = new Set(Object.values(MIME_EXT).concat(['m4v', 'jpeg']));

export function extFromMime(mime) {
  if (!mime) return null;
  return MIME_EXT[mime.split(';')[0].trim().toLowerCase()] || null;
}

export function extFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    const ext = match?.[1].toLowerCase();
    return ext && KNOWN_EXT.has(ext) ? ext : null;
  } catch {
    return null;
  }
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function sanitize(name, max = 100) {
  let out = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!out || RESERVED.test(out)) out = `media${out ? `_${out}` : ''}`;
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

export function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export function timecode(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  return `${h ? `${h}h` : ''}${pad(Math.floor((s % 3600) / 60))}m${pad(s % 60)}s`;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// Relative path handed to chrome.downloads ("Media+/Title.mp4" in direct mode).
export function buildFilename({ title, pageUrl, ext, suffix = '' }, settings) {
  const base = settings.naming === 'site-date' || !title
    ? `${hostOf(pageUrl) || 'media'}_${stamp()}`
    : title;
  const name = `${sanitize(base)}${suffix ? `_${suffix}` : ''}.${ext}`;
  const folder = !settings.saveAs && settings.subfolder
    ? settings.subfolder.split(/[\\/]+/).map((part) => sanitize(part, 60)).filter(Boolean).join('/')
    : '';
  return folder ? `${folder}/${name}` : name;
}
