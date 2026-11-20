// 8 bands: wide enough to shape the sound without the overlap of 10+ narrow bands.
export const BANDS = [60, 150, 400, 1000, 2500, 6000, 10000, 15000];
export const EQ_RANGE = 18;
export const BAND_Q = 1.0;

export const bandType = (i) => (i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking');

export const bandLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

export const NEUTRAL = Object.freeze({
  boost: 100,
  eq: Object.freeze(BANDS.map(() => 0)),
  balance: 0,
  mono: false,
  limiter: true,
  night: false
});

export const freshState = () => ({ ...NEUTRAL, eq: [...NEUTRAL.eq] });

export const isNeutral = (s) =>
  s.boost === 100 && s.balance === 0 && !s.mono && !s.night && s.eq.every((g) => g === 0);

// Settings that are kept per site / globally: everything but the on/off of the capture.
export function cleanState(s) {
  const base = freshState();
  if (!s) return base;
  return {
    boost: Number.isFinite(s.boost) ? s.boost : base.boost,
    eq: fitEq(s.eq),
    balance: Number.isFinite(s.balance) ? s.balance : 0,
    mono: !!s.mono,
    limiter: s.limiter !== false,
    night: !!s.night
  };
}

// Older 10-band curves (32 Hz → 16 kHz) are resampled to the current bands.
const OLD_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export function fitEq(eq) {
  if (!Array.isArray(eq)) return BANDS.map(() => 0);
  if (eq.length === BANDS.length) return eq.map((g) => clampDb(Number(g) || 0));
  const from = eq.length === OLD_BANDS.length ? OLD_BANDS : null;
  if (!from) return BANDS.map(() => 0);
  return BANDS.map((f) => {
    const x = Math.log2(f);
    let i = from.findIndex((b) => b >= f);
    if (i <= 0) return clampDb(eq[i === 0 ? 0 : from.length - 1]);
    const t = (x - Math.log2(from[i - 1])) / (Math.log2(from[i]) - Math.log2(from[i - 1]));
    return clampDb(Math.round((eq[i - 1] + (eq[i] - eq[i - 1]) * t) * 2) / 2);
  });
}

export const clampDb = (g) => Math.max(-EQ_RANGE, Math.min(EQ_RANGE, g));

// Curves in the spirit of what sound engineers use: bass boosts cut the 400 Hz "mud",
// voice lifts the 1-5 kHz presence, small speakers get their bass at 150 Hz, not below.
export const PRESETS = [
  { id: 'flat', eq: [0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', eq: [6, 3, -1.5, 0, 0, 0, 0, 0] },
  { id: 'bassPlus', eq: [10, 5, -2.5, 0, 0, 1, 1, 0] },
  { id: 'vocal', eq: [-6, -3, -1, 2, 4, 3, 1, 0] },
  { id: 'movie', eq: [5, 2, -1, 0, 2, 2, 1, 1] },
  { id: 'music', eq: [4, 2, -1, -1, 0, 2, 3, 3] },
  { id: 'clarity', eq: [0, 0, -2, 0, 2, 4, 4, 3] },
  { id: 'laptop', eq: [-6, 4, 2, 0, 2, 3, 2, 0] },
  { id: 'night', eq: [-6, -3, 0, 1, 3, 2, 0, -1], night: true }
];

export const sameEq = (a, b) => a.length === b.length && a.every((g, i) => g === b[i]);
