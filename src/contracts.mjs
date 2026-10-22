import { createHash } from "node:crypto";

export const SOURCE_SCHEMA = "weather.gfs.grid.v1";
export const GRID_SCHEMA = "weather.gfs.grid-shard.v1";
export const FORECAST_SCHEMA = "weather.gfs.forecast-shard.v1";
export const MANIFEST_SCHEMA = "weather.gfs.manifest.v1";
export const LATEST_SCHEMA = "weather.gfs.latest.v2";
export const STATUS_SCHEMA = "weather.gfs.collector-status.v1";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const SOURCE_UNITS = new Set(["kg m-2", "kg m**-2"]);

export function validateCoverage(coverage) {
  if (!coverage || coverage.kind !== "FORECAST_HOUR_SET" || !["48H", "CUSTOM"].includes(coverage.label)) {
    throw new Error("GFS_COVERAGE_INVALID");
  }
  const expected = coverage.expectedForecastHours;
  const collected = coverage.collectedForecastHours;
  if (!Array.isArray(expected) || !expected.length || !Array.isArray(collected) || coverage.complete !== true) {
    throw new Error("GFS_COVERAGE_INVALID");
  }
  const validList = (values) => values.every((hour, index) => Number.isInteger(hour) && hour >= 1 && hour <= 384 &&
    (index === 0 || values[index - 1] < hour));
  if (!validList(expected) || !validList(collected) || JSON.stringify(expected) !== JSON.stringify(collected) ||
      coverage.startForecastHour !== expected[0] || coverage.endForecastHour !== expected.at(-1)) {
    throw new Error("GFS_COVERAGE_INCOMPLETE");
  }
  if (coverage.label === "48H" && JSON.stringify(expected) !== JSON.stringify(Array.from({ length: 48 }, (_, index) => index + 1))) {
    throw new Error("GFS_48H_COVERAGE_INVALID");
  }
  return coverage;
}

export function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function encodeObject(value) {
  const body = Buffer.from(canonicalJson(value), "utf8");
  return { body, bytes: body.byteLength, sha256: sha256(body) };
}

