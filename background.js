import { getSettings } from './shared/settings.js';
import { buildFilename, extFromMime, extFromUrl, timecode } from './shared/files.js';
import { videoSpec } from './shared/ytdlp.js';
import { listMedia, runOp, findBySrc, pickPrimary, captureFrame, saveInFrame, bestSource } from './shared/tab.js';

const ACCENT = '#8b6cff';
const HOST = 'com.mediaplus.host';
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

// ---------- Browser downloads ----------

// Blob downloads the browser could not read get saved from the page instead.
const blobDownloads = new Map();
// Chrome download id -> yt-dlp job id.
const hostDownloads = new Map();

async function headMime(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    return res.ok ? res.headers.get('content-type') : null;
  } catch {
    return null;
  }
}

async function startDownload({ url, mime, kind, title, pageUrl, tabId, frameId, suffix, ext }) {
  const settings = await getSettings();
  ext ||= extFromMime(mime) || extFromUrl(url);
  if (!ext && /^https?:/i.test(url)) ext = extFromMime(await headMime(url));
  ext ||= kind === 'audio' ? 'mp3' : 'mp4';
  const filename = buildFilename({ title, pageUrl, ext, suffix }, settings);

  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: settings.saveAs, conflictAction: 'uniquify' });
    if (url.startsWith('blob:') && tabId != null) {
      blobDownloads.set(id, { tabId, frameId: frameId ?? 0, url, name: filename.split('/').pop() });
    }
    return { ok: true, id };
  } catch (err) {
    if (url.startsWith('blob:') && tabId != null) {
      await saveInFrame(tabId, frameId ?? 0, url, filename.split('/').pop());
      return { ok: true, fallback: true };
    }
    return { error: err.message };
  }
}

chrome.downloads.onChanged.addListener(async ({ id, state, error }) => {
  if (!state || state.current === 'in_progress') return;
  const blob = blobDownloads.get(id);
  if (blob) {
    blobDownloads.delete(id);
    if (state.current === 'interrupted' && error?.current !== 'USER_CANCELED') {
      await chrome.downloads.erase({ id }).catch(() => {});
      await saveInFrame(blob.tabId, blob.frameId, blob.url, blob.name).catch(() => {});
    }
  }
  const jobId = hostDownloads.get(id);
  if (jobId) {
    hostDownloads.delete(id);
    const ok = state.current === 'complete' || error?.current === 'USER_CANCELED';
    await finishJob(jobId, ok ? { status: 'done', canceled: state.current !== 'complete' } : { status: 'error', error: error?.current || 'download failed' });
  }
});

async function pageUrlOf(tabId) {
  try {
    return (await chrome.tabs.get(tabId)).url;
  } catch {
    return '';
  }
}

// ---------- yt-dlp companion (native messaging) ----------

let port = null;
let pings = [];
const jobs = new Map();

function hostPort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || 'disconnected';
    port = null;
    pings.forEach((p) => p.reject(new Error(error)));
    pings = [];
    for (const job of jobs.values()) {
      if (job.status === 'running') updateJob(job.id, { status: 'error', error });
    }
  });
  return port;
}

function releaseIfIdle() {
  const busy = [...jobs.values()].some((j) => j.status === 'running' || j.status === 'saving');
  if (port && !busy) {
    port.disconnect();
    port = null;
  }
}

async function hostInfo(force = false) {
  const { host } = await chrome.storage.session.get('host');
  if (!force && host?.installed && Date.now() - host.at < 60_000) return host;
  let info;
  try {
    const p = hostPort();
    const pong = await new Promise((resolve, reject) => {
      pings.push({ resolve, reject });
      p.postMessage({ cmd: 'ping', id: 'ping' });
      setTimeout(() => reject(new Error('timeout')), 15000);
    });
    info = { installed: pong.ytdlpFound !== false, ytdlp: pong.ytdlp, ffmpeg: pong.ffmpeg, at: Date.now(), error: pong.ytdlpFound === false ? 'ytdlp-missing' : null };
  } catch (err) {
    info = { installed: false, error: err.message, at: Date.now() };
  }
  await chrome.storage.session.set({ host: info });
  releaseIfIdle();
  return info;
}

