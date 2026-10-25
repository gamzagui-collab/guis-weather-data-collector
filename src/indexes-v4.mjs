import { encodeObject, sha256, validateForecastShard, validateGridShard } from "./contracts.mjs";
import { GFS_144H_NAMESPACE, gfs144ScopedKey, gfs144Windows } from "./horizon-144.mjs";

export const INDEX_V4_VERSION = "v4";
export const INDEX_V4_TILE_SIZE = 4;
export const INDEX_V4_MANIFEST_SCHEMA = "weather.gfs.range-index-manifest.v4";
export const INDEX_V4_SPATIAL_SCHEMA = "weather.gfs.range-spatial-catalog.v4";
export const INDEX_V4_SEGMENT_SCHEMA = "weather.gfs.point-window-segment.v4";
export const INDEX_V4_ROUTE_SCHEMA = "weather.gfs.point-range-route.v4";
export const INDEX_V4_VALUE_SCHEMA = Object.freeze([
  "frameId", "forecastHour", "validAt", "accumulationStart", "accumulationEnd", "accumulationPeriod",
  "sourceUnit", "unit", "rawValue", "quantitativeValue", "status", "sourceDataSha256",
  "sourceShardKey", "sourceShardBytes", "sourceShardSha256"
]);

const prefixFor = (runId) => gfs144ScopedKey(`runs/${runId}/indexes/${INDEX_V4_VERSION}`);
export const indexV4ManifestKey = (runId) => `${prefixFor(runId)}/manifest.json`;
export const indexV4SpatialKey = (runId, tileId) => `${prefixFor(runId)}/spatial/${tileId}.json`;
export const indexV4PointKey = (runId, pointId) => `${prefixFor(runId)}/points/p${String(pointId).padStart(4, "0")}.ndjson`;
export const indexV4RouteKey = (runId, pointId) => `${prefixFor(runId)}/routes/p${String(pointId).padStart(4, "0")}.json`;

function descriptor(value, code) {
  if (!value || typeof value.key !== "string" || !value.key.startsWith(`${GFS_144H_NAMESPACE}/`)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || !/^[a-f0-9]{64}$/.test(value.sha256 || "")) {
    throw new Error(code);
  }
  return { key: value.key, bytes: value.bytes, sha256: value.sha256 };
}

function sameDescriptor(left, right) {
  return left?.key === right?.key && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
}

function regularGrid(grid) {
  validateGridShard(grid);
  const { points, Ni: columns, Nj: rows } = grid.grid;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || rows * columns !== points.length) {
    throw new Error("GFS_INDEX_V4_GRID_SHAPE_INVALID");
  }
  const latitudes = [];
  const longitudes = [];
  const pointIds = [];
  for (let row = 0; row < rows; row += 1) {
    const latitude = points[row * columns]?.latitude;
    latitudes.push(latitude);
    for (let column = 0; column < columns; column += 1) {
      const point = points[row * columns + column];
      if (!point || point.latitude !== latitude || !Number.isFinite(point.longitude) || !Number.isInteger(point.id)) {
        throw new Error("GFS_INDEX_V4_GRID_NOT_REGULAR_ROW_MAJOR");
      }
      if (row === 0) longitudes.push(point.longitude);
      else if (point.longitude !== longitudes[column]) throw new Error("GFS_INDEX_V4_GRID_NOT_REGULAR_ROW_MAJOR");
      pointIds.push(point.id);
    }
  }
  if (new Set(pointIds).size !== points.length || new Set(latitudes).size !== rows
    || new Set(longitudes).size !== columns) throw new Error("GFS_INDEX_V4_GRID_AXIS_INVALID");
  return { points, columns, rows, latitudes, longitudes, pointIds };
}

function sourceContracts(forecasts, pointCount) {
  return forecasts.map(({ descriptor: source, value }) => {
    const sourceShard = descriptor(source, "GFS_INDEX_V4_SOURCE_SHARD_INVALID");
    validateForecastShard(value, pointCount);
    if (value.frameId !== source.frameId) throw new Error("GFS_INDEX_V4_FORECAST_MISMATCH");
    return {
      frameId: value.frameId,
      forecastHour: value.frame.forecastHour,
      validAt: value.frame.validAt,
      accumulationStart: value.frame.accumulationStart,
      accumulationEnd: value.frame.accumulationEnd,
      accumulationPeriod: value.frame.accumulationPeriod,
      sourceUnit: value.frame.sourceUnit,
      unit: value.frame.unit,
      sourceDataSha256: value.frame.sourceDataSha256,
      sourceShard
    };
  });
}

