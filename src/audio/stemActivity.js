// A measured noise floor, not an instrument classifier. Keep the transition
// well below soft musical parts while rejecting the one-bit PCM16 residual
// floor found in the reference evaluations. Amplitudes are linear RMS/dBFS.
export const STEM_ACTIVITY = Object.freeze({ floorDb: -80, fullDb: -70, transientDb: -45 })
const floor = 10 ** (STEM_ACTIVITY.floorDb / 20)
const full = 10 ** (STEM_ACTIVITY.fullDb / 20)
const transient = 10 ** (STEM_ACTIVITY.transientDb / 20)

// Keep the existing drum transient criterion while allowing sustained soft
// sources that the old -35 dBFS whole-stem gate hid. A few weak leakage spikes
// alone are insufficient; the 95th percentile must also support a soft part.
export function hasStemSignal(peakRms, percentile95Rms) {
  return peakRms >= transient || percentile95Rms >= full
}

export function signalActivity(rms) {
  if (!(rms > floor)) return 0
  if (rms >= full) return 1
  const amount = (rms - floor) / (full - floor)
  return amount * amount * (3 - 2 * amount)
}
