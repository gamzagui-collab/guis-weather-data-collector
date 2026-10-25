function instant(value, code) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function nonNegativeInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

export function evaluateCanaryPolicy({
  enabled = false,
  now = new Date(),
  startsAt = null,
  expiresAt = null,
  publicationLimit = 0,
  publishedCount = 0
} = {}) {
  if (!enabled) return { enabled: false, allowUpstream: true, status: "DISABLED" };
  const nowMs = instant(now instanceof Date ? now.toISOString() : now, "GFS_CANARY_NOW_INVALID");
  const startsMs = instant(startsAt, "GFS_CANARY_START_INVALID");
  const expiresMs = instant(expiresAt, "GFS_CANARY_EXPIRY_INVALID");
  if (expiresMs <= startsMs) throw new Error("GFS_CANARY_WINDOW_INVALID");
  const limit = nonNegativeInteger(publicationLimit, "GFS_CANARY_PUBLICATION_LIMIT_INVALID");
  const used = nonNegativeInteger(publishedCount, "GFS_CANARY_PUBLISHED_COUNT_INVALID");
  if (limit < 1) throw new Error("GFS_CANARY_PUBLICATION_LIMIT_INVALID");
  const base = {
    enabled: true,
    startsAt: new Date(startsMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    publicationLimit: limit,
    publishedCount: used,
    remainingPublications: Math.max(0, limit - used)
  };
  if (nowMs < startsMs) return { ...base, allowUpstream: false, status: "CANARY_NOT_STARTED" };
  if (nowMs >= expiresMs) return { ...base, allowUpstream: false, status: "CANARY_EXPIRED" };
  if (used >= limit) return { ...base, allowUpstream: false, status: "CANARY_PUBLICATION_LIMIT_REACHED" };
  return { ...base, allowUpstream: true, status: "CANARY_ACTIVE" };
}

export function canaryPolicyFromEnvironment(env = process.env, now = new Date()) {
  return evaluateCanaryPolicy({
    enabled: env.GFS_144H_CANARY_ENABLED === "true",
    now,
    startsAt: env.GFS_144H_CANARY_START_AT,
    expiresAt: env.GFS_144H_CANARY_EXPIRES_AT,
    publicationLimit: env.GFS_144H_CANARY_PUBLICATION_LIMIT,
    publishedCount: env.GFS_144H_CANARY_PUBLISHED_COUNT
  });
}
