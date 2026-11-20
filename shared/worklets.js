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

registerProcessor('mp-pitch', PitchProcessor);
registerProcessor('mp-limiter', LimiterProcessor);
