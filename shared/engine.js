// Audio chain shared by the offscreen engine (and the tests):
// input → normalizer → headroom → [voice remove | isolate] → [mono] → 8-band EQ (+ bass enhancer)
//       → [pitch] → balance → boost → [night compressor] → [limiter] → analyser
// Optional stages are only wired in when used, so they cost nothing when off.
import { BANDS, BAND_Q, bandType, bandCorner } from './audio.js';
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
  const eqMath = createEq(ctx.sampleRate);

  // Normalizer: slow automatic gain towards a steady loudness.
  const normalizer = gainNode(ctx);
  const meter = ctx.createAnalyser();
  meter.fftSize = 2048;
  const meterData = new Float32Array(meter.fftSize);
  input.connect(meter);
  input.connect(normalizer);

  const headroom = gainNode(ctx);
  normalizer.connect(headroom);

  // Voice: mid (centre, where voices sit) and side (the rest) of the stereo image.
  const vocalIn = gainNode(ctx);
  const split = ctx.createChannelSplitter(2);
  const mid = gainNode(ctx, 1, true);
  const side = gainNode(ctx, 1, true);
  const lMid = gainNode(ctx, 0.5); const rMid = gainNode(ctx, 0.5);
  const lSide = gainNode(ctx, 0.5); const rSide = gainNode(ctx, -0.5);
  split.connect(lMid, 0); split.connect(rMid, 1);
  split.connect(lSide, 0); split.connect(rSide, 1);
  lMid.connect(mid); rMid.connect(mid);
  lSide.connect(side); rSide.connect(side);
  // Remove: sides + the centre's low end (kick and bass usually sit in the middle too).
  const removeMerge = ctx.createChannelMerger(2);
  const midLow = filterNode(ctx, 'lowpass', 170);
  const sideInvert = gainNode(ctx, -1, true);
  mid.connect(midLow);
  midLow.connect(removeMerge, 0, 0); midLow.connect(removeMerge, 0, 1);
  side.connect(removeMerge, 0, 0);
  side.connect(sideInvert); sideInvert.connect(removeMerge, 0, 1);
  // Isolate: the centre only, in the voice range.
  const isolateMerge = ctx.createChannelMerger(2);
  const voiceHp = filterNode(ctx, 'highpass', 110);
  const voiceLp = filterNode(ctx, 'lowpass', 8000);
  voiceHp.connect(voiceLp);
  voiceLp.connect(isolateMerge, 0, 0); voiceLp.connect(isolateMerge, 0, 1);
  headroom.connect(vocalIn);

  // Mono: both channels summed, sent to the left and the right.
  const monoIn = gainNode(ctx);
  const monoSplit = ctx.createChannelSplitter(2);
  const monoSum = gainNode(ctx, 0.5, true);
  const monoMerge = ctx.createChannelMerger(2);
  monoSplit.connect(monoSum, 0); monoSplit.connect(monoSum, 1);
  monoSum.connect(monoMerge, 0, 0); monoSum.connect(monoMerge, 0, 1);

  const filters = BANDS.map((_, i) => filterNode(ctx, bandType(i), bandCorner(i), BAND_Q));
  for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
  const eqOut = filters[filters.length - 1];

  // Bass enhancer: harmonics of the low end, heard even where the speaker can't play it.
  const mix = gainNode(ctx);
  eqOut.connect(mix);
  const enhLow = filterNode(ctx, 'lowpass', 140);
  const enhDrive = gainNode(ctx, 3);
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(2.5 * x) / Math.tanh(2.5);
  }
  shaper.curve = curve;
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
    const key = [s.vocal, !!s.mono, !!s.enhancer, !!s.pitch, !!s.night, !!s.limiter].join('|');
    if (key === wiring) return;
    wiring = key;
    for (const node of [vocalIn, removeMerge, isolateMerge, mid, monoIn, monoMerge, eqOut, mix, pitch, boost, nightMakeup, limiter]) node.disconnect();
    // Fixed links that the disconnects above cut.
    mid.connect(midLow);
    eqOut.connect(mix);

    let tail = vocalIn;
    if (s.vocal === 'remove' || s.vocal === 'isolate') {
      vocalIn.connect(split);
      if (s.vocal === 'isolate') mid.connect(voiceHp);
      tail = s.vocal === 'remove' ? removeMerge : isolateMerge;
    }
    if (s.mono) {
      tail.connect(monoSplit);
      tail = monoMerge;
    }
    tail.connect(filters[0]);
    if (s.enhancer) eqOut.connect(enhLow);

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
    const gains = eqMath.solve(s.eq);
    filters.forEach((f, i) => f.gain.setTargetAtTime(gains[i], now, RAMP));
    const peak = s.limiter ? eqMath.peak(s.eq) : 0;
    headroom.gain.setTargetAtTime(dbToGain(-Math.max(0, peak - 3) * 0.5), now, RAMP);
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
    for (const node of [meter, normalizer, headroom, vocalIn, split, mid, side, lMid, rMid, lSide, rSide, removeMerge, midLow,
      sideInvert, isolateMerge, voiceHp, voiceLp, monoIn, monoSplit, monoSum, monoMerge, ...filters, mix, enhLow, enhDrive,
      shaper, enhHigh, enhTop, enhAmount, pitch, balance, boost, night, nightMakeup, limiter, analyser]) {
      node.disconnect();
    }
  }

  return { output: analyser, apply, spectrum, dispose };
}
