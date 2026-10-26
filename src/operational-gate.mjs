export function requireOperationalActiveSince({ value, now = new Date(), canaryExpiresAt = null } = {}) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error("GFS_144H_OPERATIONAL_ACTIVE_SINCE_MISSING");
  if (!raw.endsWith("Z")) throw new Error("GFS_144H_OPERATIONAL_ACTIVE_SINCE_INVALID");
  const activeSinceMs = Date.parse(raw);
  if (!Number.isFinite(activeSinceMs)) throw new Error("GFS_144H_OPERATIONAL_ACTIVE_SINCE_INVALID");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now || "");
  if (!Number.isFinite(nowMs)) throw new Error("GFS_144H_OPERATIONAL_NOW_INVALID");
  if (activeSinceMs > nowMs) throw new Error("GFS_144H_OPERATIONAL_ACTIVE_SINCE_FUTURE");
  if (canaryExpiresAt !== null) {
    const canaryExpiresMs = Date.parse(canaryExpiresAt || "");
    if (!Number.isFinite(canaryExpiresMs)) throw new Error("CANARY_EXPIRY_UNVERIFIED");
    if (activeSinceMs <= canaryExpiresMs) {
      throw new Error("GFS_144H_OPERATIONAL_ACTIVE_SINCE_NOT_AFTER_CANARY");
    }
  }
  return new Date(activeSinceMs).toISOString();
}

export function evaluateOperationalGate({
  paidConfirmed,
  cutoverApproved,
  canaryExpiresAt,
  canaryActive,
  currentPublicReady,
  operationalActiveSince,
  now = new Date()
} = {}) {
  const reasons = [];
  const expiresMs = Date.parse(canaryExpiresAt || "");
  if (paidConfirmed !== true) reasons.push("WORKERS_PAID_NOT_CONFIRMED");
  if (cutoverApproved !== true) reasons.push("GFS_144H_OPERATIONAL_NOT_APPROVED");
  if (!Number.isFinite(expiresMs)) reasons.push("CANARY_EXPIRY_UNVERIFIED");
  else if (now.getTime() <= expiresMs || canaryActive === true) reasons.push("CANARY_STILL_ACTIVE");
  if (currentPublicReady !== true) reasons.push("SOURCE_V5_BASELINE_NOT_READY");
  let activeSince = null;
  try {
    activeSince = requireOperationalActiveSince({
      value: operationalActiveSince,
      now,
      canaryExpiresAt: Number.isFinite(expiresMs) ? canaryExpiresAt : null
    });
  } catch (error) {
    reasons.push(error.message);
  }
  return { status: reasons.length ? "BLOCKED" : "READY", reasons,
    evaluatedAt: now.toISOString(), canaryExpiresAt: Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : null,
    operationalActiveSince: activeSince };
}
