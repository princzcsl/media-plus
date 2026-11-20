export const DEFAULTS = Object.freeze({
  saveAs: true,
  subfolder: '',
  naming: 'title',
  engine: 'auto',
  codec: 'auto',
  maxHeight: 0,
  sendCookies: false,
  shotFormat: 'png',
  shotAction: 'download',
  defaultSpeed: 1,
  preservePitch: true,
  maxBoost: 600,
  rememberMixer: 'global',
  theme: 'auto'
});

export async function getSettings() {
  const stored = await chrome.storage.sync.get([...Object.keys(DEFAULTS), 'quality']);
  // 1.x "Compatible" quality is the H.264 codec now.
  if (!stored.codec && stored.quality === 'compat') stored.codec = 'h264';
  delete stored.quality;
  return { ...DEFAULTS, ...stored };
}

export const saveSettings = (patch) => chrome.storage.sync.set(patch);

export const resetSettings = () => chrome.storage.sync.remove(Object.keys(DEFAULTS));

export async function getCustomPresets() {
  const { presets = [] } = await chrome.storage.sync.get('presets');
  return Array.isArray(presets) ? presets : [];
}

export const saveCustomPresets = (presets) => chrome.storage.sync.set({ presets });

export const HOST_INSTALL_URL = 'https://github.com/princzcsl/media-plus#yt-dlp-companion';
