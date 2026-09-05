export function checkPower(snapshot, expected, requireAcPerformance = false) {
  const profile = { source: snapshot.source, lowPowerMode: snapshot.lowPowerMode?.[snapshot.source] ?? null };
  if (requireAcPerformance && (profile.source !== 'AC Power' || profile.lowPowerMode !== 0)) {
    throw new Error('This capture requires AC power with the active Low Power Mode profile off. The power probe did not confirm both conditions.');
  }
  if (expected && (profile.source !== expected.source || profile.lowPowerMode !== expected.lowPowerMode)) {
    throw new Error('The active power source or Low Power Mode changed during this session. Repeat all comparison runs under a stable profile.');
  }
  return profile;
}
