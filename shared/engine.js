// Audio chain shared by the offscreen engine (and the tests):
// input → normalizer → headroom → [voice] → [mono] → [sub filter] → 8-band EQ → [bass band compressor] (+ bass enhancer)
//       → [pitch] → balance → boost → [night compressor] → [limiter] → analyser
// Optional stages are only wired in when used, so they cost nothing when off.
import { BANDS, bandSpec } from './audio.js';
import { createEq } from './curve.js';

const RAMP = 0.015;
const dbToGain = (db) => 10 ** (db / 20);

export async function loadWorklets(ctx, url) {
  await ctx.audioWorklet.addModule(url);
}

const gainNode = (ctx, value = 1, mono = false) => {
  const g = ctx.createGain();
  g.gain.value = value;
  if (mono) {
    g.channelCount = 1;
    g.channelCountMode = 'explicit';
    g.channelInterpretation = 'discrete';
  }
  return g;
};

const filterNode = (ctx, type, frequency, Q = 0.707) => {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  return f;
};

export function createChain(ctx, input) {
  const eqMaths = { shelf: createEq(ctx.sampleRate, 'shelf'), bell: createEq(ctx.sampleRate, 'bell') };

  // Normalizer: slow automatic gain towards a steady loudness.
  const normalizer = gainNode(ctx);
  const meter = ctx.createAnalyser();
  meter.fftSize = 2048;
  const meterData = new Float32Array(meter.fftSize);
  input.connect(meter);
  input.connect(normalizer);

  const headroom = gainNode(ctx);
  normalizer.connect(headroom);

  // Voice: spectral centre extraction (see worklets.js).
  const vocal = new AudioWorkletNode(ctx, 'mp-vocal', { outputChannelCount: [2] });

  const vocalIn = gainNode(ctx);
  headroom.connect(vocalIn);

  // Mono: both channels summed, sent to the left and the right.
  const monoSplit = ctx.createChannelSplitter(2);
  const monoSum = gainNode(ctx, 0.5, true);
  const monoMerge = ctx.createChannelMerger(2);
  monoSplit.connect(monoSum, 0); monoSplit.connect(monoSum, 1);
  monoSum.connect(monoMerge, 0, 0); monoSum.connect(monoMerge, 0, 1);

  const filters = BANDS.map((_, i) => {
    const spec = bandSpec(i);
    return filterNode(ctx, spec.type, spec.freq, spec.Q);
  });
  let bassMode = 'shelf';

  // Beta bass: rumble below 25 Hz removed (it only eats headroom), and the low band
  // (under 150 Hz, Linkwitz-Riley split) gets its own gentle compressor, so a bass boost
  // stays tight instead of pushing the whole mix into the limiter.
  const subsonic = filterNode(ctx, 'highpass', 25);
  const xLow1 = filterNode(ctx, 'lowpass', 150); const xLow2 = filterNode(ctx, 'lowpass', 150);
  const xHigh1 = filterNode(ctx, 'highpass', 150); const xHigh2 = filterNode(ctx, 'highpass', 150);
  const lowComp = new AudioWorkletNode(ctx, 'mp-comp', {
    outputChannelCount: [2],
    processorOptions: { threshold: -16, ratio: 2.5, knee: 8, attack: 0.015, release: 0.16 }
  });
  xLow1.connect(xLow2); xLow2.connect(lowComp);
  xHigh1.connect(xHigh2);
  for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
  const eqOut = filters[filters.length - 1];

  // Bass enhancer: harmonics of the low end, heard even where the speaker can't play it.
  const mix = gainNode(ctx);
  eqOut.connect(mix);
  const enhLow = filterNode(ctx, 'lowpass', 140);
  const enhDrive = gainNode(ctx, 3);
  const shaper = ctx.createWaveShaper();
  // Classic: symmetric saturation (odd harmonics). Beta: asymmetric, mostly the octave
  // above, which the ear reads as a deeper, rounder fundamental.
  const curves = { shelf: new Float32Array(1024), bell: new Float32Array(1024) };
  for (let i = 0; i < 1024; i++) {
    const x = (i / 1023) * 2 - 1;
    curves.shelf[i] = Math.tanh(2.5 * x) / Math.tanh(2.5);
    curves.bell[i] = 0.6 * Math.tanh(1.5 * x) + 0.8 * x * x - 0.25;
  }
  shaper.curve = curves.shelf;
  let shaperMode = 'shelf';
  shaper.oversample = '4x';
  const enhHigh = filterNode(ctx, 'highpass', 120);
  const enhTop = filterNode(ctx, 'lowpass', 1500);
  const enhAmount = gainNode(ctx, 0);
  enhLow.connect(enhDrive); enhDrive.connect(shaper); shaper.connect(enhHigh);
  enhHigh.connect(enhTop); enhTop.connect(enhAmount); enhAmount.connect(mix);

  const pitch = new AudioWorkletNode(ctx, 'mp-pitch', { outputChannelCount: [2] });
  const balance = ctx.createStereoPanner();
  const boost = gainNode(ctx);
  balance.connect(boost);

  // Night: evens out loud and quiet parts.
  const night = ctx.createDynamicsCompressor();
  night.threshold.value = -30;
  night.knee.value = 18;
  night.ratio.value = 5;
  night.attack.value = 0.006;
  night.release.value = 0.3;
  const nightMakeup = gainNode(ctx, dbToGain(-4));
  night.connect(nightMakeup);

  const limiter = new AudioWorkletNode(ctx, 'mp-limiter', { outputChannelCount: [2] });

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.75;

  let wiring = '';

  function rewire(s) {
    const key = [s.vocal, !!s.mono, !!s.enhancer, !!s.pitch, !!s.night, !!s.limiter, s.bass].join('|');
    if (key === wiring) return;
    wiring = key;
    for (const node of [vocalIn, vocal, monoMerge, subsonic, eqOut, lowComp, xHigh2, mix, pitch, boost, nightMakeup, limiter]) node.disconnect();
    const beta = s.bass === 'bell';

    let tail = vocalIn;
    if (s.vocal === 'remove' || s.vocal === 'isolate') {
      vocalIn.connect(vocal);
      tail = vocal;
    }
    if (s.mono) {
      tail.connect(monoSplit);
      tail = monoMerge;
    }
    if (beta) {
      tail.connect(subsonic);
      tail = subsonic;
    }
    tail.connect(filters[0]);
    if (beta) {
      eqOut.connect(xLow1);
      eqOut.connect(xHigh1);
      lowComp.connect(mix);
      xHigh2.connect(mix);
      if (s.enhancer) lowComp.connect(enhLow);
    } else {
      eqOut.connect(mix);
      if (s.enhancer) eqOut.connect(enhLow);
    }

    tail = mix;
    if (s.pitch) {
      mix.connect(pitch);
      tail = pitch;
    }
    tail.connect(balance);

    tail = boost;
    if (s.night) {
      boost.connect(night);
      tail = nightMakeup;
    }
    if (s.limiter) {
      tail.connect(limiter);
      tail = limiter;
    }
    tail.connect(analyser);
  }

  // Normalizer loop: only runs while the option is on.
  let normTimer = null;
  let loudness = null;
  function normalizeLoop(on) {
    if (!on) {
      clearInterval(normTimer);
      normTimer = null;
      loudness = null;
      normalizer.gain.setTargetAtTime(1, ctx.currentTime, 0.3);
      return;
    }
    if (normTimer) return;
    normTimer = setInterval(() => {
      meter.getFloatTimeDomainData(meterData);
      let sum = 0;
      for (let i = 0; i < meterData.length; i++) sum += meterData[i] * meterData[i];
      const db = 10 * Math.log10(sum / meterData.length + 1e-12);
      if (db < -55) return;
      loudness = loudness == null ? db : loudness + (db - loudness) * 0.035;
      const gain = Math.max(-10, Math.min(10, -21 - loudness));
      normalizer.gain.setTargetAtTime(dbToGain(gain), ctx.currentTime, 0.8);
    }, 100);
  }

  function apply(s) {
    const now = ctx.currentTime;
    const mode = s.bass === 'bell' ? 'bell' : 'shelf';
    if (mode !== bassMode) {
      bassMode = mode;
      const spec = bandSpec(0, mode);
      filters[0].type = spec.type;
      filters[0].frequency.setValueAtTime(spec.freq, now);
      filters[0].Q.setValueAtTime(spec.Q, now);
    }
    if (mode !== shaperMode) {
      shaperMode = mode;
      shaper.curve = curves[mode];
      enhHigh.frequency.setValueAtTime(mode === 'bell' ? 90 : 120, now);
    }
    const math = eqMaths[mode];
    const gains = math.solve(s.eq);
    filters.forEach((f, i) => f.gain.setTargetAtTime(gains[i], now, RAMP));
    const peak = s.limiter ? math.peak(s.eq) : 0;
    const room = mode === 'bell' ? -Math.max(0, peak - 6) * 0.35 : -Math.max(0, peak - 3) * 0.5;
    headroom.gain.setTargetAtTime(dbToGain(room), now, RAMP);
    vocal.parameters.get('mode').setValueAtTime(s.vocal === 'isolate' ? 2 : 1, now);
    enhAmount.gain.setTargetAtTime((s.enhancer || 0) / 100 * 1.4, now, RAMP);
    pitch.parameters.get('ratio').setValueAtTime(2 ** ((s.pitch || 0) / 12), now);
    boost.gain.setTargetAtTime(Math.max(0, s.boost) / 100, now, RAMP);
    balance.pan.setTargetAtTime(Math.max(-1, Math.min(1, (s.balance || 0) / 100)), now, RAMP);
    rewire(s);
    normalizeLoop(!!s.normalize);
  }

  // 64 log-spaced bars from 30 Hz to 18 kHz, 0-255.
  const bins = new Uint8Array(analyser.frequencyBinCount);
  function spectrum(bars = 64) {
    analyser.getByteFrequencyData(bins);
    const hzPerBin = ctx.sampleRate / analyser.fftSize;
    const out = new Array(bars);
    for (let i = 0; i < bars; i++) {
      const lo = 30 * 600 ** (i / bars);
      const hi = 30 * 600 ** ((i + 1) / bars);
      let a = Math.floor(lo / hzPerBin);
      const b = Math.max(a + 1, Math.ceil(hi / hzPerBin));
      let max = 0;
      for (; a < b && a < bins.length; a++) if (bins[a] > max) max = bins[a];
      out[i] = max;
    }
    return out;
  }

  function dispose() {
    normalizeLoop(false);
    input.disconnect();
    for (const node of [meter, normalizer, headroom, vocalIn, monoSplit, monoSum, monoMerge, ...filters, mix, enhLow, enhDrive,
      shaper, enhHigh, enhTop, enhAmount, pitch, balance, boost, night, nightMakeup, limiter, analyser, vocal, subsonic,
      xLow1, xLow2, xHigh1, xHigh2, lowComp]) {
      node.disconnect();
    }
  }

  return { output: analyser, apply, spectrum, dispose };
}
