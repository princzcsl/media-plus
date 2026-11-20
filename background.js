import { getSettings } from './shared/settings.js';
import { buildFilename, extFromMime, extFromUrl, timecode } from './shared/files.js';
import { listMedia, runOp, findBySrc, pickPrimary, captureFrame, saveInFrame, bestSource } from './shared/tab.js';

const ACCENT = '#7c6cff';
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

// ---------- Downloads ----------

// Blob downloads the browser could not read get saved from the page instead.
const blobDownloads = new Map();

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
  const entry = blobDownloads.get(id);
  if (!entry || !state) return;
  blobDownloads.delete(id);
  if (state.current === 'interrupted' && error?.current !== 'USER_CANCELED') {
    await chrome.downloads.erase({ id }).catch(() => {});
    await saveInFrame(entry.tabId, entry.frameId, entry.url, entry.name).catch(() => {});
  }
});

async function pageUrlOf(tabId) {
  try {
    return (await chrome.tabs.get(tabId)).url;
  } catch {
    return '';
  }
}

async function downloadMedia({ tabId, frameId, id }) {
  const resolved = await runOp(tabId, frameId, id, 'resolve');
  if (resolved.type !== 'url') return { mse: true, kind: resolved.kind, streams: resolved.streams || [] };
  return startDownload({ ...resolved, tabId, frameId, pageUrl: await pageUrlOf(tabId) });
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
      const res = await downloadMedia({ tabId: tab.id, frameId: media.frameId, id: media.id });
      if (res.mse) {
        // Segmented stream: record it in real time instead.
        await runOp(tab.id, media.frameId, media.id, 'record', {});
        return flash(tab.id, 'REC');
      }
      return flash(tab.id, res.error ? 'ERR' : 'OK');
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
