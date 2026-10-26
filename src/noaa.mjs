import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const NOMADS_PRODUCT_DIRECTORY = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/";
export const NOMADS_FILTER_ORIGIN = "https://nomads.ncep.noaa.gov";
export const KOREA_BOUNDS = Object.freeze({ left: 124.5, right: 132, bottom: 32, top: 39.5 });
export const MINIMUM_REQUEST_INTERVAL_MS = 10_000;
export const TRANSIENT_HTTP_STATUSES = Object.freeze([500, 502, 503, 504]);
export const DEFAULT_TRANSIENT_RETRY = Object.freeze({
  maxRetries: 2,
  baseDelayMs: MINIMUM_REQUEST_INTERVAL_MS,
  maxDelayMs: 40_000
});

export class DownloadBudget {
  constructor({ maxRequests, maxBytes, minimumIntervalMs = MINIMUM_REQUEST_INTERVAL_MS }) {
    this.maxRequests = maxRequests;
    this.maxBytes = maxBytes;
    this.minimumIntervalMs = minimumIntervalMs;
    this.requestsUsed = 0;
    this.bytesUsed = 0;
    this.lastRequestAt = null;
  }
  async beforeRequest(now = Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    if (this.requestsUsed >= this.maxRequests) throw new Error("GFS_REQUEST_BUDGET_EXCEEDED");
    let wait = 0;
    if (this.lastRequestAt !== null) {
      wait = this.minimumIntervalMs - (now - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
    }
    this.requestsUsed += 1;
    this.lastRequestAt = now + Math.max(0, wait);
  }
  assertLength(value) {
    if (value === null || value === undefined || value === "") return;
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("GFS_CONTENT_LENGTH_INVALID");
    if (this.bytesUsed + bytes > this.maxBytes) throw new Error("GFS_BYTE_BUDGET_EXCEEDED");
  }
  consume(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.bytesUsed + bytes > this.maxBytes) throw new Error("GFS_BYTE_BUDGET_EXCEEDED");
    this.bytesUsed += bytes;
  }
  snapshot() {
    return { requestsUsed: this.requestsUsed, bytesUsed: this.bytesUsed, maxRequests: this.maxRequests, maxBytes: this.maxBytes };
  }
}