function tileId(row, column) {
  return `r${String(row).padStart(2, "0")}-c${String(column).padStart(2, "0")}`;
}

function segmentValue({ runId, modelRunAt, sourceManifest, point, id, contracts, valueMaps, contractIndexes,
  forecastHours, startForecastHour, endForecastHour, derivation = null }) {
  const rows = contracts.map((contract) => {
    const item = valueMaps[contractIndexes.get(contract.frameId)].get(point.id);
    if (!item) throw new Error("GFS_INDEX_V4_POINT_VALUE_MISSING");
    return [
      contract.frameId, contract.forecastHour, contract.validAt, contract.accumulationStart,
      contract.accumulationEnd, contract.accumulationPeriod, contract.sourceUnit, contract.unit,
      item.rawValue, item.quantitativeValue, item.status, contract.sourceDataSha256,
      contract.sourceShard.key, contract.sourceShard.bytes, contract.sourceShard.sha256
    ];
  });
  return {
    schemaVersion: INDEX_V4_SEGMENT_SCHEMA,
    status: "AVAILABLE",
    runId,
    modelRunAt,
    sourceManifest,
    point: { pointId: point.id, latitude: point.latitude, longitude: point.longitude },
    window: { id, startForecastHour, endForecastHour, forecastHours, ...(derivation ? { derivation } : {}) },
    valueSchema: [...INDEX_V4_VALUE_SCHEMA],
    rows
  };
}

