// EQ maths shared by the engine and the popup.
// Neighbouring bands overlap, so setting each filter to its slider value would not give
// that value on the curve (two bands at +12 add up, a shelf only gives half its gain at
// its corner). Like a proper graphic EQ, the filter gains are solved so the response at
// each band's frequency is exactly what the slider says.
import { BANDS, bandSpec, shapeKey } from './audio.js';

const FILTER_LIMIT = 30;

function gaussSolve(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col || !a[col][col]) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => (row[i] ? row[n] / row[i] : 0));
}

export function createEq(sampleRate = 48000, shape = {}) {
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const filters = BANDS.map((_, i) => {
    const spec = bandSpec(i, shape);
    const node = ctx.createBiquadFilter();
    node.type = spec.type;
    node.frequency.value = spec.freq;
    node.Q.value = spec.Q;
    return node;
  });
  const scratch = new Map();

  // Sum of the filters' responses (dB) at the given frequencies, for these filter gains.
  function responseOf(gains, freqs) {
    let s = scratch.get(freqs);
    if (!s) {
      s = { list: Float32Array.from(freqs), mag: new Float32Array(freqs.length), phase: new Float32Array(freqs.length) };
      scratch.set(freqs, s);
    }
    const total = new Float32Array(freqs.length);
    filters.forEach((node, i) => {
      node.gain.value = gains[i] || 0;
      node.getFrequencyResponse(s.list, s.mag, s.phase);
      for (let k = 0; k < total.length; k++) total[k] += 20 * Math.log10(s.mag[k]);
    });
    return total;
  }

  // Influence of each filter (per dB) on every band frequency.
  const centers = [...BANDS];
  const influence = BANDS.map((_, j) => BANDS.map(() => 0));
  BANDS.forEach((_, i) => {
    const r = responseOf(BANDS.map((__, k) => (k === i ? 6 : 0)), centers);
    r.forEach((db, j) => { influence[j][i] = db / 6; });
  });

  let lastKey = '';
  let lastGains = null;

  function solve(targets) {
    const key = targets.join(',');
    if (key === lastKey) return lastGains;
    let gains = targets.every((g) => !g) ? targets.map(() => 0) : gaussSolve(influence, targets);
    for (let pass = 0; pass < 4 && targets.some(Boolean); pass++) {
      const actual = responseOf(gains, centers);
      const delta = gaussSolve(influence, targets.map((tg, j) => tg - actual[j]));
      gains = gains.map((g, i) => Math.max(-FILTER_LIMIT, Math.min(FILTER_LIMIT, g + delta[i])));
    }
    lastKey = key;
    lastGains = gains;
    return gains;
  }

  return {
    solve,
    // Response (dB) of the EQ set to these slider values.
    response: (targets, freqs) => responseOf(solve(targets), freqs),
    // Highest boost anywhere from 30 Hz to 18 kHz, to give the limiter headroom.
    peak(targets) {
      const r = responseOf(solve(targets), PROBE);
      let max = 0;
      for (const db of r) if (Number.isFinite(db) && db > max) max = db;
      return max;
    }
  };
}

const PROBE = Array.from({ length: 48 }, (_, k) => 30 * 600 ** (k / 47));

// One EQ model per band shape, the last few kept (bell settings change while dragging).
export function eqCache(sampleRate = 48000) {
  const cache = new Map();
  return (shape) => {
    const key = shapeKey(shape);
    let eq = cache.get(key);
    if (!eq) {
      eq = createEq(sampleRate, shape);
      cache.set(key, eq);
      if (cache.size > 6) cache.delete(cache.keys().next().value);
    }
    return eq;
  };
}
