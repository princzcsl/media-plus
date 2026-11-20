// AudioWorklet processors used by the mixer (loaded once per AudioContext).

// Pitch shifter: two read heads sweep a short delay line at (1 - ratio) speed and
// cross-fade with sin² windows, so the pitch moves without changing the speed.
class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.size = 8192;
    this.mask = this.size - 1;
    this.win = Math.round(sampleRate * 0.05);
    this.buffers = [new Float32Array(this.size), new Float32Array(this.size)];
    this.write = 0;
    this.phase = 0;
  }

  read(buf, pos) {
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = buf[i & this.mask];
    const b = buf[(i + 1) & this.mask];
    return a + (b - a) * frac;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const ratio = params.ratio[0];
    const frames = output[0].length;
    const channels = Math.min(output.length, 2);
    const step = (1 - ratio) / this.win;

    for (let n = 0; n < frames; n++) {
      for (let c = 0; c < channels; c++) {
        const src = input[c] || input[0];
        this.buffers[c][this.write] = src ? src[n] : 0;
      }
      this.phase += step;
      this.phase -= Math.floor(this.phase);
      const p1 = this.phase;
      const p2 = (p1 + 0.5) % 1;
      const g1 = Math.sin(Math.PI * p1) ** 2;
      const g2 = 1 - g1;
      const r1 = this.write - p1 * this.win - 1 + this.size;
      const r2 = this.write - p2 * this.win - 1 + this.size;
      for (let c = 0; c < channels; c++) {
        const buf = this.buffers[c];
        output[c][n] = this.read(buf, r1) * g1 + this.read(buf, r2) * g2;
      }
      this.write = (this.write + 1) & this.mask;
    }
    return true;
  }
}

// Look-ahead peak limiter: sees peaks 5 ms early and lowers the gain just enough,
// no make-up gain, so it stays transparent until the signal actually clips.
class LimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.look = Math.max(1, Math.round(sampleRate * 0.005));
    this.size = 1;
    while (this.size < this.look * 2) this.size <<= 1;
    this.mask = this.size - 1;
    this.delay = [new Float32Array(this.size), new Float32Array(this.size)];
    this.peaks = new Float32Array(this.size);
    this.pos = 0;
    this.gain = 1;
    this.ceiling = 10 ** (-1 / 20);
    this.attack = 1 - Math.exp(-1 / (this.look * 0.35));
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.12));
    // Sliding window maximum (monotonic deque of positions).
    this.dq = new Float64Array(this.size);
    this.head = 0;
    this.tail = 0;
    this.t = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0].length;
    const channels = Math.min(output.length, 2);

    for (let n = 0; n < frames; n++) {
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        const src = input[c] || input[0];
        const v = src ? src[n] : 0;
        this.delay[c][this.pos] = v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      // Push the new peak, drop smaller ones and the ones out of the window.
      const t = this.t++;
      this.peaks[t & this.mask] = peak;
      while (this.tail > this.head && this.peaks[this.dq[(this.tail - 1) & this.mask] & this.mask] <= peak) this.tail--;
      this.dq[this.tail++ & this.mask] = t;
      while (this.dq[this.head & this.mask] <= t - this.look) this.head++;
      const windowPeak = this.peaks[this.dq[this.head & this.mask] & this.mask];

      const target = windowPeak > this.ceiling ? this.ceiling / windowPeak : 1;
      this.gain += (target - this.gain) * (target < this.gain ? this.attack : this.release);

      const readPos = (this.pos - this.look + this.size) & this.mask;
      for (let c = 0; c < channels; c++) {
        let v = this.delay[c][readPos] * this.gain;
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        output[c][n] = v;
      }
      this.pos = (this.pos + 1) & this.mask;
    }
    return true;
  }
}

// Radix-2 complex FFT, in place.
class FFT {
  constructor(n) {
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  run(re, im, inverse) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = sign * this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// Voice: short-time spectra of left and right are compared bin by bin. What is the same
// on both sides (the centre, where voices are mixed) is taken out (karaoke) or kept
// alone (voice only); everything panned keeps its full stereo. Bass and the very top
// are left alone in karaoke mode so the kick, bass and cymbals stay.
class VocalProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'mode', defaultValue: 1, minValue: 1, maxValue: 2, automationRate: 'k-rate' },
      { name: 'strength', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    const N = 2048;
    this.N = N;
    this.hop = N / 4;
    this.fft = new FFT(N);
    this.win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    this.inL = new Float64Array(N);
    this.inR = new Float64Array(N);
    this.accL = new Float64Array(N);
    this.accR = new Float64Array(N);
    this.outL = new Float64Array(this.hop);
    this.outR = new Float64Array(this.hop);
    this.reL = new Float64Array(N); this.imL = new Float64Array(N);
    this.reR = new Float64Array(N); this.imR = new Float64Array(N);
    this.mask = new Float64Array(N);
    this.fill = 0;
    this.band = new Float64Array(N);
    this.mode = 1;
  }