async function saveJobs() {
  await chrome.storage.session.set({ jobs: [...jobs.values()] });
}

async function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  await saveJobs();
}

async function finishJob(id, patch) {
  await updateJob(id, patch);
  port?.postMessage({ cmd: 'cleanup', id });
  releaseIfIdle();
  if (patch.status === 'done') {
    setTimeout(async () => {
      jobs.delete(id);
      await saveJobs();
    }, 6000);
  }
}

async function onHostMessage(msg) {
  if (msg.type === 'pong') {
    pings.forEach((p) => p.resolve(msg));
    pings = [];
    return;
  }
  const job = jobs.get(msg.id);
  if (!job) return;
  if (msg.type === 'progress') {
    const pct = parseFloat(msg.percent);
    await updateJob(job.id, msg.stage
      ? { stage: msg.stage }
      : { pct: Number.isFinite(pct) ? pct : job.pct, speed: msg.speed || '', eta: msg.eta || '' });
  } else if (msg.type === 'error') {
    await finishJob(job.id, { status: 'error', error: msg.error });
  } else if (msg.type === 'done') {
    await updateJob(job.id, { status: 'saving', pct: 100 });
    const ext = (msg.name.match(/\.([a-z0-9]+)$/i)?.[1] || (job.format === 'mp3' ? 'mp3' : 'mp4')).toLowerCase();
    const settings = await getSettings();
    const filename = buildFilename({ title: job.title, pageUrl: job.pageUrl, ext, suffix: job.suffix }, settings);
    try {
      const downloadId = await chrome.downloads.download({ url: msg.url, filename, saveAs: settings.saveAs, conflictAction: 'uniquify' });
      hostDownloads.set(downloadId, job.id);
    } catch (err) {
      await finishJob(job.id, { status: 'error', error: err.message });
    }
  }
}

