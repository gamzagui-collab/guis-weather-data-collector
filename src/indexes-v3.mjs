import {
  FORECAST_SCHEMA,
  GRID_SCHEMA,
  encodeObject,
  validateForecastShard,
  validateGridShard
} from "./contracts.mjs";
import {
  GFS_144H_NAMESPACE,
  gfs144ScopedKey,
  gfs144Windows
} from "./horizon-144.mjs";

export const INDEX_V3_VERSION = "v3";
export const INDEX_V3_TILE_SIZE = 4;
export const INDEX_V3_MANIFEST_SCHEMA = "weather.gfs.point-window-index-manifest.v3";
export const INDEX_V3_CONTRACTS_SCHEMA = "weather.gfs.window-contract-catalog.v3";
export const INDEX_V3_SPATIAL_SCHEMA = "weather.gfs.spatial-point-catalog.v3";
export const INDEX_V3_POINT_SCHEMA = "weather.gfs.point-timeline.v3";

const prefixFor = (runId) => gfs144ScopedKey(`runs/${runId}/indexes/${INDEX_V3_VERSION}`);
export const indexV3ManifestKey = (runId) => `${prefixFor(runId)}/manifest.json`;
export const indexV3ContractsKey = (runId, windowId) => `${prefixFor(runId)}/contracts/${windowId}.json`;
export const indexV3SpatialKey = (runId, tileId) => `${prefixFor(runId)}/spatial/${tileId}.json`;
export const indexV3PointKey = (runId, pointId) => `${prefixFor(runId)}/points/p${String(pointId).padStart(4, "0")}.json`;

function exactDescriptor(value, code) {
  if (!value || typeof value.key !== "string" || !value.key.startsWith(`${GFS_144H_NAMESPACE}/`)
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || !/^[a-f0-9]{64}$/.test(value.sha256 || "")) {
    throw new Error(code);
  }
  return { key: value.key, bytes: value.bytes, sha256: value.sha256 };
}

function sameDescriptor(left, right) {
  return left?.key === right?.key && left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
}

function tileId(row, column) {
  return `r${String(row).padStart(2, "0")}-c${String(column).padStart(2, "0")}`;
}

