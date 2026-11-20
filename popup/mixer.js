import { h, toast, send } from './ui.js';
import { paintRange } from './media.js';
import { t } from '../shared/i18n.js';
import { BANDS, EQ_RANGE, BAND_Q, bandType, bandLabel, PRESETS, freshState, isNeutral, sameEq } from '../shared/audio.js';
import { getCustomPresets, saveCustomPresets } from '../shared/settings.js';

const MAX_CUSTOM = 12;
const CURVE_POINTS = 160;
const DB_SPAN = 15;

// Position on the evenly spaced band axis (0..9) for a frequency, and back.
function freqAt(u) {
  if (u <= 0) return BANDS[0] * 2 ** u;
  if (u >= BANDS.length - 1) return BANDS[BANDS.length - 1] * 2 ** (u - BANDS.length + 1);
  const i = Math.floor(u);
  return BANDS[i] * (BANDS[i + 1] / BANDS[i]) ** (u - i);
}

function captureError(err) {
  const msg = err?.message || String(err);
  if (/active stream/i.test(msg)) return t('errCaptureBusy');
  if (/chrome|cannot be captured|not allowed|invoked/i.test(msg)) return t('errCapture');
  return `${t('errGeneric')} ${msg}`;
}

export async function initMixer(tab, settings) {
  const $ = (id) => document.getElementById(id);
  const saved = (await send({ type: 'audio:get', tabId: tab.id }).catch(() => null))?.state;
  const state = saved ? { ...freshState(), ...saved, eq: [...saved.eq] } : freshState();
  delete state.active;
  let active = !!saved;
  let custom = await getCustomPresets();

  const live = $('audio-live');
  const offBtn = $('mixer-off');
  const boost = $('boost');
  const boostValue = $('boost-value');
  const canvas = $('eq-curve');

  // ---- Sync with the audio engine (one request in flight, latest state wins) ----

  let busy = false;
  let dirty = false;

  async function sync() {
    const snapshot = structuredClone(state);
    if (isNeutral(snapshot)) {
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
        Object.assign(state, freshState(), { limiter: state.limiter });
        render();
      }
    } finally {
      busy = false;
      renderStatus();
    }
  }

  function renderStatus() {
    live.hidden = !active;
    offBtn.hidden = !active;
  }

  function commit() {
    render();
    push();
  }

  // ---- Boost ----

  const quick = $('boost-quick');

  function setMax(max) {
    boost.max = String(max);
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
    if (p.limiter) state.limiter = true;
    commit();
  }

  function renderPresets() {
    const builtIn = PRESETS.map((p) =>
      h('button', { class: ['chip', sameEq(state.eq, p.eq) && 'on'], onclick: () => applyPreset(p) }, t(`preset_${p.id}`)));
    const mine = custom.map((p) =>
      h('button', { class: ['chip', sameEq(state.eq, p.eq) && 'on'], title: p.name, onclick: () => applyPreset(p) },
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
    custom = [...custom, { id: Date.now().toString(36), name, eq: [...state.eq] }];
    await saveCustomPresets(custom);
    form.hidden = true;
    renderPresets();
    toast(t('presetSaved', name));
  });

  // ---- Equalizer ----

  const bandsEl = $('eq-bands');
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
    bandsEl.append(h('div', { class: 'band' }, val, slider, h('span', { class: 'band-freq' }, bandLabel(BANDS[i]))));
  }

  $('eq-reset').addEventListener('click', () => {
    state.eq = BANDS.map(() => 0);
    commit();
  });

  // Response curve computed by the same biquad filters the engine uses.
  const offline = new OfflineAudioContext(1, 1, 48000);
  const filters = BANDS.map((f, i) => {
    const node = offline.createBiquadFilter();
    node.type = bandType(i);
    node.frequency.value = f;
    node.Q.value = BAND_Q;
    return node;
  });
  const us = Float32Array.from({ length: CURVE_POINTS }, (_, k) => -0.5 + (k / (CURVE_POINTS - 1)) * BANDS.length);
  const freqs = Float32Array.from(us, freqAt);
  const mag = new Float32Array(CURVE_POINTS);
  const phase = new Float32Array(CURVE_POINTS);

  function response() {
    const total = new Float32Array(CURVE_POINTS);
    filters.forEach((node, i) => {
      node.gain.value = state.eq[i];
      node.getFrequencyResponse(freqs, mag, phase);
      for (let k = 0; k < CURVE_POINTS; k++) total[k] += 20 * Math.log10(mag[k]);
    });
    return total;
  }

  function drawCurve() {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (!w) return;
    if (canvas.width !== Math.round(w * dpr)) {
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
    const y = (db) => hgt / 2 - (db / DB_SPAN) * (hgt / 2 - 6);

    g.lineWidth = 1;
    for (const db of [-12, -6, 0, 6, 12]) {
      g.strokeStyle = `rgba(${tint}, ${db === 0 ? 0.16 : 0.06})`;
      g.beginPath();
      g.moveTo(0, Math.round(y(db)) + 0.5);
      g.lineTo(w, Math.round(y(db)) + 0.5);
      g.stroke();
    }

    const curve = response();
    const line = new Path2D();
    us.forEach((u, k) => {
      const py = y(Math.max(-DB_SPAN, Math.min(DB_SPAN, curve[k])));
      if (k) line.lineTo(x(u), py);
      else line.moveTo(x(u), py);
    });

    const area = new Path2D(line);
    area.lineTo(w, y(0));
    area.lineTo(0, y(0));
    area.closePath();
    const fill = g.createLinearGradient(0, 0, 0, hgt);
    fill.addColorStop(0, `${accent}55`);
    fill.addColorStop(0.5, `${accent}10`);
    fill.addColorStop(1, `${accent}55`);
    g.fillStyle = fill;
    g.fill(area);

    g.strokeStyle = accent;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.stroke(line);

    state.eq.forEach((db, i) => {
      g.beginPath();
      g.arc(x(i), y(db), 3.5, 0, Math.PI * 2);
      g.fillStyle = db ? accent : `rgba(${tint}, 0.35)`;
      g.fill();
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
    state.eq[dragBand] = Math.max(-EQ_RANGE, Math.min(EQ_RANGE, Math.round(db * 2) / 2));
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

  // ---- Output ----

  const limiter = $('limiter');
  const mono = $('mono');
  const balance = $('balance');
  limiter.addEventListener('change', () => { state.limiter = limiter.checked; commit(); });
  mono.addEventListener('change', () => { state.mono = mono.checked; commit(); });
  balance.addEventListener('input', () => { state.balance = Number(balance.value); commit(); });
  balance.addEventListener('dblclick', () => { state.balance = 0; commit(); });

  offBtn.addEventListener('click', () => {
    const keepLimiter = state.limiter;
    Object.assign(state, freshState(), { limiter: keepLimiter });
    commit();
  });

  // ---- Render ----

  function render() {
    boost.value = String(state.boost);
    paintRange(boost);
    boostValue.textContent = state.boost;
    boostValue.parentElement.classList.toggle('hot', state.boost > 100);
    for (const chip of quick.children) chip.classList.toggle('on', Number(chip.dataset.boost) === state.boost);

    state.eq.forEach((db, i) => {
      if (document.activeElement !== sliders[i] || Number(sliders[i].value) !== db) sliders[i].value = String(db);
      values[i].textContent = db > 0 ? `+${db}` : String(db);
      values[i].classList.toggle('on', db !== 0);
    });

    limiter.checked = state.limiter;
    mono.checked = state.mono;
    balance.value = String(state.balance);
    paintRange(balance);
    renderPresets();
    drawCurve();
  }

  setMax(settings.maxBoost);
  renderStatus();

  return {
    setMax,
    redraw: drawCurve
  };
}
