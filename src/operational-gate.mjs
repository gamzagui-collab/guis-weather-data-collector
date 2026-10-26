export function evaluateOperationalGate({
  paidConfirmed,
  cutoverApproved,
  canaryExpiresAt,
  canaryActive,
  currentPublicReady,
  now = new Date()
} = {}) {
  const reasons = [];
  const expiresMs = Date.parse(canaryExpiresAt || "");
  if (paidConfirmed !== true) reasons.push("WORKERS_PAID_NOT_CONFIRMED");
  if (cutoverApproved !== true) reasons.push("GFS_144H_OPERATIONAL_NOT_APPROVED");
  if (!Number.isFinite(expiresMs)) reasons.push("CANARY_EXPIRY_UNVERIFIED");
  else if (now.getTime() <= expiresMs || canaryActive === true) reasons.push("CANARY_STILL_ACTIVE");
  if (currentPublicReady !== true) reasons.push("SOURCE_V5_BASELINE_NOT_READY");
  return { status: reasons.length ? "BLOCKED" : "READY", reasons,
    evaluatedAt: now.toISOString(), canaryExpiresAt: Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : null };
}