function sourceContracts({ forecasts, pointCount }) {
  return forecasts.map(({ descriptor: item, value }) => {
    const sourceShard = exactDescriptor(item, "GFS_INDEX_V3_FORECAST_DESCRIPTOR_INVALID");
    validateForecastShard(value, pointCount);
    if (value.schemaVersion !== FORECAST_SCHEMA || value.frameId !== item.frameId
      || sourceShard.key !== item.key || !sourceShard.key.startsWith(`${GFS_144H_NAMESPACE}/runs/`)) {
      throw new Error("GFS_INDEX_V3_FORECAST_MISMATCH");
    }
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

function regularGrid(grid) {
  validateGridShard(grid);
  if (grid.schemaVersion !== GRID_SCHEMA) throw new Error("GFS_INDEX_V3_GRID_SCHEMA_INVALID");
  const points = grid.grid.points;
  const columns = Number(grid.grid.Ni);
  const rows = Number(grid.grid.Nj);
  if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1
    || rows * columns !== points.length) throw new Error("GFS_INDEX_V3_GRID_SHAPE_INVALID");
  const latitudes = [];
  const longitudes = [];
  const pointIds = [];
  for (let row = 0; row < rows; row += 1) {
    const latitude = points[row * columns]?.latitude;
    if (!Number.isFinite(latitude)) throw new Error("GFS_INDEX_V3_GRID_LATITUDE_INVALID");
    latitudes.push(latitude);
    for (let column = 0; column < columns; column += 1) {
      const point = points[row * columns + column];
      if (!point || point.latitude !== latitude || !Number.isFinite(point.longitude) || !Number.isInteger(point.id)) {
        throw new Error("GFS_INDEX_V3_GRID_NOT_REGULAR_ROW_MAJOR");
      }
      if (row === 0) longitudes.push(point.longitude);
      else if (point.longitude !== longitudes[column]) throw new Error("GFS_INDEX_V3_GRID_NOT_REGULAR_ROW_MAJOR");
      pointIds.push(point.id);
    }
  }
  if (new Set(pointIds).size !== points.length || new Set(latitudes).size !== rows
    || new Set(longitudes).size !== columns) throw new Error("GFS_INDEX_V3_GRID_AXIS_INVALID");
  return { points, columns, rows, latitudes, longitudes, pointIds };
}

function groupedPoints({ points, columns, tileSize }) {
  const groups = new Map();
  for (let position = 0; position < points.length; position += 1) {
    const point = points[position];
    const gridRow = Math.floor(position / columns);
    const gridColumn = position % columns;
    const row = Math.floor(gridRow / tileSize);
    const column = Math.floor(gridColumn / tileSize);
    const id = tileId(row, column);
    if (!groups.has(id)) groups.set(id, { id, row, column, points: [] });
    groups.get(id).points.push({ point, gridRow, gridColumn });
  }
  return [...groups.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function buildPointWindowIndexObjects({ runId, sourceManifest, grid, forecasts,
  tileSize = INDEX_V3_TILE_SIZE }) {
  if (!/^\d{8}T\d{6}Z$/.test(runId || "")) throw new Error("GFS_INDEX_V3_RUN_ID_INVALID");
  const source = exactDescriptor(sourceManifest, "GFS_INDEX_V3_SOURCE_MANIFEST_INVALID");
  if (source.key !== gfs144ScopedKey(`runs/${runId}/manifest.json`)) throw new Error("GFS_INDEX_V3_SOURCE_KEY_INVALID");
  if (!Number.isInteger(tileSize) || tileSize < 1 || tileSize > 8) throw new Error("GFS_INDEX_V3_TILE_SIZE_INVALID");
  if (!Array.isArray(forecasts) || !forecasts.length) throw new Error("GFS_INDEX_V3_FORECASTS_INVALID");

  const shape = regularGrid(grid);
  const contracts = sourceContracts({ forecasts, pointCount: shape.points.length });
  const windows = gfs144Windows();
  const contractIndexes = new Map(contracts.map((contract, index) => [contract.frameId, index]));
  const valueMaps = forecasts.map(({ value }) => new Map(value.frame.values.map((item) => [item.pointId, item])));

  const contractObjects = windows.map((window) => {
    const selected = contracts.filter((contract) => window.forecastHours.includes(contract.forecastHour));
    if (!selected.length) throw new Error("GFS_INDEX_V3_WINDOW_EMPTY");
    const value = {
      schemaVersion: INDEX_V3_CONTRACTS_SCHEMA,
      status: "COMPLETE",
      runId,
      modelRunAt: grid.modelRunAt,
      sourceManifest: source,
      window: { ...window },
      contracts: selected
    };
    const encoded = encodeObject(value);
    return { key: indexV3ContractsKey(runId, window.id), windowId: window.id,
      contractCount: selected.length, ...encoded, value };
  });
  const contractsByWindow = new Map(contractObjects.map((item) => [item.windowId, item]));

  const pointObjects = shape.points.map((point) => {
    const value = {
      schemaVersion: INDEX_V3_POINT_SCHEMA,
      status: "AVAILABLE",
      runId,
      modelRunAt: grid.modelRunAt,
      sourceManifest: source,
      point: { pointId: point.id, latitude: point.latitude, longitude: point.longitude },
      windows: windows.map((window) => {
        const catalog = contractsByWindow.get(window.id);
        return {
          id: window.id,
          contracts: { key: catalog.key, bytes: catalog.bytes, sha256: catalog.sha256 },
          values: catalog.value.contracts.map((contract) => {
            const sourceIndex = contractIndexes.get(contract.frameId);
            const item = valueMaps[sourceIndex].get(point.id);
            if (!item) throw new Error("GFS_INDEX_V3_POINT_VALUE_MISSING");
            return { frameId: contract.frameId, rawValue: item.rawValue,
              quantitativeValue: item.quantitativeValue, status: item.status };
          })
        };
      })
    };
    const encoded = encodeObject(value);
    return { key: indexV3PointKey(runId, point.id), pointId: point.id, ...encoded, value };
  });
  const pointObjectsById = new Map(pointObjects.map((item) => [item.pointId, item]));

  const groups = groupedPoints({ points: shape.points, columns: shape.columns, tileSize });
  const spatialObjects = groups.map((group) => {
    const value = {
      schemaVersion: INDEX_V3_SPATIAL_SCHEMA,
      status: "COMPLETE",
      runId,
      modelRunAt: grid.modelRunAt,
      sourceManifest: source,
      tile: { id: group.id, row: group.row, column: group.column, tileSize },
      points: group.points.map(({ point, gridRow, gridColumn }) => {
        const object = pointObjectsById.get(point.id);
        return {
          pointId: point.id,
          gridRow,
          gridColumn,
          latitude: point.latitude,
          longitude: point.longitude,
          timeline: { key: object.key, bytes: object.bytes, sha256: object.sha256 }
        };
      })
    };
    const encoded = encodeObject(value);
    return { key: indexV3SpatialKey(runId, group.id), tileId: group.id, row: group.row,
      column: group.column, pointIds: value.points.map((point) => point.pointId), ...encoded };
  });

  const manifest = {
    schemaVersion: INDEX_V3_MANIFEST_SCHEMA,
    status: "COMPLETE",
    indexVersion: INDEX_V3_VERSION,
    runId,
    modelRunAt: grid.modelRunAt,
    sourceManifest: source,
    provenance: {
      provider: grid.provider,
      model: grid.model,
      source: grid.source,
      product: grid.product,
      variable: grid.variable,
      publishedAt: grid.publishedAt || null,
      fetchedAt: grid.fetchedAt
    },
    grid: {
      source: { key: gfs144ScopedKey(`runs/${runId}/grid.json`) },
      type: grid.grid.type,
      Ni: shape.columns,
      Nj: shape.rows,
      resolutionDegrees: grid.grid.resolutionDegrees,
      pointCount: shape.points.length,
      ordering: "ROW_MAJOR",
      latitudes: shape.latitudes,
      longitudes: shape.longitudes,
      pointIds: shape.pointIds
    },
    tileSize,
    contractCount: contracts.length,
    windows: contractObjects.map(({ body, value, ...item }) => ({
      id: item.windowId,
      ...windows.find((window) => window.id === item.windowId),
      contractCount: item.contractCount,
      contracts: { key: item.key, bytes: item.bytes, sha256: item.sha256 }
    })),
    spatialCatalogs: spatialObjects.map(({ body, value, ...item }) => item),
    pointObjectCount: pointObjects.length,
    objectCount: contractObjects.length + spatialObjects.length + pointObjects.length
  };
  const manifestEncoded = encodeObject(manifest);
  return {
    manifest,
    manifestObject: { key: indexV3ManifestKey(runId), ...manifestEncoded },
    contractObjects: contractObjects.map(({ value, ...item }) => item),
    spatialObjects: spatialObjects.map(({ value, ...item }) => item),
    pointObjects: pointObjects.map(({ value, ...item }) => item)
  };
}

export function validateIndexV3Manifest(value, { runId, sourceManifest } = {}) {
  if (value?.schemaVersion !== INDEX_V3_MANIFEST_SCHEMA || value.status !== "COMPLETE"
    || value.indexVersion !== INDEX_V3_VERSION || value.runId !== runId || value.grid?.ordering !== "ROW_MAJOR"
    || value.provenance?.provider !== "NOAA/NCEP" || value.provenance?.model !== "GFS"
    || typeof value.provenance?.source !== "string" || typeof value.provenance?.product !== "string"
    || typeof value.provenance?.variable !== "string" || !Number.isFinite(Date.parse(value.provenance?.fetchedAt || ""))
    || !Array.isArray(value.grid?.latitudes) || !Array.isArray(value.grid?.longitudes)
    || !Array.isArray(value.grid?.pointIds) || value.grid.pointIds.length !== value.grid.pointCount
    || value.grid.latitudes.length !== value.grid.Nj || value.grid.longitudes.length !== value.grid.Ni
    || !Array.isArray(value.windows) || value.windows.length !== 6
    || !Array.isArray(value.spatialCatalogs) || !value.spatialCatalogs.length
    || value.pointObjectCount !== value.grid.pointCount
    || value.objectCount !== value.windows.length + value.spatialCatalogs.length + value.pointObjectCount) {
    throw new Error("GFS_INDEX_V3_MANIFEST_INVALID");
  }
  const source = exactDescriptor(value.sourceManifest, "GFS_INDEX_V3_SOURCE_MANIFEST_INVALID");
  if (source.key !== sourceManifest?.key || source.bytes !== sourceManifest?.bytes || source.sha256 !== sourceManifest?.sha256) {
    throw new Error("GFS_INDEX_V3_SOURCE_MANIFEST_MISMATCH");
  }
  const expectedWindows = gfs144Windows();
  let contracts = 0;
  for (let index = 0; index < expectedWindows.length; index += 1) {
    const window = value.windows[index];
    const expected = expectedWindows[index];
    if (window.id !== expected.id || JSON.stringify(window.forecastHours) !== JSON.stringify(expected.forecastHours)
      || !Number.isInteger(window.contractCount) || window.contractCount < 1) throw new Error("GFS_INDEX_V3_WINDOW_INVALID");
    const catalog = exactDescriptor(window.contracts, "GFS_INDEX_V3_CONTRACT_DESCRIPTOR_INVALID");
    if (catalog.key !== indexV3ContractsKey(runId, window.id)) throw new Error("GFS_INDEX_V3_CONTRACT_KEY_INVALID");
    contracts += window.contractCount;
  }
  if (contracts !== value.contractCount || new Set(value.grid.pointIds).size !== value.grid.pointCount) {
    throw new Error("GFS_INDEX_V3_COUNT_INVALID");
  }
  for (const item of value.spatialCatalogs) {
    const descriptor = exactDescriptor(item, "GFS_INDEX_V3_SPATIAL_DESCRIPTOR_INVALID");
    if (descriptor.key !== indexV3SpatialKey(runId, item.tileId) || !Array.isArray(item.pointIds) || !item.pointIds.length) {
      throw new Error("GFS_INDEX_V3_SPATIAL_DESCRIPTOR_INVALID");
    }
  }
  return value;
}

export function validateIndexV3Contracts(value, { runId, sourceManifest, descriptor } = {}) {
  if (value?.schemaVersion !== INDEX_V3_CONTRACTS_SCHEMA || value.status !== "COMPLETE" || value.runId !== runId
    || value.window?.id !== descriptor?.windowId || !Array.isArray(value.contracts)
    || value.contracts.length !== descriptor.contractCount) throw new Error("GFS_INDEX_V3_CONTRACTS_INVALID");
  if (!sameDescriptor(value.sourceManifest, sourceManifest)) throw new Error("GFS_INDEX_V3_SOURCE_MANIFEST_MISMATCH");
  for (const contract of value.contracts) exactDescriptor(contract.sourceShard, "GFS_INDEX_V3_SOURCE_SHARD_INVALID");
  return value;
}

export function validateIndexV3Spatial(value, { runId, sourceManifest, descriptor } = {}) {
  if (value?.schemaVersion !== INDEX_V3_SPATIAL_SCHEMA || value.status !== "COMPLETE" || value.runId !== runId
    || value.tile?.id !== descriptor?.tileId || !Array.isArray(value.points)
    || JSON.stringify(value.points.map((point) => point.pointId)) !== JSON.stringify(descriptor.pointIds)) {
    throw new Error("GFS_INDEX_V3_SPATIAL_INVALID");
  }
  if (!sameDescriptor(value.sourceManifest, sourceManifest)) throw new Error("GFS_INDEX_V3_SOURCE_MANIFEST_MISMATCH");
  for (const point of value.points) exactDescriptor(point.timeline, "GFS_INDEX_V3_POINT_DESCRIPTOR_INVALID");
  return value;
}

export function validateIndexV3Point(value, { runId, sourceManifest, descriptor, windows } = {}) {
  if (value?.schemaVersion !== INDEX_V3_POINT_SCHEMA || value.status !== "AVAILABLE" || value.runId !== runId
    || value.point?.pointId !== descriptor?.pointId || !Array.isArray(value.windows) || value.windows.length !== windows.length) {
    throw new Error("GFS_INDEX_V3_POINT_INVALID");
  }
  if (!sameDescriptor(value.sourceManifest, sourceManifest)) throw new Error("GFS_INDEX_V3_SOURCE_MANIFEST_MISMATCH");
  for (let index = 0; index < windows.length; index += 1) {
    const actual = value.windows[index];
    const expected = windows[index];
    if (actual.id !== expected.id || JSON.stringify(actual.contracts) !== JSON.stringify(expected.contracts)
      || !Array.isArray(actual.values) || actual.values.length !== expected.contractCount) throw new Error("GFS_INDEX_V3_POINT_WINDOW_INVALID");
    for (const item of actual.values) {
      if (!/^[a-z0-9-]+$/i.test(item?.frameId || "") || !["AVAILABLE", "MISSING"].includes(item?.status)
        || (item.status === "AVAILABLE" && (typeof item.rawValue !== "string" || !Number.isFinite(item.quantitativeValue)))
        || (item.status === "MISSING" && (item.rawValue !== null || item.quantitativeValue !== null))) {
        throw new Error("GFS_INDEX_V3_POINT_VALUE_INVALID");
      }
    }
  }
  return value;
}
