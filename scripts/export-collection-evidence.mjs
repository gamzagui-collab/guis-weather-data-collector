import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

if (!process.env.GITHUB_OUTPUT) throw new Error("GFS_EVIDENCE_GITHUB_OUTPUT_MISSING");
const target = resolve(process.argv[2] || ".mock-r2-144h/collection-evidence.json");
let evidence = null;
try {
  evidence = JSON.parse(await readFile(target, "utf8"));
} catch {
  evidence = null;
}
const requestsUsed = Number(evidence?.budget?.requestsUsed || 0);
const bytesUsed = Number(evidence?.budget?.bytesUsed || 0);
if (!Number.isSafeInteger(requestsUsed) || requestsUsed < 0 || requestsUsed > 135
  || !Number.isSafeInteger(bytesUsed) || bytesUsed < 0 || bytesUsed > 20 * 1024 * 1024) {
  throw new Error("GFS_COLLECTION_EVIDENCE_BUDGET_INVALID");
}
const outcome = String(evidence?.result?.status || (evidence?.status === "FAILED" ? "COLLECTION_FAILED" : "UNKNOWN"));
if (!/^[A-Z0-9_]{3,80}$/.test(outcome)) throw new Error("GFS_COLLECTION_EVIDENCE_OUTCOME_INVALID");
await appendFile(process.env.GITHUB_OUTPUT,
  `collection_outcome=${outcome}\nrequests_used=${requestsUsed}\nbytes_used=${bytesUsed}\n`, "utf8");