function netscapeCookies(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    const domain = c.hostOnly ? c.domain : c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
    lines.push([domain, c.hostOnly ? 'FALSE' : 'TRUE', c.path, c.secure ? 'TRUE' : 'FALSE',
      Math.round(c.expirationDate || 0), c.name, c.value].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

async function startJob({ url, pageUrl, title, format, start, end, tabId, frameId, mediaId, codec, height }) {
  const settings = await getSettings();
  const id = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const section = start != null && end > start;
  const job = {
    id, title, format, pageUrl, tabId, frameId, mediaId,
    start: section ? start : null,
    end: section ? end : null,
    suffix: section ? `${timecode(start)}-${timecode(end)}` : '',
    status: 'running', pct: 0, speed: '', eta: '', at: Date.now()
  };
  jobs.set(id, job);
  await saveJobs();

  let cookies = null;
  if (settings.sendCookies) {
    try {
      cookies = netscapeCookies(await chrome.cookies.getAll({ url: pageUrl }));
    } catch { /* no cookies */ }
  }
  hostPort().postMessage({
    cmd: 'download', id, url, format,
    ...videoSpec({ codec: codec ?? settings.codec, height: height ?? settings.maxHeight }),
    start: job.start, end: job.end,
    cookies
  });
  return { ok: true, via: 'ytdlp', jobId: id };
}

const jobOps = {
  async cancel({ id }) {
    const job = jobs.get(id);
    if (!job) return;
    port?.postMessage({ cmd: 'cancel', id });
    port?.postMessage({ cmd: 'cleanup', id });
    jobs.delete(id);
    await saveJobs();
    releaseIfIdle();
  },
  async dismiss({ id }) {
    jobs.delete(id);
    await saveJobs();
  }
};

// ---------- One download entry point ----------

// Simple files go through Chrome; streamed media, MP3 and extracts through yt-dlp.
// When neither can do it, the caller is told so (`canRecord`) and offers to record the
// media while it plays; `allowRecord` (shortcuts) records straight away.
async function downloadMedia({ tabId, frameId, id, format = 'mp4', start = null, end = null, forceRecord = false, allowRecord = false, codec = null, height = null }) {
  const settings = await getSettings();
  codec ??= settings.codec;
  height ??= settings.maxHeight;
  const resolved = await runOp(tabId, frameId, id, 'resolve');
  const section = start != null && end > start;
  const pageUrl = resolved.page && /^https?:/.test(resolved.page) ? resolved.page : await pageUrlOf(tabId);
  const directUrl = resolved.type === 'url' && /^https?:/i.test(resolved.url) ? resolved.url : null;

  const record = async () => {
    await runOp(tabId, frameId, id, 'record', { start: section ? start : null, end: section ? end : null, audioOnly: format === 'mp3', fromStart: !section });
    return { ok: true, via: 'record' };
  };

  if (forceRecord) return record();

  // A plain file is saved by Chrome as it is, unless a codec or resolution was asked for.
  if (resolved.type === 'url' && format === 'mp4' && !section && codec === 'auto' && !height) {
    return { ...(await startDownload({ ...resolved, tabId, frameId, pageUrl })), via: 'browser' };
  }

  let reason = 'engineBrowser';
  if (settings.engine !== 'browser') {
    const host = await hostInfo(true);
    const target = directUrl || (/^https?:/i.test(pageUrl) ? pageUrl : null);
    if (host.installed && target) {
      return startJob({ url: target, pageUrl, title: resolved.title, format, start, end, tabId, frameId, mediaId: id, codec, height });
    }
    reason = host.installed ? 'noTarget' : 'noHost';
  }
  if (allowRecord) return record();
  return { canRecord: true, reason };
}

async function downloadShot({ dataUrl, format, title, time, tabId }) {
  const ext = format === 'jpeg' ? 'jpg' : format;
  return startDownload({ url: dataUrl, title, ext, suffix: timecode(time), pageUrl: await pageUrlOf(tabId) });
}

async function screenshot(tab, media) {
  const settings = await getSettings();
  const shot = await captureFrame(tab, media, settings.shotFormat);
  return downloadShot({ ...shot, format: settings.shotFormat, tabId: tab.id });
}

// ---------- Audio engine (offscreen document) ----------

let creating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Process the audio of a tab (volume boost and equalizer).'
    })
    .finally(() => { creating = null; });
  await creating;
}

const toEngine = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
const audioKey = (tabId) => `audio:${tabId}`;

async function setAudioBadge(tabId, state) {
  const text = state ? (state.boost !== 100 ? String(state.boost) : 'EQ') : '';
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (state) await chrome.action.setBadgeBackgroundColor({ tabId, color: ACCENT }).catch(() => {});
}

async function clearAudio(tabId, remaining) {
  await chrome.storage.session.remove(audioKey(tabId));
  await setAudioBadge(tabId, null);
  if (remaining === 0 && (await hasOffscreen())) await chrome.offscreen.closeDocument().catch(() => {});
}

async function saveAudio(tabId, state) {
  await chrome.storage.session.set({ [audioKey(tabId)]: { ...state, active: true } });
  await setAudioBadge(tabId, state);
}

const audio = {
  async get({ tabId }) {
    const key = audioKey(tabId);
    const { [key]: state } = await chrome.storage.session.get(key);
    if (state && !(await hasOffscreen())) {
      await clearAudio(tabId);
      return { state: null };
    }
    return { state: state || null };
  },
  async start({ tabId, streamId, state }) {
    await ensureOffscreen();
    const res = await toEngine({ op: 'start', tabId, streamId, state });
    if (res?.error) return res;
    await saveAudio(tabId, state);
    return { ok: true };
  },
  async update({ tabId, state }) {
    if (!(await hasOffscreen())) {
      await clearAudio(tabId);
      return { restart: true };
    }
    const res = await toEngine({ op: 'update', tabId, state });
    if (res?.missing) {
      await clearAudio(tabId);
      return { restart: true };
    }
    await saveAudio(tabId, state);
    return { ok: true };
  },
  async stop({ tabId }) {
    const res = (await hasOffscreen()) ? await toEngine({ op: 'stop', tabId }) : { remaining: 0 };
    await clearAudio(tabId, res?.remaining);
    return { ok: true };
  }
};

