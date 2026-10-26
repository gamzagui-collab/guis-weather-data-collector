import { evaluateOperationalGate } from "../src/operational-gate.mjs";

const result = evaluateOperationalGate({
  paidConfirmed: process.env.WORKERS_PAID_CONFIRMED === "true",
  cutoverApproved: process.env.GFS_144H_OPERATIONAL_APPROVED === "true",
  canaryExpiresAt: process.env.GFS_144H_CANARY_EXPIRES_AT,
  canaryActive: process.env.GFS_144H_CANARY_ACTIVE === "true",
  currentPublicReady: process.env.GFS_144H_PUBLIC_READY === "true",
  operationalActiveSince: process.env.GFS_144H_OPERATIONAL_ACTIVE_SINCE,
  now: new Date()
});
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== "READY") throw new Error(`GFS_144H_OPERATIONAL_GATE_BLOCKED:${result.reasons.join(",")}`);