export function parseRunDates(html) {
  return [...new Set([...String(html).matchAll(/gfs\.(\d{8})\//g)].map((match) => match[1]))].sort();
}

export function parseCycles(html) {
  return [...new Set([...String(html).matchAll(/href=["'](?:\.\/)?(00|06|12|18)\/?["']/g)].map((match) => match[1]))].sort();
}

export function selectLatestRun(dates, cycles, now = new Date()) {
  const results = listPublishedRuns(dates, cycles, now);
  if (!results.length) throw new Error("GFS_NO_PUBLISHED_RUN");
  return results.at(-1);
}

export function listPublishedRuns(dates, cycles, now = new Date()) {
  const results = [];
  for (const runDate of dates) for (const cycle of cycles[runDate] || []) {
    const modelRunAt = new Date(`${runDate.slice(0, 4)}-${runDate.slice(4, 6)}-${runDate.slice(6, 8)}T${cycle}:00:00Z`);
    if (modelRunAt <= now) results.push({ runDate, cycle, modelRunAt: modelRunAt.toISOString() });
  }
  results.sort((a, b) => a.modelRunAt.localeCompare(b.modelRunAt));
  return results;
}

export function buildFilterUrl({ runDate, cycle, forecastHour }) {
  if (!/^\d{8}$/.test(runDate) || !/^(00|06|12|18)$/.test(cycle) || !Number.isInteger(forecastHour) || forecastHour < 1 || forecastHour > 384) {
    throw new Error("GFS_FILTER_INPUT_INVALID");
  }
  const url = new URL("/cgi-bin/filter_gfs_0p25.pl", NOMADS_FILTER_ORIGIN);
  const values = {
    file: `gfs.t${cycle}z.pgrb2.0p25.f${String(forecastHour).padStart(3, "0")}`,
    lev_surface: "on",
    var_APCP: "on",
    subregion: "",
    leftlon: String(KOREA_BOUNDS.left),
    rightlon: String(KOREA_BOUNDS.right),
    toplat: String(KOREA_BOUNDS.top),
    bottomlat: String(KOREA_BOUNDS.bottom),
    dir: `/gfs.${runDate}/${cycle}/atmos`
  };
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url;
}

export function buildRawIndexUrl({ runDate, cycle, forecastHour }) {
  if (!/^\d{8}$/.test(runDate) || !/^(00|06|12|18)$/.test(cycle) || !Number.isInteger(forecastHour) || forecastHour < 1 || forecastHour > 384) {
    throw new Error("GFS_INDEX_INPUT_INVALID");
  }
  return new URL(
    `gfs.${runDate}/${cycle}/atmos/gfs.t${cycle}z.pgrb2.0p25.f${String(forecastHour).padStart(3, "0")}.idx`,
    NOMADS_PRODUCT_DIRECTORY
  );
}

async function responseBytes(response, budget) {
  budget.assertLength(response.headers.get("content-length"));
  const chunks = [];
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk);
    budget.consume(value.byteLength);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function retryConfiguration(value = {}) {
  const options = { ...DEFAULT_TRANSIENT_RETRY, ...value };
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 4
    || !Number.isSafeInteger(options.baseDelayMs) || options.baseDelayMs < MINIMUM_REQUEST_INTERVAL_MS
    || !Number.isSafeInteger(options.maxDelayMs) || options.maxDelayMs < options.baseDelayMs || options.maxDelayMs > 120_000) {
    throw new Error("GFS_TRANSIENT_RETRY_CONFIGURATION_INVALID");
  }
  return options;
}

function statusFailure(prefix, status, exhausted = false) {
  if (status === 403) return `${prefix}_403_FORBIDDEN`;
  if (status === 404) return `${prefix}_404_NOT_FOUND`;
  if (exhausted) return `${prefix}_${status}_RETRY_EXHAUSTED`;
  return `${prefix}_${status}`;
}

async function accountRejectedResponse(response, budget) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && declared !== "") {
    budget.assertLength(declared);
    budget.consume(Number(declared));
  }
  await response.body?.cancel?.();
}

export async function fetchWithTransientRetry({
  url, budget, fetchImpl = fetch, options, acceptedStatuses = [200], errorPrefix = "GFS_HTTP",
  retry = {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now
}) {
  const configured = retryConfiguration(retry);
  const accepted = new Set(acceptedStatuses);
  for (let attempt = 0; attempt <= configured.maxRetries; attempt += 1) {
    try {
      await budget.beforeRequest(now(), sleep);
    } catch (error) {
      if (attempt > 0 && error?.message === "GFS_REQUEST_BUDGET_EXCEEDED") {
        throw new Error("GFS_TRANSIENT_RETRY_BUDGET_EXHAUSTED");
      }
      throw error;
    }
    const response = await fetchImpl(url, options);
    if (accepted.has(response.status)) return response;
    const transient = TRANSIENT_HTTP_STATUSES.includes(response.status);
    const exhausted = transient && attempt === configured.maxRetries;
    await accountRejectedResponse(response, budget);
    if (!transient || exhausted) throw new Error(statusFailure(errorPrefix, response.status, exhausted));
    const delay = Math.min(configured.maxDelayMs, configured.baseDelayMs * (2 ** attempt));
    await sleep(delay);
  }
  throw new Error(`${errorPrefix}_RETRY_STATE_INVALID`);
}

export async function fetchText(url, budget, fetchImpl = fetch, retryOptions = {}) {
  const response = await fetchWithTransientRetry({
    url, budget, fetchImpl, retry: retryOptions,
    options: { redirect: "manual", headers: { Accept: "text/html" } }
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(await responseBytes(response, budget));
}

export async function verifyRunComplete(run, finalForecastHour, budget, fetchImpl = fetch, retryOptions = {}) {
  let response;
  try {
    response = await fetchWithTransientRetry({
      url: buildRawIndexUrl({ ...run, forecastHour: finalForecastHour }), budget, fetchImpl,
      acceptedStatuses: [200, 206, 404], errorPrefix: "GFS_INDEX_HTTP", retry: retryOptions,
      options: { method: "GET", redirect: "manual", headers: { Accept: "text/plain", Range: "bytes=0-0" } }
    });
  } catch (error) {
    throw error;
  }
  const available = response.status !== 404;
  await accountRejectedResponse(response, budget);
  return available;
}

export async function downloadFrame({ run, forecastHour, destination, budget, fetchImpl = fetch, retryOptions = {} }) {
  const response = await fetchWithTransientRetry({
    url: buildFilterUrl({ ...run, forecastHour }), budget, fetchImpl, retry: retryOptions,
    options: { redirect: "manual", headers: { Accept: "application/octet-stream, application/x-grib2" } }
  });
  const body = await responseBytes(response, budget);
  if (body.byteLength < 20 || body.subarray(0, 4).toString("ascii") !== "GRIB" || body.subarray(-4).toString("ascii") !== "7777") {
    throw new Error("GFS_GRIB_ENVELOPE_INVALID");
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, body);
  return { forecastHour, bytes: body.byteLength, destination };
}
