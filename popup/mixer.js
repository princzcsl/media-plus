import { h, toast, send, paintRange, setIcon } from './ui.js';
import { t } from '../shared/i18n.js';
import { BANDS, BELL, EQ_RANGE, PITCH_RANGE, bandLabel, PRESETS, freshState, isNeutral, matchesPreset, cleanState, fitEq, clampDb } from '../shared/audio.js';
import { eqCache } from '../shared/curve.js';
import { getCustomPresets, saveCustomPresets } from '../shared/settings.js';

const MAX_CUSTOM = 12;
const CURVE_POINTS = 180;
const DB_SPAN = 18;
const SPECTRUM_MS = 50;

// Position on the evenly spaced band axis (0..7) for a frequency, and back.
function freqAt(u) {
  const last = BANDS.length - 1;
  if (u <= 0) return BANDS[0] * 2 ** (u * 1.3);
  if (u >= last) return BANDS[last] * 2 ** ((u - last) * 0.6);
  const i = Math.floor(u);
  return BANDS[i] * (BANDS[i + 1] / BANDS[i]) ** (u - i);
}

function uAt(f) {
  const last = BANDS.length - 1;
  if (f <= BANDS[0]) return Math.log2(f / BANDS[0]) / 1.3;
  if (f >= BANDS[last]) return last + Math.log2(f / BANDS[last]) / 0.6;
  const i = BANDS.findIndex((b) => b > f) - 1;
  return i + Math.log2(f / BANDS[i]) / Math.log2(BANDS[i + 1] / BANDS[i]);
}

function captureError(err) {
  const msg = err?.message || String(err);
  if (/active stream/i.test(msg)) return t('errCaptureBusy');
  if (/chrome|cannot be captured|not allowed|invoked/i.test(msg)) return t('errCapture');
  return `${t('errGeneric')} ${msg}`;
}

const siteOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