  setBand(mode) {
    const { N } = this;
    const ramp = (f, a, b) => (f <= a ? 0 : f >= b ? 1 : (f - a) / (b - a));
    for (let k = 0; k < N; k++) {
      const f = (Math.min(k, N - k) * sampleRate) / N;
      this.band[k] = mode === 1
        ? ramp(f, 90, 160) * (1 - ramp(f, 9000, 13000))
        : ramp(f, 70, 130) * (1 - ramp(f, 8000, 11000));
    }
    this.mode = mode;
    this.bandReady = true;
  }

  frame(strength) {
    const { N, win, reL, imL, reR, imR, mask, band } = this;
    for (let i = 0; i < N; i++) {
      reL[i] = this.inL[i] * win[i]; imL[i] = 0;
      reR[i] = this.inR[i] * win[i]; imR[i] = 0;
    }
    this.fft.run(reL, imL, false);
    this.fft.run(reR, imR, false);
    for (let k = 0; k < N; k++) {
      const lr = reL[k], li = imL[k], rr = reR[k], ri = imR[k];
      const pl = lr * lr + li * li;
      const pr = rr * rr + ri * ri;
      const s = (2 * (lr * rr + li * ri)) / (pl + pr + 1e-12);
      const centre = s > 0 ? s * s * s * s : 0;
      mask[k] = mask[k] * 0.55 + centre * 0.45;
      const g = mask[k] * band[k] * strength;
      const mr = (lr + rr) * 0.5;
      const mi = (li + ri) * 0.5;
      if (this.mode === 1) {
        reL[k] = lr - g * mr; imL[k] = li - g * mi;
        reR[k] = rr - g * mr; imR[k] = ri - g * mi;
      } else {
        const keep = 1 - strength;
        reL[k] = lr * keep + g * mr; imL[k] = li * keep + g * mi;
        reR[k] = rr * keep + g * mr; imR[k] = ri * keep + g * mi;
      }
    }
    this.fft.run(reL, imL, true);
    this.fft.run(reR, imR, true);
    const scale = 1 / 1.5;
    for (let i = 0; i < N; i++) {
      this.accL[i] += reL[i] * win[i] * scale;
      this.accR[i] += reR[i] * win[i] * scale;
    }
    this.outL.set(this.accL.subarray(0, this.hop));
    this.outR.set(this.accR.subarray(0, this.hop));
    this.accL.copyWithin(0, this.hop); this.accL.fill(0, N - this.hop);
    this.accR.copyWithin(0, this.hop); this.accR.fill(0, N - this.hop);
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const mode = params.mode[0] >= 1.5 ? 2 : 1;
    if (!this.bandReady || mode !== this.mode) this.setBand(mode);
    const strength = params.strength[0];
    const frames = output[0].length;
    const { N, hop } = this;
    for (let n = 0; n < frames; n++) {
      const l = input[0] ? input[0][n] : 0;
      const r = input[1] ? input[1][n] : l;
      this.inL[N - hop + this.fill] = l;
      this.inR[N - hop + this.fill] = r;
      output[0][n] = this.outL[this.fill];
      if (output[1]) output[1][n] = this.outR[this.fill];
      if (++this.fill === hop) {
        this.fill = 0;
        this.frame(strength);
        this.inL.copyWithin(0, hop);
        this.inR.copyWithin(0, hop);
      }
    }
    return true;
  }
}

// Compressor without make-up gain (Web Audio's own adds some), stereo-linked.
class CompressorProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.threshold = o.threshold ?? -18;
    this.ratio = o.ratio ?? 3;
    this.knee = o.knee ?? 6;
    this.makeup = 10 ** ((o.makeup ?? 0) / 20);
    this.attack = 1 - Math.exp(-1 / (sampleRate * (o.attack ?? 0.012)));
    this.release = 1 - Math.exp(-1 / (sampleRate * (o.release ?? 0.18)));
    this.env = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0].length;
    const channels = Math.min(output.length, 2);
    const { threshold, ratio, knee } = this;
    for (let n = 0; n < frames; n++) {
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        const src = input[c] || input[0];
        const v = src ? Math.abs(src[n]) : 0;
        if (v > peak) peak = v;
      }
      this.env += (peak - this.env) * (peak > this.env ? this.attack : this.release);
      const db = 20 * Math.log10(this.env + 1e-9);
      const over = db - threshold;
      let reduce = 0;
      if (over >= knee / 2) reduce = over * (1 - 1 / ratio);
      else if (over > -knee / 2) reduce = ((over + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / ratio);
      const gain = 10 ** (-reduce / 20) * this.makeup;
      for (let c = 0; c < channels; c++) {
        const src = input[c] || input[0];
        output[c][n] = src ? src[n] * gain : 0;
      }
    }
    return true;
  }
}

registerProcessor('mp-pitch', PitchProcessor);
registerProcessor('mp-limiter', LimiterProcessor);
registerProcessor('mp-vocal', VocalProcessor);
registerProcessor('mp-comp', CompressorProcessor);