export function buildRangeIndexObjects({ runId, sourceManifest, grid, forecasts, tileSize = INDEX_V4_TILE_SIZE }) {
  if (!/^\d{8}T\d{6}Z$/.test(runId || "")) throw new Error("GFS_INDEX_V4_RUN_ID_INVALID");
  const source = descriptor(sourceManifest, "GFS_INDEX_V4_SOURCE_MANIFEST_INVALID");
  if (source.key !== gfs144ScopedKey(`runs/${runId}/manifest.json`)) throw new Error("GFS_INDEX_V4_SOURCE_KEY_INVALID");
  if (!Number.isInteger(tileSize) || tileSize < 1 || tileSize > 8) throw new Error("GFS_INDEX_V4_TILE_SIZE_INVALID");
  const shape = regularGrid(grid);
  const contracts = sourceContracts(forecasts, shape.points.length);
  const windows = gfs144Windows();
  const contractIndexes = new Map(contracts.map((contract, index) => [contract.frameId, index]));
  const valueMaps = forecasts.map(({ value }) => new Map(value.frame.values.map((item) => [item.pointId, item])));
  const segmentDefinitions = windows.map((window) => ({
    id: window.id,
    startForecastHour: window.startForecastHour,
    endForecastHour: window.endForecastHour,
    forecastHours: window.forecastHours,
    contractCount: contracts.filter((contract) => window.forecastHours.includes(contract.forecastHour)).length
  }));
  segmentDefinitions.push({
    id: "compat-f001-f048",
    startForecastHour: 1,
    endForecastHour: 48,
    forecastHours: Array.from({ length: 48 }, (_, index) => index + 1),
    contractCount: contracts.filter((contract) => contract.forecastHour <= 48).length,
    derivation: "OFFICIAL_144H_F001_F048_SELECTION_NO_VALUE_TRANSFORMATION"
  });

  const pointObjects = shape.points.map((point) => {
    let offset = 0;
    const segments = [];
    const bodies = [];
    for (const definition of segmentDefinitions) {
      const selected = contracts.filter((contract) => definition.forecastHours.includes(contract.forecastHour));
      const encoded = encodeObject(segmentValue({
        runId, modelRunAt: grid.modelRunAt, sourceManifest: source, point,
        ...definition, contracts: selected, valueMaps, contractIndexes
      }));
      segments.push({ id: definition.id, offset, bytes: encoded.bytes, sha256: encoded.sha256,
        contractCount: selected.length });
      bodies.push(encoded.body);
      offset += encoded.bytes;
    }
    const body = Buffer.concat(bodies);
    return { key: indexV4PointKey(runId, point.id), pointId: point.id, body, bytes: body.byteLength,
      sha256: sha256(body), segments };
  });
  const pointById = new Map(pointObjects.map((item) => [item.pointId, item]));
  const routeObjects = shape.points.map((point, position) => {
    const blob = pointById.get(point.id);
    return { key: indexV4RouteKey(runId, point.id), pointId: point.id, ...encodeObject({
      schemaVersion: INDEX_V4_ROUTE_SCHEMA,
      status: "COMPLETE",
      runId,
      modelRunAt: grid.modelRunAt,
      fetchedAt: grid.fetchedAt,
      sourceManifest: source,
      grid: { Ni: shape.columns, Nj: shape.rows, resolutionDegrees: grid.grid.resolutionDegrees,
        minLatitude: shape.latitudes[0], minLongitude: shape.longitudes[0], ordering: "ROW_MAJOR" },
      point: { pointId: point.id, gridRow: Math.floor(position / shape.columns), gridColumn: position % shape.columns,
        latitude: point.latitude, longitude: point.longitude },
      blob: { key: blob.key, bytes: blob.bytes, sha256: blob.sha256 },
      segments: blob.segments
    }) };
  });
  const groups = new Map();
  for (let position = 0; position < shape.points.length; position += 1) {
    const point = shape.points[position];
    const gridRow = Math.floor(position / shape.columns);
    const gridColumn = position % shape.columns;
    const id = tileId(Math.floor(gridRow / tileSize), Math.floor(gridColumn / tileSize));
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ point, gridRow, gridColumn });
  }
  const spatialObjects = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, points]) => {
    const value = {
      schemaVersion: INDEX_V4_SPATIAL_SCHEMA,
      status: "COMPLETE",
      runId,
      modelRunAt: grid.modelRunAt,
      sourceManifest: source,
      tile: { id, tileSize },
      points: points.map(({ point, gridRow, gridColumn }) => {
        const blob = pointById.get(point.id);
        return {
          pointId: point.id, gridRow, gridColumn, latitude: point.latitude, longitude: point.longitude,
          blob: { key: blob.key, bytes: blob.bytes, sha256: blob.sha256 },
          segments: blob.segments
        };
      })
    };
    return { key: indexV4SpatialKey(runId, id), tileId: id,
      pointIds: value.points.map((item) => item.pointId), ...encodeObject(value) };
  });
  const manifest = {
    schemaVersion: INDEX_V4_MANIFEST_SCHEMA,
    status: "COMPLETE",
    indexVersion: INDEX_V4_VERSION,
    runId,
    modelRunAt: grid.modelRunAt,
    sourceManifest: source,
    provenance: {
      provider: grid.provider, model: grid.model, source: grid.source, product: grid.product,
      variable: grid.variable, publishedAt: grid.publishedAt || null, fetchedAt: grid.fetchedAt
    },
    grid: {
      type: grid.grid.type, Ni: shape.columns, Nj: shape.rows,
      resolutionDegrees: grid.grid.resolutionDegrees, pointCount: shape.points.length,
      ordering: "ROW_MAJOR", latitudes: shape.latitudes, longitudes: shape.longitudes, pointIds: shape.pointIds
    },
    tileSize,
    segments: segmentDefinitions,
    spatialCatalogs: spatialObjects.map(({ body, ...item }) => item),
    pointBlobCount: pointObjects.length,
    objectCount: spatialObjects.length + pointObjects.length
  };
  const manifestObject = { key: indexV4ManifestKey(runId), ...encodeObject(manifest) };
  return { manifest, manifestObject, spatialObjects, pointObjects, routeObjects };
}

export function validateIndexV4Route(value, { runId, sourceManifest, pointId } = {}) {
  if (value?.schemaVersion !== INDEX_V4_ROUTE_SCHEMA || value.status !== "COMPLETE" || value.runId !== runId
    || !sameDescriptor(value.sourceManifest, sourceManifest) || value.point?.pointId !== pointId
    || value.grid?.ordering !== "ROW_MAJOR" || !Number.isInteger(value.grid?.Ni) || value.grid.Ni < 1
    || !Number.isInteger(value.grid?.Nj) || value.grid.Nj < 1 || !Number.isFinite(value.grid?.resolutionDegrees)
    || !Number.isFinite(value.grid?.minLatitude) || !Number.isFinite(value.grid?.minLongitude)
    || !Array.isArray(value.segments) || value.segments.length !== 7) {
    throw new Error("GFS_INDEX_V4_ROUTE_INVALID");
  }
  descriptor(value.blob, "GFS_INDEX_V4_ROUTE_BLOB_INVALID");
  let offset = 0;
  for (const segment of value.segments) {
    if (segment.offset !== offset || !Number.isSafeInteger(segment.bytes) || segment.bytes < 1
      || !/^[a-f0-9]{64}$/.test(segment.sha256 || "")) throw new Error("GFS_INDEX_V4_ROUTE_RANGE_INVALID");
    offset += segment.bytes;
  }
  if (offset !== value.blob.bytes) throw new Error("GFS_INDEX_V4_ROUTE_LENGTH_INVALID");
  return value;
}

