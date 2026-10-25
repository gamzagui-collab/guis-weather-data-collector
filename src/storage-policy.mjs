export const R2_FREE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
export const R2_STORAGE_STOP_BYTES = 8 * 1024 * 1024 * 1024;
export const GFS_ESTIMATED_INDEXED_RUN_BYTES = 20 * 1024 * 1024;
// A 144H publication expands the filtered GRIB download into provenance-rich
// forecast shards and window indexes. Keep its storage reservation independent
// Measured 2026-10-26: source publication 51,939,755 bytes plus compact v5 index
// 21,885,921 bytes = 73,825,676 bytes. Reserve 80 MiB per future indexed run
// so the 8 GiB soft stop includes the complete source and derived index chain.
export const GFS_ESTIMATED_144H_INDEXED_RUN_BYTES = 80 * 1024 * 1024;

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