export async function initMixer(tab, settings) {
  const $ = (id) => document.getElementById(id);
  const saved = (await send({ type: 'audio:get', tabId: tab.id }).catch(() => null))?.state;
  const state = cleanState(saved);
  let active = !!saved;
  let custom = (await getCustomPresets()).map((p) => ({ ...p, eq: fitEq(p.eq) }));
  const listeners = new Set();
  const site = siteOf(tab.url);

  const live = $('audio-live');
  const enabledEl = $('mixer-enabled');
  // On / off is remembered per site and off on a site never seen. It only acts on this tab:
  // a tab already being processed keeps going until its own switch is turned off.
  const { mixerSites = {} } = await chrome.storage.local.get('mixerSites');
  let enabled = active || (site ? mixerSites[site] === true : false);
  async function saveEnabled() {
    if (!site) return;
    const { mixerSites: sites = {} } = await chrome.storage.local.get('mixerSites');
    if (enabled) sites[site] = true;
    else delete sites[site];
    await chrome.storage.local.set({ mixerSites: sites });
  }
  const boost = $('boost');
  const boostValue = $('boost-value');
  const canvas = $('eq-curve');

  // ---- Remembered settings (per site or global) ----

  const memoryKey = () => (settings.rememberMixer === 'site' ? (site ? `mixer:site:${site}` : null) : settings.rememberMixer === 'global' ? 'mixer:global' : null);

  // Saved right away (a closing popup would cancel a delayed save). The volume is never
  // kept: every new tab starts at 100 %, the site's own sound.
  function remember() {
    const key = memoryKey();
    if (!key) return;
    const kept = { ...cleanState(state), boost: 100 };
    if (isNeutral(kept)) chrome.storage.local.remove(key);
    else chrome.storage.local.set({ [key]: kept });
  }

  // ---- Sync with the audio engine (one request in flight, latest state wins) ----

  let busy = false;
  let dirty = false;

  async function sync() {
    const snapshot = structuredClone(state);
    if (!enabled || isNeutral(snapshot)) {
      if (active) {
        await send({ type: 'audio:stop', tabId: tab.id });
        active = false;
      }
      return;
    }
    if (active) {
      const res = await send({ type: 'audio:update', tabId: tab.id, state: snapshot });
      if (!res?.restart) return;
      active = false;
    }
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (err) {
      // Already captured by our engine (popup state was lost): just update it.
      if (/active stream/i.test(err?.message)) {
        const res = await send({ type: 'audio:update', tabId: tab.id, state: snapshot });
        if (!res?.restart) {
          active = true;
          return;
        }
      }
      throw err;
    }
    await send({ type: 'audio:start', tabId: tab.id, streamId, state: snapshot });
    active = true;
  }

  async function push() {
    if (busy) {
      dirty = true;
      return;
    }
    busy = true;
    try {
      do {
        dirty = false;
        await sync();
      } while (dirty);
    } catch (err) {
      toast(captureError(err), 'error');
      // Nothing is applied when the capture fails: don't show settings that aren't real.
      if (!active) {
        enabled = false;
        render();
      }
    } finally {
      busy = false;
      renderStatus();
    }
  }

  function renderStatus() {
    live.hidden = !active;
    enabledEl.checked = enabled;
    document.getElementById('view-mixer').classList.toggle('mixer-off', !enabled);
    spectrumLoop();
  }

  enabledEl.addEventListener('change', () => {
    enabled = enabledEl.checked;
    saveEnabled();
    renderStatus();
    push();
  });

  function commit({ save = true } = {}) {
    // Touching a setting while the mixer is off turns it back on.
    if (!enabled && save) {
      enabled = true;
      saveEnabled();
    }
    render();
    push();
    if (save) remember();
    listeners.forEach((fn) => fn(state));
  }

  // ---- Boost ----

  const quick = $('boost-quick');

  function setMax(max) {
    boost.max = String(max);
    $('boost-help').textContent = t('boostHelp', String(max));
    quick.replaceChildren(...[100, 150, 200, 300, 400, 600].filter((v) => v <= max).map((v) =>
      h('button', { class: 'chip', dataset: { boost: v }, onclick: () => { state.boost = v; commit(); } }, `${v} %`)));
    render();
  }

  boost.addEventListener('input', () => {
    state.boost = Number(boost.value);
    commit();
  });

  // ---- Presets ----

  const presetsEl = $('presets');
  const form = $('preset-form');
  const nameInput = $('preset-name');

  function applyPreset(p) {
    state.eq = [...p.eq];
    state.night = !!p.night;
    state.enhancer = p.enhancer || 0;
    state.bass = p.bass || 'shelf';
    commit();
  }

  function renderPresets() {
    const builtIn = PRESETS.map((p) =>
      h('button', {
        class: ['chip', matchesPreset(state, p) && 'on'],
        title: t(`presetHelp_${p.id}`),
        onclick: () => applyPreset(p)
      }, t(`preset_${p.id}`)));
    const mine = custom.map((p) =>
      h('button', { class: ['chip', matchesPreset(state, p) && 'on'], title: p.name, onclick: () => applyPreset(p) },
        p.name,
        h('span', {
          class: 'chip-x', icon: 'close', iconSize: 12, role: 'button', title: t('delete'),
          onclick: async (e) => {
            e.stopPropagation();
            custom = custom.filter((x) => x.id !== p.id);
            await saveCustomPresets(custom);
            renderPresets();
          }
        })));
    presetsEl.replaceChildren(...builtIn, ...mine);
  }

  $('preset-save').addEventListener('click', () => {
    if (custom.length >= MAX_CUSTOM) return toast(t('presetLimit', String(MAX_CUSTOM)), 'error');
    form.hidden = false;
    nameInput.value = '';
    nameInput.focus();
  });
  $('preset-cancel').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    custom = [...custom, { id: Date.now().toString(36), name, eq: [...state.eq], night: state.night, enhancer: state.enhancer, bass: state.bass }];
    await saveCustomPresets(custom);
    form.hidden = true;
    renderPresets();
    toast(t('presetSaved', name));
  });

  // ---- Equalizer ----

  const bandsEl = $('eq-bands');
  let shapeBtn = null;
  const sliders = [];
  const values = [];
  for (let i = 0; i < BANDS.length; i++) {
    const val = h('span', { class: 'band-val' });
    const slider = h('input', {
      type: 'range', class: 'range', min: -EQ_RANGE, max: EQ_RANGE, step: 0.5, value: 0,
      'aria-label': `${bandLabel(BANDS[i])} Hz`
    });
    slider.addEventListener('input', () => {
      state.eq[i] = Number(slider.value);
      commit();
    });
    slider.addEventListener('dblclick', () => {
      state.eq[i] = 0;
      commit();
    });
    sliders.push(slider);
    values.push(val);
    const band = h('div', { class: 'band' }, val, slider, h('span', { class: 'band-freq' }, bandLabel(BANDS[i])));
    // The lowest band's shape: shelf (even lift, Harman style) or bell (punch).
    if (i === 0) {
      shapeBtn = h('button', {
        class: 'shape-btn', title: t('bassShape'),
        onclick: () => { state.bass = state.bass === 'bell' ? 'shelf' : 'bell'; commit(); }
      });
      band.append(shapeBtn);
    }
    bandsEl.append(band);
  }

  $('eq-reset').addEventListener('click', () => {
    state.eq = BANDS.map(() => 0);
    state.night = false;
    state.enhancer = 0;
    commit();
  });

  const us = Float32Array.from({ length: CURVE_POINTS }, (_, k) => -0.5 + (k / (CURVE_POINTS - 1)) * BANDS.length);
  const eqFor = eqCache(48000);
  const curveFreqs = Array.from(us, freqAt);
  // Spectrum bars: 64 log bands from 30 Hz to 18 kHz (same split as the engine).
  const barU = Array.from({ length: 65 }, (_, i) => uAt(30 * 600 ** (i / 64)));
  let bars = null;

  function drawCurve() {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);

    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim();
    const tint = css.getPropertyValue('--tint').trim();
    const x = (u) => ((u + 0.5) / BANDS.length) * w;
    const y = (db) => hgt / 2 - (Math.max(-DB_SPAN, Math.min(DB_SPAN, db)) / DB_SPAN) * (hgt / 2 - 6);

    // Live spectrum behind the curve.
    if (bars) {
      g.fillStyle = `rgba(${tint}, 0.1)`;
      for (let i = 0; i < bars.length; i++) {
        const x0 = x(barU[i]);
        const x1 = x(barU[i + 1]);
        if (x1 < 0 || x0 > w) continue;
        const bh = (bars[i] / 255) * (hgt - 4);
        g.fillRect(x0, hgt - bh, Math.max(1, x1 - x0 - 1), bh);
      }
    }

    g.lineWidth = 1;
    for (const db of [-12, -6, 0, 6, 12]) {
      g.strokeStyle = `rgba(${tint}, ${db === 0 ? 0.18 : 0.06})`;
      g.beginPath();
      g.moveTo(0, Math.round(y(db)) + 0.5);
      g.lineTo(w, Math.round(y(db)) + 0.5);
      g.stroke();
    }

    const curve = eqFor(state).response(state.eq, curveFreqs);
    const line = new Path2D();
    us.forEach((u, k) => {
      if (k) line.lineTo(x(u), y(curve[k]));
      else line.moveTo(x(u), y(curve[k]));
    });
    const area = new Path2D(line);
    area.lineTo(w, y(0));
    area.lineTo(0, y(0));
    area.closePath();
    const fill = g.createLinearGradient(0, 0, 0, hgt);
    fill.addColorStop(0, `${accent}66`);
    fill.addColorStop(0.5, `${accent}10`);
    fill.addColorStop(1, `${accent}66`);
    g.fillStyle = fill;
    g.fill(area);
    g.strokeStyle = accent;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.stroke(line);

    // The filters are solved so the curve goes exactly through every slider value.
    state.eq.forEach((db, i) => {
      g.beginPath();
      g.arc(x(i), y(db), 4, 0, Math.PI * 2);
      g.fillStyle = db ? '#fff' : `rgba(${tint}, 0.4)`;
      g.fill();
      if (db) {
        g.lineWidth = 2;
        g.strokeStyle = accent;
        g.stroke();
      }
    });
  }

  // Drag on the curve: the nearest band follows the pointer.
  let dragBand = -1;
  function dragTo(e) {
    const rect = canvas.getBoundingClientRect();
    const u = ((e.clientX - rect.left) / rect.width) * BANDS.length - 0.5;
    if (dragBand < 0) dragBand = Math.max(0, Math.min(BANDS.length - 1, Math.round(u)));
    const half = rect.height / 2 - 6;
    const db = ((rect.height / 2 - (e.clientY - rect.top)) / half) * DB_SPAN;
    state.eq[dragBand] = clampDb(Math.round(db * 2) / 2);
    commit();
  }
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    dragBand = -1;
    dragTo(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (canvas.hasPointerCapture(e.pointerId)) dragTo(e);
  });
  canvas.addEventListener('pointerup', () => { dragBand = -1; });
  new ResizeObserver(drawCurve).observe(canvas);

  // Spectrum: polled from the engine only while the mixer view is on screen and processing.
  let spectrumTimer = null;
  function spectrumLoop() {
    clearTimeout(spectrumTimer);
    const visible = !$('view-mixer').hidden && document.visibilityState === 'visible';
    if (!active || !visible) {
      if (bars) {
        bars = null;
        drawCurve();
      }
      return;
    }
    chrome.runtime.sendMessage({ target: 'offscreen', op: 'spectrum', tabId: tab.id })
      .then((res) => {
        bars = res?.bars || null;
        drawCurve();
      })
      .catch(() => {})
      .finally(() => { spectrumTimer = setTimeout(spectrumLoop, SPECTRUM_MS); });
  }
  document.addEventListener('visibilitychange', spectrumLoop);

  // ---- Effects ----

  const enhancer = $('enhancer');
  const enhancerValue = $('enhancer-value');
  const normalize = $('normalize');
  const pitch = $('pitch');
  pitch.min = String(-PITCH_RANGE);
  pitch.max = String(PITCH_RANGE);
  const pitchValue = $('pitch-value');
  const vocalEl = $('vocal');
  enhancer.addEventListener('input', () => { state.enhancer = Number(enhancer.value); commit(); });
  enhancer.addEventListener('dblclick', () => { state.enhancer = 0; commit(); });
  normalize.addEventListener('change', () => { state.normalize = normalize.checked; commit(); });
  pitch.addEventListener('input', () => { state.pitch = Number(pitch.value); commit(); });
  pitch.addEventListener('dblclick', () => { state.pitch = 0; commit(); });
  for (const btn of vocalEl.querySelectorAll('button')) {
    btn.addEventListener('click', () => { state.vocal = btn.dataset.vocal; commit(); });
  }

  // ---- Output ----

  const limiter = $('limiter');
  const night = $('night');
  const mono = $('mono');
  const balance = $('balance');
  const balanceValue = $('balance-value');
  limiter.addEventListener('change', () => { state.limiter = limiter.checked; commit(); });
  night.addEventListener('change', () => { state.night = night.checked; commit(); });
  mono.addEventListener('change', () => { state.mono = mono.checked; commit(); });
  balance.addEventListener('input', () => {
    const v = Number(balance.value);
    // Snaps to the center so it's easy to put back.
    state.balance = Math.abs(v) <= 5 ? 0 : v;
    commit();
  });
  balance.addEventListener('dblclick', () => { state.balance = 0; commit(); });

  // ---- Bell (lowest band) ----

  const bellRow = $('bell-row');
  const bellFreq = $('bell-freq');
  const bellWidth = $('bell-width');
  Object.assign(bellFreq, { min: BELL.minFreq, max: BELL.maxFreq });
  Object.assign(bellWidth, { min: BELL.minWidth, max: BELL.maxWidth });
  bellFreq.addEventListener('input', () => { state.bellFreq = Number(bellFreq.value); commit(); });
  bellWidth.addEventListener('input', () => { state.bellWidth = Number(bellWidth.value); commit(); });
  bellFreq.addEventListener('dblclick', () => { state.bellFreq = BELL.freq; commit(); });
  bellWidth.addEventListener('dblclick', () => { state.bellWidth = BELL.width; commit(); });

  // ---- Render ----

  function render() {
    if (document.activeElement !== boost) boost.value = String(state.boost);
    paintRange(boost);
    boostValue.textContent = state.boost;
    boostValue.parentElement.classList.toggle('hot', state.boost > 100);
    for (const chip of quick.children) chip.classList.toggle('on', Number(chip.dataset.boost) === state.boost);

    state.eq.forEach((db, i) => {
      if (Number(sliders[i].value) !== db) sliders[i].value = String(db);
      values[i].textContent = db > 0 ? `+${db}` : String(db);
      values[i].classList.toggle('on', db !== 0);
    });

    limiter.checked = state.limiter;
    night.checked = state.night;
    if (document.activeElement !== enhancer) enhancer.value = String(state.enhancer);
    paintRange(enhancer);
    enhancerValue.textContent = state.enhancer ? `${state.enhancer} %` : t('off');
    normalize.checked = state.normalize;
    if (document.activeElement !== pitch) pitch.value = String(state.pitch);
    paintRange(pitch);
    pitchValue.textContent = state.pitch ? t('semitones', `${state.pitch > 0 ? '+' : ''}${state.pitch}`) : t('pitchNormal');
    for (const btn of vocalEl.querySelectorAll('button')) btn.classList.toggle('on', btn.dataset.vocal === state.vocal);
    setIcon(shapeBtn, state.bass === 'bell' ? 'bell' : 'shelf', 14);
    shapeBtn.classList.toggle('on', state.bass === 'bell');
    bellRow.hidden = state.bass !== 'bell';
    if (document.activeElement !== bellFreq) bellFreq.value = String(state.bellFreq);
    if (document.activeElement !== bellWidth) bellWidth.value = String(state.bellWidth);
    paintRange(bellFreq);
    paintRange(bellWidth);
    $('bell-freq-value').textContent = `${state.bellFreq} Hz`;
    $('bell-width-value').textContent = t('octaves', state.bellWidth.toFixed(1));
    shapeBtn.setAttribute('aria-label', `${t('bassShape')} : ${t(state.bass === 'bell' ? 'bassBell' : 'bassShelf')}`);
    shapeBtn.title = shapeBtn.getAttribute('aria-label');
    mono.checked = state.mono;
    if (Number(balance.value) !== state.balance && document.activeElement !== balance) balance.value = String(state.balance);
    paintRange(balance);
    balanceValue.textContent = state.balance === 0
      ? t('center')
      : `${t(state.balance < 0 ? 'left' : 'right')} ${Math.abs(state.balance)} %`;
    renderPresets();
    drawCurve();
  }

  setMax(settings.maxBoost);
  renderStatus();

  // Apply what was remembered for this site when the tab isn't processed yet.
  if (!active && enabled) {
    const key = memoryKey();
    const stored = key ? (await chrome.storage.local.get(key))[key] : null;
    if (stored && !isNeutral(cleanState(stored))) {
      Object.assign(state, cleanState(stored), { boost: state.boost });
      commit({ save: false });
      toast(t(settings.rememberMixer === 'site' ? 'mixerRestoredSite' : 'mixerRestored', site || ''));
    }
  }

  return {
    setMax,
    redraw: () => {
      drawCurve();
      spectrumLoop();
    },
    getBoost: () => state.boost,
    setBoost(v) {
      if (state.boost === v) return;
      state.boost = v;
      commit();
    },
    onChange: (fn) => listeners.add(fn)
  };
}