// ---------- Messages ----------

const handlers = {
  download: (msg, sender) =>
    startDownload({
      ...msg,
      tabId: msg.tabId ?? sender.tab?.id,
      frameId: msg.frameId ?? sender.frameId,
      pageUrl: msg.pageUrl || sender.tab?.url || ''
    }),
  'media:download': downloadMedia,
  'shot:download': downloadShot,
  'host:info': ({ force }) => hostInfo(force),
  'job:cancel': jobOps.cancel,
  'job:dismiss': jobOps.dismiss,
  'audio:get': audio.get,
  'audio:start': audio.start,
  'audio:update': audio.update,
  'audio:stop': audio.stop,
  'engine:ended': ({ tabId, remaining }) => clearAudio(tabId, remaining)
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler(msg, sender))
    .then((res) => sendResponse(res ?? { ok: true }), (err) => sendResponse({ error: err?.message || String(err) }));
  return true;
});

// ---------- Shortcuts & context menu ----------

async function flash(tabId, text) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: ACCENT }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  setTimeout(async () => {
    const res = await audio.get({ tabId }).catch(() => null);
    await setAudioBadge(tabId, res?.state || null);
  }, 1500);
}

async function runAction(action, tab, media) {
  if (!media) return flash(tab.id, '-');
  try {
    if (action === 'loop') {
      const info = await runOp(tab.id, media.frameId, media.id, 'loop', !media.loop);
      return flash(tab.id, info.loop ? 'ON' : 'OFF');
    }
    if (action === 'shot') {
      await screenshot(tab, media);
      return flash(tab.id, 'OK');
    }
    if (action === 'download') {
      const res = await downloadMedia({ tabId: tab.id, frameId: media.frameId, id: media.id, allowRecord: true });
      return flash(tab.id, res.error ? 'ERR' : res.via === 'record' ? 'REC' : 'OK');
    }
    if (action === 'source') {
      const resolved = await runOp(tab.id, media.frameId, media.id, 'resolve');
      const url = bestSource(resolved);
      if (!url) return flash(tab.id, '-');
      await chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
    }
  } catch {
    await flash(tab.id, 'ERR');
  }
}

const COMMANDS = { screenshot: 'shot', 'toggle-loop': 'loop', 'download-media': 'download' };

chrome.commands.onCommand.addListener(async (command, tab) => {
  const action = COMMANDS[command];
  if (!action) return;
  tab ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab?.id) return;
  const list = await listMedia(tab.id).catch(() => []);
  await runAction(action, tab, pickPrimary(action === 'shot' ? list.filter((m) => m.kind === 'video') : list));
});

const MENU = [
  { id: 'download', title: 'menuDownload', contexts: ['video', 'audio'] },
  { id: 'shot', title: 'menuScreenshot', contexts: ['video'] },
  { id: 'loop', title: 'menuLoop', contexts: ['video', 'audio'] },
  { id: 'source', title: 'menuSource', contexts: ['video', 'audio'] }
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU) chrome.contextMenus.create({ id: item.id, title: t(item.title), contexts: item.contexts });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const frameId = info.frameId ?? 0;
  const id = info.srcUrl ? await findBySrc(tab.id, frameId, info.srcUrl).catch(() => null) : null;
  if (id == null) {
    if (/^https?:/i.test(info.srcUrl || '')) {
      if (info.menuItemId === 'download') await startDownload({ url: info.srcUrl, kind: info.mediaType, title: tab.title, pageUrl: tab.url });
      if (info.menuItemId === 'source') await chrome.tabs.create({ url: info.srcUrl, index: tab.index + 1, openerTabId: tab.id });
    }
    return;
  }
  const list = await listMedia(tab.id).catch(() => []);
  const media = list.find((m) => m.frameId === frameId && m.id === id);
  await runAction(info.menuItemId, tab, media);
});
