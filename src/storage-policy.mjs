export const R2_FREE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
export const R2_STORAGE_STOP_BYTES = 8 * 1024 * 1024 * 1024;
export const GFS_ESTIMATED_INDEXED_RUN_BYTES = 20 * 1024 * 1024;
// A 144H publication expands the filtered GRIB download into provenance-rich
// forecast shards and window indexes. Keep its storage reservation independent
// from the upstream download ceiling so the soft stop remains conservative.
export const GFS_ESTIMATED_144H_INDEXED_RUN_BYTES = 64 * 1024 * 1024;

export function evaluateStorageProtection({
  currentBytes,
  estimatedNextRunBytes = GFS_ESTIMATED_INDEXED_RUN_BYTES,
  stopBytes = R2_STORAGE_STOP_BYTES
}) {
  if (!Number.isSafeInteger(currentBytes) || currentBytes < 0
    || !Number.isSafeInteger(estimatedNextRunBytes) || estimatedNextRunBytes < 1
    || !Number.isSafeInteger(stopBytes) || stopBytes < 1) {
    throw new Error("GFS_STORAGE_POLICY_INPUT_INVALID");
  }
  const projectedBytes = currentBytes + estimatedNextRunBytes;
  return {
    status: projectedBytes >= stopBytes ? "BLOCKED" : "ALLOW",
    currentBytes,
    estimatedNextRunBytes,
    projectedBytes,
    stopBytes,
    freeTierBytes: R2_FREE_STORAGE_BYTES,
    reason: projectedBytes >= stopBytes ? "R2_STORAGE_PROTECTION_LIMIT" : null
  };
}
