import { encodeObject, sha256, validateForecastShard, validateGridShard } from "./contracts.mjs";
import { GFS_144H_NAMESPACE, gfs144ScopedKey, gfs144Windows } from "./horizon-144.mjs";

export const INDEX_V5_VERSION = "v5";
export const INDEX_V5_MANIFEST_SCHEMA = "weather.gfs.compact-index-manifest.v5";
export const INDEX_V5_CATALOG_SCHEMA = "weather.gfs.contract-catalog.v5";
export const INDEX_V5_POINT_SCHEMA = "weather.gfs.point-values.v5";
export const INDEX_V5_CONTRACT_SCHEMA = Object.freeze([
  "contractId", "forecastHour", "validAt", "accumulationStart", "accumulationEnd",
  "accumulationPeriod", "sourceUnit", "unit", "sourceDataSha256", "sourceShardKey",
  "sourceShardBytes", "sourceShardSha256"
]);
export const INDEX_V5_VALUE_SCHEMA = Object.freeze([
  "contractId", "rawValue", "quantitativeValue", "status"
]);

const prefixFor = (runId) => gfs144ScopedKey(`runs/${runId}/indexes/${INDEX_V5_VERSION}`);
export const indexV5ManifestKey = (runId) => `${prefixFor(runId)}/manifest.json`;
export const indexV5CatalogKey = (runId, windowId) => `${prefixFor(runId)}/catalogs/${windowId}.json`;
export const indexV5PointKey = (runId, pointId) => `${prefixFor(runId)}/points/p${String(pointId).padStart(4, "0")}.bin`;

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
    throw new Error("GFS_INDEX_V5_GRID_SHAPE_INVALID");
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
        throw new Error("GFS_INDEX_V5_GRID_NOT_REGULAR_ROW_MAJOR");
      }
      if (row === 0) longitudes.push(point.longitude);
      else if (point.longitude !== longitudes[column]) throw new Error("GFS_INDEX_V5_GRID_NOT_REGULAR_ROW_MAJOR");
      if (point.id !== row * columns + column) throw new Error("GFS_INDEX_V5_POINT_ID_NOT_DETERMINISTIC");
      pointIds.push(point.id);
    }
  }
  if (new Set(pointIds).size !== points.length || new Set(latitudes).size !== rows
    || new Set(longitudes).size !== columns) throw new Error("GFS_INDEX_V5_GRID_AXIS_INVALID");
  const latitudeStep = rows > 1 ? latitudes[1] - latitudes[0] : grid.grid.resolutionDegrees;
  const longitudeStep = columns > 1 ? longitudes[1] - longitudes[0] : grid.grid.resolutionDegrees;
  if (!Number.isFinite(latitudeStep) || !Number.isFinite(longitudeStep)
    || latitudeStep !== grid.grid.resolutionDegrees || longitudeStep !== grid.grid.resolutionDegrees
    || latitudes.some((value, index) => value !== latitudes[0] + index * latitudeStep)
    || longitudes.some((value, index) => value !== longitudes[0] + index * longitudeStep)) {
    throw new Error("GFS_INDEX_V5_GRID_STEP_INVALID");
  }
  return { points, columns, rows, latitudes, longitudes, pointIds,
    minLatitude: latitudes[0], minLongitude: longitudes[0], resolutionDegrees: latitudeStep };
}

