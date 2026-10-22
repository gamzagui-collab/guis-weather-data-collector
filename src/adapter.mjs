import { parseJson, sha256, validateForecastShard, validateGridShard } from "./contracts.mjs";
import { STATUS_KEY, readLatestPublication } from "./publisher.mjs";
import { assertObjectStore } from "./object-store.mjs";

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function coordinate(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function selectPoint(points, latitude, longitude) {
  if (!coordinate(latitude, -90, 90) || !coordinate(longitude, -180, 180)) throw new Error("INVALID_COORDINATE");
  let result = null;
  for (const point of points) {
    const distanceKm = haversineKm(latitude, longitude, point.latitude, point.longitude);
    if (!result || distanceKm < result.distanceKm) result = { ...point, distanceKm };
  }
  return result;
}

async function verifiedObject(store, descriptor, code) {
  const body = await store.get(descriptor.key);
  if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.sha256) throw new Error(`${code}_INTEGRITY_FAILED`);
  return parseJson(body, `${code}_JSON_INVALID`);
}

async function readCollectorStatus(store) {
  const body = await store.tryGet(STATUS_KEY);
  if (!body) return null;
  const value = parseJson(body, "GFS_STATUS_JSON_INVALID");
  return {
    status: value.status,
    attemptedRunId: value.attemptedRunId,
    attemptedAt: value.attemptedAt,
    completedAt: value.completedAt,
    failureCode: value.failureCode
  };
}

export async function readGfsForLocation(store, {
  latitude,
  longitude,
  enabled = false,
  now = new Date()
} = {}) {
  if (!enabled) return { status: "DISABLED", provider: "NOAA/NCEP", model: "GFS", values: [] };
  assertObjectStore(store);
  try {
    const [{ latest, manifest }, collection] = await Promise.all([readLatestPublication(store), readCollectorStatus(store)]);
    const grid = await verifiedObject(store, manifest.grid, "GFS_GRID");
    validateGridShard(grid);
    const point = selectPoint(grid.grid.points, latitude, longitude);
    const values = [];
    for (const descriptor of manifest.forecasts) {
      const forecast = await verifiedObject(store, descriptor, "GFS_FORECAST");
      validateForecastShard(forecast, grid.grid.points.length);
      const source = forecast.frame.values.find((item) => item.pointId === point.id);
      if (!source) throw new Error("GFS_GRID_VALUE_NOT_FOUND");
      values.push({
        provider: "NOAA/NCEP",
        model: "GFS",
        broker: null,
        source: manifest.source,
        product: manifest.product,
        variable: manifest.variable,
        rawValue: source.rawValue,
        quantitativeValue: source.quantitativeValue,
        unit: forecast.frame.unit,
        sourceUnit: forecast.frame.sourceUnit,
        accumulationPeriod: forecast.frame.accumulationPeriod,
        accumulationStart: forecast.frame.accumulationStart,
        accumulationEnd: forecast.frame.accumulationEnd,
        modelRunAt: manifest.modelRunAt,
        issuedAt: manifest.publishedAt,
        validAt: forecast.frame.validAt,
        fetchedAt: manifest.fetchedAt,
        status: source.status,
        latitude,
        longitude,
        gridLatitude: point.latitude,
        gridLongitude: point.longitude,
        gridDistanceKm: point.distanceKm,
        spatialProcessing: "NEAREST_GRID_POINT_NO_INTERPOLATION",
        sourceDataSha256: forecast.frame.sourceDataSha256,
        frameId: forecast.frameId
      });
    }
    const stale = Date.parse(latest.latestValidAt) < now.valueOf();
    return {
      status: stale ? "STALE" : "AVAILABLE",
      provider: "NOAA/NCEP",
      model: "GFS",
      modelRunAt: latest.modelRunAt,
      latestValidAt: latest.latestValidAt,
      gridPoint: point,
      values,
      collection
    };
  } catch (error) {
    return {
      status: error.message.includes("JSON") || error.message.includes("INVALID") ? "PARSE_ERROR" : "FETCH_ERROR",
      provider: "NOAA/NCEP",
      model: "GFS",
      errorCode: String(error.message || "GFS_ADAPTER_FAILED").slice(0, 120),
      values: []
    };
  }
}

export function assessKmaGfsComparison(kma, gfs) {
  if (kma?.status !== "AVAILABLE" || gfs?.status !== "AVAILABLE") return { comparable: false, code: "VALUE_UNAVAILABLE" };
  if (Date.parse(kma.validAt || "") !== Date.parse(gfs.validAt || "")) return { comparable: false, code: "VALID_TIME_MISMATCH" };
  if (kma.accumulationPeriod !== "PT1H" || gfs.accumulationPeriod !== "PT1H") {
    return { comparable: false, code: "INCOMPATIBLE_ACCUMULATION" };
  }
  if (Date.parse(kma.accumulationStart || "") !== Date.parse(gfs.accumulationStart || "") ||
      Date.parse(kma.accumulationEnd || "") !== Date.parse(gfs.accumulationEnd || "")) {
    return { comparable: false, code: "ACCUMULATION_WINDOW_MISMATCH" };
  }
  if (kma.unit !== "mm" || gfs.unit !== "mm") return { comparable: false, code: "UNIT_MISMATCH" };
  if (!Number.isFinite(kma.quantitativeValue) || !Number.isFinite(gfs.quantitativeValue)) {
    return { comparable: false, code: "NON_QUANTITATIVE_VALUE" };
  }
  return { comparable: true, code: "SAME_VALID_TIME_AND_WINDOW_PT1H_MM" };
}

export function isHeatmapEligible(value) {
  return value?.status === "AVAILABLE" && value.unit === "mm" && value.accumulationPeriod === "PT1H" &&
    Number.isFinite(value.quantitativeValue) && value.quantitativeValue >= 0;
}
