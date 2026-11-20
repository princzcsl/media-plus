// 10 bands, same layout as most gaming / studio equalizers.
export const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_RANGE = 12;
export const BAND_Q = 1.4;

export const bandType = (i) => (i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking');

export const bandLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

export const NEUTRAL = Object.freeze({
  boost: 100,
  eq: Object.freeze(BANDS.map(() => 0)),
  balance: 0,
  mono: false,
  limiter: true
});

export const freshState = () => ({ ...NEUTRAL, eq: [...NEUTRAL.eq] });

export const isNeutral = (s) =>
  s.boost === 100 && s.balance === 0 && !s.mono && s.eq.every((g) => g === 0);

export const PRESETS = [
  { id: 'flat', eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass', eq: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'bassMax', eq: [10, 9, 7, 4, 1, 0, 0, 0, 0, 0] },
  { id: 'treble', eq: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { id: 'vocal', eq: [-4, -3, -1, 0, 2, 4, 4, 3, 1, 0] },
  { id: 'movie', eq: [4, 3, 1, 0, -1, 1, 2, 2, 3, 2] },
  { id: 'music', eq: [3, 2, 1, 0, -1, 0, 1, 2, 3, 3] },
  { id: 'fps', eq: [-3, -2, -1, 0, 1, 3, 5, 5, 3, 1] },
  { id: 'night', eq: [-4, -3, -2, 0, 0, 1, 1, 1, 0, 0], limiter: true }
];

export const sameEq = (a, b) => a.length === b.length && a.every((g, i) => g === b[i]);
