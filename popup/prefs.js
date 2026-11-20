import { h, toast, send } from './ui.js';
import { t } from '../shared/i18n.js';
import { DEFAULTS, saveSettings, resetSettings, HOST_INSTALL_URL } from '../shared/settings.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const parse = (el, raw) => {
  if (el.dataset.type === 'bool') return raw === 'true';
  if (el.dataset.type === 'number') return Number(raw);
  return raw;
};

export async function initPrefs(settings, host, hostReady, onChange) {
  const speedSelect = document.getElementById('default-speed');
  speedSelect.append(...SPEEDS.map((s) => h('option', { value: String(s) }, `${s}×`)));

  const fields = [...document.querySelectorAll('[data-setting]')];
  const subfolderRow = document.getElementById('subfolder-row');

  function fill() {
    for (const el of fields) {
      const value = settings[el.dataset.setting];
      if (el.type === 'checkbox') el.checked = !!value;
      else el.value = String(value);
    }
    subfolderRow.classList.toggle('disabled', settings.saveAs);
  }

  for (const el of fields) {
    el.addEventListener('change', async () => {
      const key = el.dataset.setting;
      const value = el.type === 'checkbox' ? el.checked : parse(el, el.value.trim());
      settings[key] = value;
      await saveSettings({ [key]: value });
      subfolderRow.classList.toggle('disabled', settings.saveAs);
      onChange(key);
    });
  }

  // yt-dlp companion
  const status = document.getElementById('host-status');
  const hostAction = document.getElementById('host-action');
  const installLink = h('a', { class: 'link-btn host-install', href: HOST_INSTALL_URL, target: '_blank' }, t('hostInstall'));
  hostAction.after(installLink);
  function renderHost() {
    if (!host.checked) {
      status.textContent = t('hostChecking');
      hostAction.disabled = true;
      installLink.hidden = true;
      return;
    }
    hostAction.disabled = false;
    hostAction.textContent = t('hostCheck');
    installLink.hidden = !!host.installed;
    if (host.installed) {
      status.textContent = `yt-dlp ${host.ytdlp || '?'} · ffmpeg ${host.ffmpeg ? '✓' : '✗'}`;
      return;
    }
    const err = String(host.error || '');
    const key = /not found/i.test(err) ? 'hostMissing'
      : /forbidden/i.test(err) ? 'hostWrongId'
        : err === 'ytdlp-missing' ? 'hostNoYtdlp'
          : err === 'timeout' ? 'hostTimeout'
            : 'hostFailed';
    // Chrome's own message, so a problem can be reported precisely.
    status.replaceChildren(t(key), h('span', { class: 'host-error' }, `${err || '?'} · ID ${chrome.runtime.id}`));
  }
  hostAction.addEventListener('click', async () => {
    host.checked = false;
    renderHost();
    const info = await chrome.runtime.sendMessage({ type: 'host:info', force: true }).catch((err) => ({ installed: false, error: err.message }));
    Object.assign(host, info, { checked: true });
    renderHost();
    toast(t(host.installed ? 'hostOk' : 'hostNotFound'), host.installed ? 'info' : 'error');
  });
  renderHost();
  hostReady.then(renderHost);

  document.getElementById('open-shortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  document.getElementById('reset-settings').addEventListener('click', async () => {
    await resetSettings();
    Object.assign(settings, DEFAULTS);
    fill();
    for (const key of Object.keys(DEFAULTS)) onChange(key);
    toast(t('settingsReset'));
  });

  const commands = await chrome.commands.getAll();
  const labels = { _execute_action: t('scOpen'), screenshot: t('scShot'), 'toggle-loop': t('scLoop'), 'download-media': t('scDownload') };
  const list = document.getElementById('shortcut-list');
  const set = commands.filter((c) => c.shortcut);
  list.replaceChildren(...(set.length
    ? set.map((c) => h('span', { class: 'shortcut' }, h('kbd', {}, c.shortcut), ` ${labels[c.name] || c.description}`))
    : [t('noShortcuts')]));

  fill();
}