function sourceContracts(forecasts, pointCount) {
  const ids = new Set();
  return forecasts.map(({ descriptor: source, value }) => {
    const sourceShard = descriptor(source, "GFS_INDEX_V5_SOURCE_SHARD_INVALID");
    validateForecastShard(value, pointCount);
    if (value.frameId !== source.frameId || ids.has(value.frameId)) {
      throw new Error("GFS_INDEX_V5_FORECAST_MISMATCH");
    }
    ids.add(value.frameId);
    return {
      contractId: value.frameId,
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

function contractRow(contract) {
  return [
    contract.contractId, contract.forecastHour, contract.validAt, contract.accumulationStart,
    contract.accumulationEnd, contract.accumulationPeriod, contract.sourceUnit, contract.unit,
    contract.sourceDataSha256, contract.sourceShard.key, contract.sourceShard.bytes, contract.sourceShard.sha256
  ];
}

function windowDefinitions(contracts) {
  return gfs144Windows().map((window) => {
    const selected = contracts.filter((contract) => window.forecastHours.includes(contract.forecastHour));
    return { ...window, contractIds: selected.map((contract) => contract.contractId), contractCount: selected.length };
  });
}

function pointSegment({ runId, modelRunAt, sourceManifest, indexManifest, point, window, contracts,
  valueMaps, contractIndexes }) {
  const values = contracts.map((contract) => {
    const item = valueMaps[contractIndexes.get(contract.contractId)].get(point.id);
    if (!item) throw new Error("GFS_INDEX_V5_POINT_VALUE_MISSING");
    return [contract.contractId, item.rawValue, item.quantitativeValue, item.status];
  });
  return {
    schemaVersion: INDEX_V5_POINT_SCHEMA,
    status: "AVAILABLE",
    runId,
    modelRunAt,
    sourceManifest,
    indexManifest,
    point: { pointId: point.id, latitude: point.latitude, longitude: point.longitude },
    window: { id: window.id, startForecastHour: window.startForecastHour,
      endForecastHour: window.endForecastHour, forecastHours: window.forecastHours },
    valueSchema: [...INDEX_V5_VALUE_SCHEMA],
    values
  };
}

export function pointMetadata(item, manifestDescriptor) {
  return {
    sha256: item.sha256,
    "index-manifest-key": manifestDescriptor.key,
    "index-manifest-sha256": manifestDescriptor.sha256,
    "point-id": String(item.pointId),
    latitude: String(item.latitude),
    longitude: String(item.longitude),
    segments: JSON.stringify(item.segments)
  };
}

export function buildCompactIndexObjects({ runId, sourceManifest, sourceGrid, grid, forecasts }) {
  if (!/^\d{8}T\d{6}Z$/.test(runId || "")) throw new Error("GFS_INDEX_V5_RUN_ID_INVALID");
  const source = descriptor(sourceManifest, "GFS_INDEX_V5_SOURCE_MANIFEST_INVALID");
  const gridSource = descriptor(sourceGrid, "GFS_INDEX_V5_SOURCE_GRID_INVALID");
  if (source.key !== gfs144ScopedKey(`runs/${runId}/manifest.json`)
    || gridSource.key !== gfs144ScopedKey(`runs/${runId}/grid.json`)) {
    throw new Error("GFS_INDEX_V5_SOURCE_KEY_INVALID");
  }
  const shape = regularGrid(grid);
  const contracts = sourceContracts(forecasts, shape.points.length);
  const windows = windowDefinitions(contracts);
  const catalogObjects = windows.map((window) => {
    const selected = contracts.filter((contract) => window.forecastHours.includes(contract.forecastHour));
    const value = {
      schemaVersion: INDEX_V5_CATALOG_SCHEMA,
      status: "COMPLETE",
      runId,
      modelRunAt: grid.modelRunAt,
      sourceManifest: source,
      window: { id: window.id, startForecastHour: window.startForecastHour,
        endForecastHour: window.endForecastHour, forecastHours: window.forecastHours },
      contractSchema: [...INDEX_V5_CONTRACT_SCHEMA],
      contracts: selected.map(contractRow)
    };
    return { key: indexV5CatalogKey(runId, window.id), windowId: window.id,
      contractCount: selected.length, ...encodeObject(value) };
  });
  const manifest = {
    schemaVersion: INDEX_V5_MANIFEST_SCHEMA,
    status: "COMPLETE",
    indexVersion: INDEX_V5_VERSION,
    runId,
    modelRunAt: grid.modelRunAt,
    sourceManifest: source,
    sourceGrid: gridSource,
    provenance: {
      provider: grid.provider, model: grid.model, source: grid.source, product: grid.product,
      variable: grid.variable, publishedAt: grid.publishedAt || null, fetchedAt: grid.fetchedAt
    },
    grid: {
      type: grid.grid.type,
      Ni: shape.columns,
      Nj: shape.rows,
      resolutionDegrees: shape.resolutionDegrees,
      minLatitude: shape.minLatitude,
      minLongitude: shape.minLongitude,
      pointCount: shape.points.length,
      ordering: "ROW_MAJOR_DETERMINISTIC_POINT_ID"
    },
    contractCount: contracts.length,
    windows: windows.map((window, index) => ({
      id: window.id,
      startForecastHour: window.startForecastHour,
      endForecastHour: window.endForecastHour,
      forecastHours: window.forecastHours,
      contractCount: window.contractCount,
      catalog: descriptor(catalogObjects[index], "GFS_INDEX_V5_CATALOG_DESCRIPTOR_INVALID")
    })),
    pointValues: {
      schemaVersion: INDEX_V5_POINT_SCHEMA,
      valueSchema: [...INDEX_V5_VALUE_SCHEMA],
      keyTemplate: `${prefixFor(runId)}/points/p{pointId4}.bin`,
      pointBlobCount: shape.points.length,
      segmentCountPerPoint: windows.length,
      compatibility48h: {
        derivation: "OFFICIAL_144H_F001_F048_SELECTION_NO_VALUE_TRANSFORMATION",
        windowIds: windows.slice(0, 2).map((window) => window.id),
        duplicateSegmentStored: false
      }
    }
  };
  const manifestObject = { key: indexV5ManifestKey(runId), ...encodeObject(manifest) };
  const manifestDescriptor = descriptor(manifestObject, "GFS_INDEX_V5_MANIFEST_DESCRIPTOR_INVALID");
  const contractIndexes = new Map(contracts.map((contract, index) => [contract.contractId, index]));
  const valueMaps = forecasts.map(({ value }) => new Map(value.frame.values.map((item) => [item.pointId, item])));
  const pointObjects = shape.points.map((point) => {
    let offset = 0;
    const segments = [];
    const bodies = [];
    for (const window of windows) {
      const selected = contracts.filter((contract) => window.forecastHours.includes(contract.forecastHour));
      const encoded = encodeObject(pointSegment({ runId, modelRunAt: grid.modelRunAt, sourceManifest: source,
        indexManifest: manifestDescriptor, point, window, contracts: selected, valueMaps, contractIndexes }));
      segments.push({ id: window.id, offset, bytes: encoded.bytes, sha256: encoded.sha256,
        contractCount: selected.length });
      bodies.push(encoded.body);
      offset += encoded.bytes;
    }
    const body = Buffer.concat(bodies);
    const item = { key: indexV5PointKey(runId, point.id), pointId: point.id,
      latitude: point.latitude, longitude: point.longitude, body, bytes: body.byteLength,
      sha256: sha256(body), segments };
    return { ...item, customMetadata: pointMetadata(item, manifestDescriptor) };
  });
  return { manifest, manifestObject, manifestDescriptor, catalogObjects, pointObjects,
    objectCount: 1 + catalogObjects.length + pointObjects.length,
    totalBytes: manifestObject.bytes + catalogObjects.reduce((sum, item) => sum + item.bytes, 0)
      + pointObjects.reduce((sum, item) => sum + item.bytes, 0) };
}

export function validateIndexV5Manifest(value, { runId, sourceManifest, sourceGrid } = {}) {
  if (value?.schemaVersion !== INDEX_V5_MANIFEST_SCHEMA || value.status !== "COMPLETE"
    || value.indexVersion !== INDEX_V5_VERSION || value.runId !== runId
    || !sameDescriptor(value.sourceManifest, sourceManifest) || !sameDescriptor(value.sourceGrid, sourceGrid)
    || value.grid?.ordering !== "ROW_MAJOR_DETERMINISTIC_POINT_ID"
    || !Number.isInteger(value.grid?.Ni) || !Number.isInteger(value.grid?.Nj)
    || value.grid.Ni * value.grid.Nj !== value.grid.pointCount
    || value.grid.pointCount !== value.pointValues?.pointBlobCount
    || !Number.isFinite(value.grid?.resolutionDegrees) || value.grid.resolutionDegrees <= 0
    || !Number.isFinite(value.grid?.minLatitude) || !Number.isFinite(value.grid?.minLongitude)
    || !Array.isArray(value.windows) || value.windows.length !== 6
    || value.windows.reduce((sum, window) => sum + window.contractCount, 0) !== value.contractCount
    || value.pointValues?.segmentCountPerPoint !== 6
    || value.pointValues?.compatibility48h?.duplicateSegmentStored !== false
    || JSON.stringify(value.pointValues?.compatibility48h?.windowIds) !== JSON.stringify(value.windows.slice(0, 2).map((item) => item.id))) {
    throw new Error("GFS_INDEX_V5_MANIFEST_INVALID");
  }
  for (const window of value.windows) descriptor(window.catalog, "GFS_INDEX_V5_CATALOG_DESCRIPTOR_INVALID");
  return value;
}

export function validateIndexV5Catalog(value, { runId, sourceManifest, window } = {}) {
  if (value?.schemaVersion !== INDEX_V5_CATALOG_SCHEMA || value.status !== "COMPLETE" || value.runId !== runId
    || !sameDescriptor(value.sourceManifest, sourceManifest) || value.window?.id !== window?.id
    || JSON.stringify(value.contractSchema) !== JSON.stringify(INDEX_V5_CONTRACT_SCHEMA)
    || !Array.isArray(value.contracts) || value.contracts.length !== window?.contractCount) {
    throw new Error("GFS_INDEX_V5_CATALOG_INVALID");
  }
  const ids = new Set();
  for (const row of value.contracts) {
    if (!Array.isArray(row) || row.length !== INDEX_V5_CONTRACT_SCHEMA.length || typeof row[0] !== "string"
      || ids.has(row[0]) || !Number.isInteger(row[1]) || row[2] !== row[4]
      || !["kg m-2", "kg m**-2"].includes(row[6]) || row[7] !== "mm"
      || !/^[a-f0-9]{64}$/.test(row[8] || "") || typeof row[9] !== "string"
      || !Number.isSafeInteger(row[10]) || !/^[a-f0-9]{64}$/.test(row[11] || "")) {
      throw new Error("GFS_INDEX_V5_CONTRACT_INVALID");
    }
    ids.add(row[0]);
  }
  return value;
}

export function validateIndexV5PointSegment(value, { runId, sourceManifest, indexManifest, point, window } = {}) {
  if (value?.schemaVersion !== INDEX_V5_POINT_SCHEMA || value.status !== "AVAILABLE" || value.runId !== runId
    || !sameDescriptor(value.sourceManifest, sourceManifest) || !sameDescriptor(value.indexManifest, indexManifest)
    || value.point?.pointId !== point?.pointId || value.point.latitude !== point.latitude
    || value.point.longitude !== point.longitude || value.window?.id !== window?.id
    || JSON.stringify(value.valueSchema) !== JSON.stringify(INDEX_V5_VALUE_SCHEMA)
    || !Array.isArray(value.values) || value.values.length !== window?.contractCount) {
    throw new Error("GFS_INDEX_V5_POINT_SEGMENT_INVALID");
  }
  const ids = new Set();
  for (const row of value.values) {
    if (!Array.isArray(row) || row.length !== INDEX_V5_VALUE_SCHEMA.length || typeof row[0] !== "string"
      || ids.has(row[0]) || !["AVAILABLE", "MISSING"].includes(row[3])
      || (row[3] === "AVAILABLE" && (typeof row[1] !== "string" || !Number.isFinite(row[2])))
      || (row[3] === "MISSING" && (row[1] !== null || row[2] !== null))) {
      throw new Error("GFS_INDEX_V5_POINT_VALUE_INVALID");
    }
    ids.add(row[0]);
  }
  return value;
}

export function validateIndexV5PointMetadata(metadata, { pointObject, manifestDescriptor } = {}) {
  let segments;
  try { segments = JSON.parse(metadata?.segments || ""); }
  catch { throw new Error("GFS_INDEX_V5_POINT_METADATA_INVALID"); }
  if (metadata?.sha256 !== pointObject?.sha256 || metadata?.["index-manifest-key"] !== manifestDescriptor?.key
    || metadata?.["index-manifest-sha256"] !== manifestDescriptor?.sha256
    || Number(metadata?.["point-id"]) !== pointObject?.pointId
    || Number(metadata?.latitude) !== pointObject?.latitude || Number(metadata?.longitude) !== pointObject?.longitude
    || JSON.stringify(segments) !== JSON.stringify(pointObject?.segments)) {
    throw new Error("GFS_INDEX_V5_POINT_METADATA_INVALID");
  }
  let offset = 0;
  for (const segment of segments) {
    if (segment.offset !== offset || !Number.isSafeInteger(segment.bytes) || segment.bytes < 1
      || !/^[a-f0-9]{64}$/.test(segment.sha256 || "")) throw new Error("GFS_INDEX_V5_POINT_RANGE_INVALID");
    offset += segment.bytes;
  }
  if (offset !== pointObject.bytes) throw new Error("GFS_INDEX_V5_POINT_LENGTH_INVALID");
  return segments;
}
