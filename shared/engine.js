// Audio chain shared by the offscreen engine (and the tests):
// input → headroom → [stereo | mono] → 8-band EQ → balance → boost → [night compressor] → [limiter] → analyser
import { BANDS, BAND_Q, bandType } from './audio.js';
import { createPeak } from './curve.js';

const RAMP = 0.015;
const dbToGain = (db) => 10 ** (db / 20);

export function createChain(ctx, input) {
  const headroom = ctx.createGain();

  // Mono: both channels summed into one, sent to the left and the right.
  const splitter = ctx.createChannelSplitter(2);
  const monoSum = ctx.createGain();
  monoSum.channelCount = 1;
  monoSum.channelCountMode = 'explicit';
  monoSum.channelInterpretation = 'discrete';
  monoSum.gain.value = 0.5;
  const merger = ctx.createChannelMerger(2);
  splitter.connect(monoSum, 0);
  splitter.connect(monoSum, 1);
  monoSum.connect(merger, 0, 0);
  monoSum.connect(merger, 0, 1);

  const filters = BANDS.map((freq, i) => {
    const f = ctx.createBiquadFilter();
    f.type = bandType(i);
    f.frequency.value = freq;
    f.Q.value = BAND_Q;
    return f;
  });
  for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);

  const balance = ctx.createStereoPanner();
  const boost = ctx.createGain();
  filters[filters.length - 1].connect(balance);
  balance.connect(boost);

  // Night: evens out loud and quiet parts, then brings the level back up.
  const night = ctx.createDynamicsCompressor();
  night.threshold.value = -30;
  night.knee.value = 18;
  night.ratio.value = 5;
  night.attack.value = 0.006;
  night.release.value = 0.3;
  const nightMakeup = ctx.createGain();
  nightMakeup.gain.value = dbToGain(-4);
  night.connect(nightMakeup);

  // Limiter: only catches peaks, the headroom keeps it from pumping on bass boosts.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.75;

  input.connect(headroom);

  // Peak of the EQ curve, to give it headroom before the limiter.
  const curvePeak = createPeak(ctx.sampleRate);

  let wiring = '';

  function rewire(s) {
    const key = `${!!s.mono}|${!!s.night}|${!!s.limiter}`;
    if (key === wiring) return;
    wiring = key;
    for (const node of [headroom, merger, boost, nightMakeup, limiter]) node.disconnect();
    if (s.mono) {
      headroom.connect(splitter);
      merger.connect(filters[0]);
    } else {
      headroom.connect(filters[0]);
    }
    let tail = boost;
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

  function apply(s) {
    const now = ctx.currentTime;
    const peak = s.limiter ? curvePeak(s.eq) : 0;
    filters.forEach((f, i) => f.gain.setTargetAtTime(s.eq[i] || 0, now, RAMP));
    headroom.gain.setTargetAtTime(dbToGain(-peak * 0.5), now, RAMP);
    boost.gain.setTargetAtTime(Math.max(0, s.boost) / 100, now, RAMP);
    balance.pan.setTargetAtTime(Math.max(-1, Math.min(1, (s.balance || 0) / 100)), now, RAMP);
    rewire(s);
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
    for (const node of [input, headroom, splitter, monoSum, merger, ...filters, balance, boost, night, nightMakeup, limiter, analyser]) {
      node.disconnect();
    }
  }

  return { output: analyser, apply, spectrum, dispose };
}
