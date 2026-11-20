// Frequency response of the EQ, computed by the same biquad filters as the engine.
import { BANDS, BAND_Q, bandType } from './audio.js';

export function createResponse(freqs, sampleRate = 48000) {
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const filters = BANDS.map((f, i) => {
    const node = ctx.createBiquadFilter();
    node.type = bandType(i);
    node.frequency.value = f;
    node.Q.value = BAND_Q;
    return node;
  });
  const list = Float32Array.from(freqs);
  const mag = new Float32Array(list.length);
  const phase = new Float32Array(list.length);

  return (eq) => {
    const total = new Float32Array(list.length);
    filters.forEach((node, i) => {
      node.gain.value = eq[i] || 0;
      node.getFrequencyResponse(list, mag, phase);
      for (let k = 0; k < list.length; k++) total[k] += 20 * Math.log10(mag[k]);
    });
    return total;
  };
}

// 30 Hz → 18 kHz, below Nyquist for any sample rate in use.
const PROBE = Array.from({ length: 48 }, (_, k) => 30 * 600 ** (k / 47));

export function createPeak(sampleRate) {
  const response = createResponse(PROBE, sampleRate);
  return (eq) => response(eq).reduce((max, db) => (Number.isFinite(db) && db > max ? db : max), 0);
}
