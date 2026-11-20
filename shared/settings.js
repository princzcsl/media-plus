export const DEFAULTS = Object.freeze({
  saveAs: true,
  subfolder: 'Media+',
  naming: 'title',
  shotFormat: 'png',
  shotAction: 'download',
  defaultSpeed: 1,
  preservePitch: true,
  maxBoost: 600,
  theme: 'auto'
});

export async function getSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export const saveSettings = (patch) => chrome.storage.sync.set(patch);

export const resetSettings = () => chrome.storage.sync.remove(Object.keys(DEFAULTS));

export async function getCustomPresets() {
  const { presets = [] } = await chrome.storage.sync.get('presets');
  return Array.isArray(presets) ? presets : [];
}

export const saveCustomPresets = (presets) => chrome.storage.sync.set({ presets });
