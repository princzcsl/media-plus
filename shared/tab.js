// Talks to the content agent through chrome.scripting, so each call reaches
// exactly the frame that holds the media and returns its result directly.

async function execAll(tabId, func, args = []) {
  return chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
}

// Frames running an older agent (tab opened before an update) answer null and get the new one.
const listFn = (opts, version) => (globalThis.__mediaPlus?.version === version ? globalThis.__mediaPlus.list(opts) : null);
const VERSION = chrome.runtime.getManifest().version;
// Injection is tried once per tab: frames that refuse scripts (sandboxed) would otherwise retry at every poll.
const injected = new Set();

export async function listMedia(tabId, opts = {}) {
  let results = await execAll(tabId, listFn, [opts, VERSION]);
  if (results.some((r) => r.result == null) && !injected.has(tabId)) {
    injected.add(tabId);
    // Tabs opened before the extension was installed or updated.
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }).catch(() => {});
    results = await execAll(tabId, listFn, [opts, VERSION]);
  }
  return results
    .filter((r) => r.result)
    .flatMap((r) => r.result.media.map((m) => ({ ...m, frameId: r.frameId, key: `${r.frameId}:${m.id}` })));
}

export async function runOp(tabId, frameId, id, op, arg = null) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (id, op, arg) => globalThis.__mediaPlus?.run(id, op, arg) ?? { error: 'noAgent' },
    args: [id, op, arg]
  });
  const out = res?.result;
  if (!out) throw new Error('gone');
  if (out.error) throw new Error(out.error);
  return out;
}

export async function findBySrc(tabId, frameId, src) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (src) => globalThis.__mediaPlus?.findBySrc(src) ?? null,
    args: [src]
  });
  return res?.result ?? null;
}

export async function toggleTab(tabId) {
  const results = await execAll(tabId, () => globalThis.__mediaPlus?.toggleAll() ?? null);
  return results.map((r) => r.result).find(Boolean) || null;
}

export async function saveInFrame(tabId, frameId, url, filename) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (url, filename) => globalThis.__mediaPlus?.save(url, filename),
    args: [url, filename]
  });
}

// The media the user most likely means: playing first, then the biggest on screen.
export function pickPrimary(list) {
  const score = (m) => (m.paused ? 0 : 1e9) + (m.kind === 'video' ? 1e8 : 0) + m.area;
  return [...list].sort((a, b) => score(b) - score(a))[0] || null;
}

// URL to open for "Open source": the file itself, else the manifest or stream the player fetched.
export function bestSource(resolved) {
  if (resolved.type === 'url') return resolved.url;
  const streams = resolved.streams || [];
  return (streams.find((s) => s.kind === 'manifest') || streams.find((s) => s.kind === 'video') || streams[0])?.url || null;
}

export async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

// Frame of a video as a data URL. Protected (cross-origin) videos are cropped from a
// capture of the visible tab instead.
export async function captureFrame(tab, media, format = 'png') {
  const shot = await runOp(tab.id, media.frameId, media.id, 'shot', { format, quality: 0.92 });
  if (!shot.tainted) return shot;

  const full = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(full)).blob());
  const scale = bitmap.width / shot.viewport;
  const { x, y, w, h } = shot.rect;
  const canvas = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
  canvas.getContext('2d').drawImage(bitmap, x * scale, y * scale, w * scale, h * scale, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: 0.92 });
  return { ...shot, dataUrl: await blobToDataUrl(blob), width: canvas.width, height: canvas.height };
}