export function validateIndexV4Manifest(value, { runId, sourceManifest } = {}) {
  if (value?.schemaVersion !== INDEX_V4_MANIFEST_SCHEMA || value.status !== "COMPLETE"
    || value.indexVersion !== INDEX_V4_VERSION || value.runId !== runId
    || !sameDescriptor(value.sourceManifest, sourceManifest) || value.grid?.ordering !== "ROW_MAJOR"
    || !Array.isArray(value.grid?.latitudes) || !Array.isArray(value.grid?.longitudes)
    || !Array.isArray(value.grid?.pointIds) || value.grid.pointIds.length !== value.grid.pointCount
    || !Array.isArray(value.segments) || value.segments.length !== 7
    || !Array.isArray(value.spatialCatalogs) || !value.spatialCatalogs.length
    || value.pointBlobCount !== value.grid.pointCount
    || value.objectCount !== value.spatialCatalogs.length + value.pointBlobCount) {
    throw new Error("GFS_INDEX_V4_MANIFEST_INVALID");
  }
  if (value.segments.at(-1)?.id !== "compat-f001-f048" || value.segments.at(-1)?.endForecastHour !== 48) {
    throw new Error("GFS_INDEX_V4_COMPAT_SEGMENT_INVALID");
  }
  for (const item of value.spatialCatalogs) descriptor(item, "GFS_INDEX_V4_SPATIAL_DESCRIPTOR_INVALID");
  return value;
}

export function validateIndexV4Spatial(value, { runId, sourceManifest, descriptor: expected } = {}) {
  if (value?.schemaVersion !== INDEX_V4_SPATIAL_SCHEMA || value.status !== "COMPLETE" || value.runId !== runId
    || !sameDescriptor(value.sourceManifest, sourceManifest) || value.tile?.id !== expected?.tileId
    || !Array.isArray(value.points) || JSON.stringify(value.points.map((item) => item.pointId)) !== JSON.stringify(expected.pointIds)) {
    throw new Error("GFS_INDEX_V4_SPATIAL_INVALID");
  }
  for (const point of value.points) {
    descriptor(point.blob, "GFS_INDEX_V4_POINT_BLOB_INVALID");
    if (!Array.isArray(point.segments) || point.segments.length !== 7) throw new Error("GFS_INDEX_V4_SEGMENT_SET_INVALID");
    let offset = 0;
    for (const segment of point.segments) {
      if (segment.offset !== offset || !Number.isSafeInteger(segment.bytes) || segment.bytes < 1
        || !/^[a-f0-9]{64}$/.test(segment.sha256 || "")) throw new Error("GFS_INDEX_V4_RANGE_INVALID");
      offset += segment.bytes;
    }
    if (offset !== point.blob.bytes) throw new Error("GFS_INDEX_V4_BLOB_LENGTH_INVALID");
  }
  return value;
}

export function validateIndexV4Segment(value, { runId, sourceManifest, point, segment } = {}) {
  if (value?.schemaVersion !== INDEX_V4_SEGMENT_SCHEMA || value.status !== "AVAILABLE" || value.runId !== runId
    || !sameDescriptor(value.sourceManifest, sourceManifest) || value.point?.pointId !== point?.pointId
    || value.window?.id !== segment?.id || JSON.stringify(value.valueSchema) !== JSON.stringify(INDEX_V4_VALUE_SCHEMA)
    || !Array.isArray(value.rows) || value.rows.length !== segment.contractCount) throw new Error("GFS_INDEX_V4_SEGMENT_INVALID");
  for (const row of value.rows) {
    if (!Array.isArray(row) || row.length !== INDEX_V4_VALUE_SCHEMA.length || row[2] !== row[4]
      || !["kg m-2", "kg m**-2"].includes(row[6]) || row[7] !== "mm"
      || !["AVAILABLE", "MISSING"].includes(row[10]) || !/^[a-f0-9]{64}$/.test(row[11] || "")
      || typeof row[12] !== "string" || !Number.isSafeInteger(row[13]) || !/^[a-f0-9]{64}$/.test(row[14] || "")
      || (row[10] === "AVAILABLE" && (typeof row[8] !== "string" || !Number.isFinite(row[9])))
      || (row[10] === "MISSING" && (row[8] !== null || row[9] !== null))) throw new Error("GFS_INDEX_V4_ROW_INVALID");
  }
  return value;
}
