// 8 bands: wide enough to shape the sound without the overlap of 10+ narrow bands.
export const BANDS = [60, 150, 400, 1000, 2500, 6000, 10000, 15000];
export const EQ_RANGE = 14;
export const BAND_Q = 1.1;

export const bandType = (i) => (i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking');

// Shelves turn at a corner a bit inside the range, so the labelled frequency gets
// (almost) the full gain instead of half of it.
export const bandCorner = (i) => (i === 0 ? 95 : i === BANDS.length - 1 ? 12500 : BANDS[i]);

// Filter of each band. The lowest band is a shelf (even lift of everything below, like the
// Harman target) or a wide bell at 70 Hz (punch, without piling up sub-bass; comes with a
// rumble filter and its own gentle compressor in the engine).
// The bell's centre and width (in octaves) can be set by the user.
export const BELL = Object.freeze({ freq: 70, width: 2.9, minFreq: 35, maxFreq: 150, minWidth: 0.8, maxWidth: 3.5 });

// Q of a peaking filter for a bandwidth in octaves.
export const widthToQ = (oct) => Math.sqrt(2 ** oct) / (2 ** oct - 1);

// `shape` is a mixer state (or anything with bass / bellFreq / bellWidth).
export function bandSpec(i, shape = {}) {
  if (i === 0 && shape.bass === 'bell') {
    return { type: 'peaking', freq: shape.bellFreq || BELL.freq, Q: widthToQ(shape.bellWidth || BELL.width) };
  }
  return { type: bandType(i), freq: bandCorner(i), Q: BAND_Q };
}

export const shapeKey = (s = {}) => (s.bass === 'bell' ? `bell|${s.bellFreq || BELL.freq}|${s.bellWidth || BELL.width}` : 'shelf');

export const BASS_SHAPES = ['shelf', 'bell'];

export const bandLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

export const PITCH_RANGE = 12;

export const NEUTRAL = Object.freeze({
  boost: 100,
  eq: Object.freeze(BANDS.map(() => 0)),
  balance: 0,
  mono: false,
  limiter: true,
  night: false,
  enhancer: 0,
  normalize: false,
  vocal: 'off',
  pitch: 0,
  bass: 'shelf',
  bellFreq: BELL.freq,
  bellWidth: BELL.width
});

export const freshState = () => ({ ...NEUTRAL, eq: [...NEUTRAL.eq] });

export const isNeutral = (s) =>
  s.boost === 100 && s.balance === 0 && !s.mono && !s.night && !s.enhancer && !s.normalize &&
  s.vocal === 'off' && !s.pitch && s.eq.every((g) => g === 0);

const num = (v, fallback, min, max) => (Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback);

// Settings that are kept per site / globally: everything but the on/off of the capture.
export function cleanState(s) {
  if (!s) return freshState();
  return {
    boost: num(s.boost, 100, 0, 600),
    eq: fitEq(s.eq),
    balance: num(s.balance, 0, -100, 100),
    mono: !!s.mono,
    limiter: s.limiter !== false,
    night: !!s.night,
    enhancer: num(s.enhancer, 0, 0, 100),
    normalize: !!s.normalize,
    vocal: ['remove', 'isolate'].includes(s.vocal) ? s.vocal : 'off',
    pitch: num(s.pitch, 0, -PITCH_RANGE, PITCH_RANGE),
    bass: s.bass === 'bell' || s.bass === 'beta' ? 'bell' : 'shelf',
    bellFreq: num(s.bellFreq, BELL.freq, BELL.minFreq, BELL.maxFreq),
    bellWidth: num(s.bellWidth, BELL.width, BELL.minWidth, BELL.maxWidth)
  };
}

// Older 10-band curves (32 Hz → 16 kHz) are resampled to the current bands.
const OLD_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export function fitEq(eq) {
  if (!Array.isArray(eq)) return BANDS.map(() => 0);
  if (eq.length === BANDS.length) return eq.map((g) => clampDb(Number(g) || 0));
  if (eq.length !== OLD_BANDS.length) return BANDS.map(() => 0);
  return BANDS.map((f) => {
    const i = OLD_BANDS.findIndex((b) => b >= f);
    if (i <= 0) return clampDb(eq[i === 0 ? 0 : OLD_BANDS.length - 1]);
    const t = (Math.log2(f) - Math.log2(OLD_BANDS[i - 1])) / (Math.log2(OLD_BANDS[i]) - Math.log2(OLD_BANDS[i - 1]));
    return clampDb(Math.round((eq[i - 1] + (eq[i] - eq[i - 1]) * t) * 2) / 2);
  });
}

export const clampDb = (g) => Math.max(-EQ_RANGE, Math.min(EQ_RANGE, g));

// Curves in the spirit of what sound engineers use: bass boosts cut the 400 Hz "mud",
// voice lifts the 1-5 kHz presence, small speakers get their bass at 150 Hz, not below.
export const PRESETS = [
  { id: 'flat', eq: [0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', eq: [7, 4, -1.5, 0, 0, 0, 0, 0], enhancer: 20, bass: 'bell' },
  { id: 'bassPlus', eq: [10, 5, -2.5, 0, 0, 1, 1, 0], bass: 'bell' },
  // Bass of the Harman headphone target: +6 dB shelf at 105 Hz.
  { id: 'harman', eq: [5.5, 1.5, 0, 0, 0, 0, 0, 0], bass: 'shelf' },
  { id: 'vocal', eq: [-6, -3, -1, 2, 4, 3, 1, 0] },
  { id: 'movie', eq: [5, 2, -1, 0, 2, 2, 1, 1], enhancer: 15 },
  { id: 'music', eq: [4, 2, -1, -1, 0, 2, 3, 3] },
  { id: 'clarity', eq: [0, 0, -2, 0, 2, 4, 4, 3] },
  { id: 'laptop', eq: [-6, 4, 2, 0, 2, 3, 2, 0], enhancer: 50 },
  { id: 'night', eq: [-6, -3, 0, 1, 3, 2, 0, -1], night: true }
];

export const sameEq = (a, b) => a.length === b.length && a.every((g, i) => g === b[i]);

export const matchesPreset = (s, p) =>
  sameEq(s.eq, p.eq) && !!p.night === s.night && (p.enhancer || 0) === s.enhancer && (p.bass || 'shelf') === s.bass;