export function normalizeRunId(modelRunAt) {
  if (!ISO.test(modelRunAt || "")) throw new Error("GFS_MODEL_RUN_INVALID");
  return modelRunAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function instant(value, code) {
  if (!ISO.test(value || "") || !Number.isFinite(Date.parse(value))) throw new Error(code);
}

export function frameId(frame) {
  const period = String(frame?.accumulationPeriod || "").toLowerCase();
  if (!/^pt\d+(?:\.\d+)?h$/.test(period)) throw new Error("GFS_ACCUMULATION_PERIOD_INVALID");
  const safeInstant = (value) => {
    instant(value, "GFS_FRAME_TIME_INVALID");
    return value.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").toLowerCase();
  };
  if (!Number.isInteger(frame?.forecastHour) || frame.forecastHour < 1 || frame.forecastHour > 384) {
    throw new Error("GFS_FORECAST_HOUR_INVALID");
  }
  return `f${String(frame.forecastHour).padStart(3, "0")}-${period}-${safeInstant(frame.accumulationStart)}-${safeInstant(frame.accumulationEnd)}`;
}

export function validateDataset(dataset) {
  if (dataset?.schemaVersion !== SOURCE_SCHEMA) throw new Error("GFS_SCHEMA_INVALID");
  if (dataset.provider !== "NOAA/NCEP" || dataset.model !== "GFS" || dataset.broker !== null || dataset.variable !== "precipitation") {
    throw new Error("GFS_IDENTITY_INVALID");
  }
  instant(dataset.modelRunAt, "GFS_MODEL_RUN_INVALID");
  instant(dataset.fetchedAt, "GFS_FETCHED_AT_INVALID");
  if (dataset.publishedAt !== null) instant(dataset.publishedAt, "GFS_PUBLISHED_AT_INVALID");
  if (!SOURCE_UNITS.has(dataset.sourceUnit) || dataset.unit !== "mm") throw new Error("GFS_UNIT_INVALID");
  if (dataset.area?.name !== "Republic of Korea" || !dataset.area?.bounds) throw new Error("GFS_AREA_INVALID");
  if (dataset.coverage !== undefined && dataset.coverage !== null) validateCoverage(dataset.coverage);
  if (dataset.grid?.type !== "regular_ll" || dataset.grid?.resolutionDegrees !== 0.25 || !Array.isArray(dataset.grid.points)) {
    throw new Error("GFS_GRID_INVALID");
  }
  const points = new Map();
  for (const point of dataset.grid.points) {
    if (!Number.isInteger(point?.id) || points.has(point.id) || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
      throw new Error("GFS_GRID_POINT_INVALID");
    }
    points.set(point.id, point);
  }
  if (!points.size || !Array.isArray(dataset.frames) || !dataset.frames.length) throw new Error("GFS_DATA_EMPTY");
  const contracts = new Set();
  const collectedHours = new Set();
  for (const frame of dataset.frames) {
    if (frame.modelRunAt !== dataset.modelRunAt) throw new Error("GFS_FRAME_RUN_MISMATCH");
    for (const field of ["validAt", "accumulationStart", "accumulationEnd"]) instant(frame[field], "GFS_FRAME_TIME_INVALID");
    if (frame.validAt !== frame.accumulationEnd) throw new Error("GFS_VALID_END_MISMATCH");
    if (Date.parse(frame.accumulationStart) >= Date.parse(frame.accumulationEnd)) throw new Error("GFS_ACCUMULATION_INVALID");
    if (!SOURCE_UNITS.has(frame.sourceUnit) || frame.unit !== "mm") throw new Error("GFS_FRAME_UNIT_INVALID");
    if (!/^[a-f0-9]{64}$/.test(frame.sourceDataSha256 || "")) throw new Error("GFS_SOURCE_HASH_INVALID");
    const id = frameId(frame);
    collectedHours.add(frame.forecastHour);
    if (contracts.has(id)) throw new Error("GFS_FRAME_DUPLICATE");
    contracts.add(id);
    if (!Array.isArray(frame.values) || frame.values.length !== points.size) throw new Error("GFS_FRAME_GRID_LENGTH_MISMATCH");
    const covered = new Set();
    for (const value of frame.values) {
      if (!points.has(value?.pointId) || covered.has(value.pointId)) throw new Error("GFS_VALUE_POINT_INVALID");
      covered.add(value.pointId);
      if (value.status === "MISSING") {
        if (value.rawValue !== null || value.quantitativeValue !== null) throw new Error("GFS_MISSING_VALUE_INVALID");
      } else if (value.status === "AVAILABLE") {
        if (typeof value.rawValue !== "string" || !Number.isFinite(value.quantitativeValue) || value.quantitativeValue < 0) {
          throw new Error("GFS_AVAILABLE_VALUE_INVALID");
        }
      } else throw new Error("GFS_VALUE_STATUS_INVALID");
    }
  }
  if (dataset.coverage && JSON.stringify([...collectedHours].sort((a, b) => a - b)) !== JSON.stringify(dataset.coverage.collectedForecastHours)) {
    throw new Error("GFS_FRAME_COVERAGE_MISMATCH");
  }
  return dataset;
}

export function splitDataset(dataset) {
  validateDataset(dataset);
  const runId = normalizeRunId(dataset.modelRunAt);
  const common = {
    provider: dataset.provider,
    model: dataset.model,
    broker: dataset.broker,
    source: dataset.source,
    sourceUrl: dataset.sourceUrl,
    product: dataset.product,
    variable: dataset.variable,
    modelRunAt: dataset.modelRunAt,
    publishedAt: dataset.publishedAt,
    fetchedAt: dataset.fetchedAt,
    sourceUnit: dataset.sourceUnit,
    unit: dataset.unit,
    area: dataset.area,
    coverage: dataset.coverage ?? null
  };
  const grid = {
    schemaVersion: GRID_SCHEMA,
    ...common,
    grid: dataset.grid,
    status: "AVAILABLE"
  };
  const forecasts = dataset.frames.map((frame) => ({
    schemaVersion: FORECAST_SCHEMA,
    ...common,
    frameId: frameId(frame),
    frame,
    status: "AVAILABLE"
  }));
  return { runId, common, grid, forecasts };
}

export function validateGridShard(value) {
  if (value?.schemaVersion !== GRID_SCHEMA || value.provider !== "NOAA/NCEP" || value.model !== "GFS" || value.grid?.type !== "regular_ll") {
    throw new Error("GFS_GRID_SHARD_INVALID");
  }
  if (!Array.isArray(value.grid.points) || !value.grid.points.length) throw new Error("GFS_GRID_SHARD_EMPTY");
  return value;
}

export function validateForecastShard(value, pointCount) {
  if (value?.schemaVersion !== FORECAST_SCHEMA || value.provider !== "NOAA/NCEP" || value.model !== "GFS") {
    throw new Error("GFS_FORECAST_SHARD_INVALID");
  }
  if (value.frameId !== frameId(value.frame) || value.frame.modelRunAt !== value.modelRunAt) throw new Error("GFS_FORECAST_CONTRACT_INVALID");
  if (!Array.isArray(value.frame.values) || value.frame.values.length !== pointCount) throw new Error("GFS_FORECAST_VALUES_INVALID");
  return value;
}

export function parseJson(buffer, code = "GFS_JSON_INVALID") {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new Error(code);
  }
}
