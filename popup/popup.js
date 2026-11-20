import { localize } from '../shared/i18n.js';
import { getSettings } from '../shared/settings.js';
import { iconSvg, send } from './ui.js';
import { initMedia } from './media.js';
import { initMixer } from './mixer.js';
import { initPrefs } from './prefs.js';

const settings = await getSettings();

const dark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const theme = settings.theme === 'auto' ? (dark.matches ? 'dark' : 'light') : settings.theme;
  document.documentElement.dataset.theme = theme;
}
applyTheme();
dark.addEventListener('change', applyTheme);

localize(document);
document.documentElement.lang = chrome.i18n.getUILanguage();
document.getElementById('version').textContent = `Media+ ${chrome.runtime.getManifest().version}`;

// Tabs
const tabs = [...document.querySelectorAll('.tab')];
let mixer = null;

function show(view) {
  for (const tab of tabs) {
    const on = tab.dataset.view === view;
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', String(on));
    document.getElementById(`view-${tab.dataset.view}`).hidden = !on;
  }
  try { localStorage.setItem('view', view); } catch { /* storage off */ }
  mixer?.redraw();
}

for (const tab of tabs) {
  tab.insertAdjacentHTML('afterbegin', iconSvg(tab.dataset.icon, 16));
  tab.addEventListener('click', () => show(tab.dataset.view));
}
document.getElementById('audio-live').addEventListener('click', () => show('mixer'));

let lastView = 'media';
try { lastView = localStorage.getItem('view') || 'media'; } catch { /* storage off */ }
show(['media', 'mixer', 'settings'].includes(lastView) ? lastView : 'media');

// ?tab=<id> opens the popup for a given tab (used when testing it in a regular tab).
const forcedTab = Number(new URLSearchParams(location.search).get('tab'));
const [tab] = forcedTab ? [await chrome.tabs.get(forcedTab)] : await chrome.tabs.query({ active: true, currentWindow: true });

// Companion status, filled in when the service worker answers.
const host = { installed: false, checked: false };
const hostReady = send({ type: 'host:info' })
  .then((info) => Object.assign(host, info, { checked: true }))
  .catch(() => Object.assign(host, { checked: true }));

mixer = await initMixer(tab, settings);
initMedia(tab, settings, mixer, host);
mixer.redraw();
await initPrefs(settings, host, hostReady, (key) => {
  if (key === 'theme') applyTheme();
  if (key === 'maxBoost') mixer.setMax(settings.maxBoost);
});
