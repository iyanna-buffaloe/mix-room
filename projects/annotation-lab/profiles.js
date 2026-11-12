export const PROFILES = {
  drums: {
    label: '6-part drums',
    description: 'Kick, snare, toms, hi-hat, ride, and crash. Full songs are separated into instruments first.',
    keys: ['kick', 'snare', 'toms', 'hihat', 'ride', 'crash'],
    isolatedLabel: 'These files are already isolated drum tracks',
  },
  vocals: {
    label: 'Vocal separation',
    description: 'Lead and backing vocals. Full songs are separated into instruments first.',
    keys: ['lead_vocals', 'backing_vocals'],
    isolatedLabel: 'These files are already isolated vocal tracks',
  },
  quick: {
    label: 'Quick · 6 instruments',
    description: 'Bass, drums, vocals, guitar, piano, and other, using BS-Roformer SW in one pass.',
    keys: ['bass', 'drums', 'vocals', 'guitar', 'piano', 'other'],
  },
}

export const LABELS = ['genuine', 'bleed_absent', 'uncertain']

export function validateIntervals(intervals, duration) {
  if (!Array.isArray(intervals) || intervals.length > 2000) throw new Error('Use at most 2,000 intervals per stem.')
  return intervals.map(interval => {
    const { start, end, label } = interval ?? {}
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.001) {
      throw new Error('Each interval needs a start ≥ 0 and an end after the start, within the song.')
    }
    if (!LABELS.includes(label)) throw new Error('Choose Genuine, Bleed / absent, or Uncertain.')
    return { start, end: Math.min(end, duration), label }
  })
}
