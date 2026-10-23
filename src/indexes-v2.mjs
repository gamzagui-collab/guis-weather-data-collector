import {
  FORECAST_SCHEMA,
  GRID_SCHEMA,
  encodeObject,
  validateForecastShard,
  validateGridShard
} from "./contracts.mjs";
import {
  GFS_144H_INDEX_VERSION,
  GFS_144H_NAMESPACE,
  gfs144ScopedKey,
  gfs144Windows
} from "./horizon-144.mjs";

export const INDEX_V2_TILE_SIZE = 8;
export const INDEX_V2_MANIFEST_SCHEMA = "weather.gfs.time-window-index-manifest.v2";
export const INDEX_V2_TILE_SCHEMA = "weather.gfs.time-window-tile.v2";

export const indexV2ManifestKey = (runId) => gfs144ScopedKey(`runs/${runId}/indexes/${GFS_144H_INDEX_VERSION}/manifest.json`);
export const indexV2TileKey = (runId, tileId, windowId) =>
  gfs144ScopedKey(`runs/${runId}/indexes/${GFS_144H_INDEX_VERSION}/tiles/${tileId}/${windowId}.json`);

function descriptor(value, code) {
  if (!value || typeof value.key !== "string" || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || !/^[a-f0-9]{64}$/.test(value.sha256 || "")) throw new Error(code);
  return { key: value.key, bytes: value.bytes, sha256: value.sha256 };
}

function tileId(row, column) {
  return `r${String(row).padStart(2, "0")}-c${String(column).padStart(2, "0")}`;
}

function sourceContracts({ forecasts, points }) {
  return forecasts.map(({ descriptor: item, value }) => {
    const sourceShard = descriptor(item, "GFS_INDEX_V2_FORECAST_DESCRIPTOR_INVALID");
    validateForecastShard(value, points.length);
    if (value.schemaVersion !== FORECAST_SCHEMA || value.frameId !== item.frameId || sourceShard.key !== item.key
      || !sourceShard.key.startsWith(`${GFS_144H_NAMESPACE}/runs/`)) {
      throw new Error("GFS_INDEX_V2_FORECAST_MISMATCH");
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

export function buildWindowedTileIndexObjects({ runId, sourceManifest, grid, forecasts, tileSize = INDEX_V2_TILE_SIZE }) {
  if (!/^\d{8}T\d{6}Z$/.test(runId || "")) throw new Error("GFS_INDEX_V2_RUN_ID_INVALID");
  const source = descriptor(sourceManifest, "GFS_INDEX_V2_SOURCE_MANIFEST_INVALID");
  if (source.key !== gfs144ScopedKey(`runs/${runId}/manifest.json`)) throw new Error("GFS_INDEX_V2_SOURCE_KEY_INVALID");
  if (!Number.isInteger(tileSize) || tileSize < 1 || tileSize > 16) throw new Error("GFS_INDEX_V2_TILE_SIZE_INVALID");
  validateGridShard(grid);
  if (grid.schemaVersion !== GRID_SCHEMA || !Array.isArray(forecasts) || !forecasts.length) throw new Error("GFS_INDEX_V2_SOURCE_INVALID");

  const points = grid.grid.points;
  const columns = Number(grid.grid.Ni);
  const rows = Number(grid.grid.Nj);
  if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1 || rows * columns !== points.length) {
    throw new Error("GFS_INDEX_V2_GRID_SHAPE_INVALID");
  }
  const contracts = sourceContracts({ forecasts, points });
  const valueMaps = forecasts.map(({ value }) => new Map(value.frame.values.map((item) => [item.pointId, item])));
  const contractIndexes = new Map(contracts.map((contract, index) => [contract.frameId, index]));
  const groups = new Map();
  for (let position = 0; position < points.length; position += 1) {
    const point = points[position];
    const row = Math.floor(Math.floor(position / columns) / tileSize);
    const column = Math.floor((position % columns) / tileSize);
    const id = tileId(row, column);
    if (!groups.has(id)) groups.set(id, { id, row, column, points: [] });
    groups.get(id).points.push(point);
  }

  const tileObjects = [];
  const windows = gfs144Windows().map((window) => {
    const windowContracts = contracts.filter((contract) => window.forecastHours.includes(contract.forecastHour));
    if (!windowContracts.length) throw new Error("GFS_INDEX_V2_WINDOW_EMPTY");
    const windowTiles = [...groups.values()].sort((left, right) => left.id.localeCompare(right.id)).map((group) => {
      const tile = {
        schemaVersion: INDEX_V2_TILE_SCHEMA,
        status: "AVAILABLE",
        runId,
        modelRunAt: grid.modelRunAt,
        sourceManifest: source,
        window: { ...window },
        tile: {
          id: group.id,
          row: group.row,
          column: group.column,
          tileSize,
          bounds: {
            minLatitude: Math.min(...group.points.map((point) => point.latitude)),
            maxLatitude: Math.max(...group.points.map((point) => point.latitude)),
            minLongitude: Math.min(...group.points.map((point) => point.longitude)),
            maxLongitude: Math.max(...group.points.map((point) => point.longitude))
          }
        },
        contracts: windowContracts,
        points: group.points.sort((left, right) => left.id - right.id).map((point) => ({
          pointId: point.id,
          latitude: point.latitude,
          longitude: point.longitude,
          values: windowContracts.map((contract) => {
            const index = contractIndexes.get(contract.frameId);
            const value = valueMaps[index].get(point.id);
            if (!value) throw new Error("GFS_INDEX_V2_POINT_VALUE_MISSING");
            return { frameId: contract.frameId, rawValue: value.rawValue,
              quantitativeValue: value.quantitativeValue, status: value.status };
          })
        }))
      };
      const encoded = encodeObject(tile);
      const item = {
        key: indexV2TileKey(runId, group.id, window.id),
        tileId: group.id,
        windowId: window.id,
        row: group.row,
        column: group.column,
        bounds: tile.tile.bounds,
        pointIds: tile.points.map((point) => point.pointId),
        contractCount: windowContracts.length,
        ...encoded
      };
      tileObjects.push(item);
      return item;
    });
    return {
      ...window,
      contractCount: windowContracts.length,
      tiles: windowTiles.map(({ body, ...item }) => item)
    };
  });

  const manifest = {
    schemaVersion: INDEX_V2_MANIFEST_SCHEMA,
    status: "COMPLETE",
    indexVersion: GFS_144H_INDEX_VERSION,
    runId,
    modelRunAt: grid.modelRunAt,
    sourceManifest: source,
    grid: {
      key: gfs144ScopedKey(`runs/${runId}/grid.json`),
      Ni: grid.grid.Ni,
      Nj: grid.grid.Nj,
      resolutionDegrees: grid.grid.resolutionDegrees,
      pointCount: points.length
    },
    tileSize,
    timeWindowHours: 24,
    contractCount: contracts.length,
    windows,
    objectCount: tileObjects.length
  };
  const encoded = encodeObject(manifest);
  return { manifest, manifestObject: { key: indexV2ManifestKey(runId), ...encoded }, tileObjects };
}

export function validateIndexV2Manifest(value, { runId, sourceManifest } = {}) {
  if (value?.schemaVersion !== INDEX_V2_MANIFEST_SCHEMA || value.status !== "COMPLETE"
    || value.indexVersion !== GFS_144H_INDEX_VERSION || value.runId !== runId || value.timeWindowHours !== 24
    || !Array.isArray(value.windows) || value.windows.length !== 6) throw new Error("GFS_INDEX_V2_MANIFEST_INVALID");
  const source = descriptor(value.sourceManifest, "GFS_INDEX_V2_SOURCE_MANIFEST_INVALID");
  if (source.key !== sourceManifest?.key || source.sha256 !== sourceManifest?.sha256 || source.bytes !== sourceManifest?.bytes) {
    throw new Error("GFS_INDEX_V2_SOURCE_MANIFEST_MISMATCH");
  }
  const expectedWindows = gfs144Windows();
  let objectCount = 0;
  let contractCount = 0;
  for (let windowIndex = 0; windowIndex < value.windows.length; windowIndex += 1) {
    const window = value.windows[windowIndex];
    const expected = expectedWindows[windowIndex];
    if (window.id !== expected.id || window.startForecastHour !== expected.startForecastHour
      || window.endForecastHour !== expected.endForecastHour || JSON.stringify(window.forecastHours) !== JSON.stringify(expected.forecastHours)
      || !Array.isArray(window.tiles) || !window.tiles.length) throw new Error("GFS_INDEX_V2_WINDOW_INVALID");
    const pointIds = new Set();
    for (const tile of window.tiles) {
      descriptor(tile, "GFS_INDEX_V2_TILE_DESCRIPTOR_INVALID");
      if (tile.windowId !== window.id || !tile.key.startsWith(`${GFS_144H_NAMESPACE}/runs/${runId}/indexes/v2/tiles/`)
        || !Array.isArray(tile.pointIds) || !tile.pointIds.length || tile.contractCount !== window.contractCount) {
        throw new Error("GFS_INDEX_V2_TILE_DESCRIPTOR_INVALID");
      }
      for (const pointId of tile.pointIds) {
        if (!Number.isInteger(pointId) || pointIds.has(pointId)) throw new Error("GFS_INDEX_V2_POINT_MAP_INVALID");
        pointIds.add(pointId);
      }
    }
    if (pointIds.size !== value.grid?.pointCount) throw new Error("GFS_INDEX_V2_POINT_COVERAGE_INVALID");
    objectCount += window.tiles.length;
    contractCount += window.contractCount;
  }
  if (objectCount !== value.objectCount || contractCount !== value.contractCount) throw new Error("GFS_INDEX_V2_OBJECT_COUNT_INVALID");
  return value;
}

export function validateIndexV2Tile(value, { runId, sourceManifest, descriptor: expected } = {}) {
  if (value?.schemaVersion !== INDEX_V2_TILE_SCHEMA || value.status !== "AVAILABLE" || value.runId !== runId
    || value.tile?.id !== expected?.tileId || value.window?.id !== expected?.windowId
    || !Array.isArray(value.contracts) || value.contracts.length !== expected.contractCount
    || !Array.isArray(value.points) || JSON.stringify(value.points.map((point) => point.pointId)) !== JSON.stringify(expected.pointIds)) {
    throw new Error("GFS_INDEX_V2_TILE_INVALID");
  }
  const source = descriptor(value.sourceManifest, "GFS_INDEX_V2_SOURCE_MANIFEST_INVALID");
  if (source.key !== sourceManifest.key || source.sha256 !== sourceManifest.sha256 || source.bytes !== sourceManifest.bytes) {
    throw new Error("GFS_INDEX_V2_SOURCE_MANIFEST_MISMATCH");
  }
  for (const contract of value.contracts) descriptor(contract.sourceShard, "GFS_INDEX_V2_SOURCE_SHARD_INVALID");
  for (const point of value.points) {
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || !Array.isArray(point.values)
      || point.values.length !== value.contracts.length) throw new Error("GFS_INDEX_V2_POINT_INVALID");
    for (let index = 0; index < point.values.length; index += 1) {
      const item = point.values[index];
      if (item.frameId !== value.contracts[index].frameId || !["AVAILABLE", "MISSING"].includes(item.status)
        || (item.status === "AVAILABLE" && (typeof item.rawValue !== "string" || !Number.isFinite(item.quantitativeValue)))
        || (item.status === "MISSING" && (item.rawValue !== null || item.quantitativeValue !== null))) {
        throw new Error("GFS_INDEX_V2_VALUE_INVALID");
      }
    }
  }
  return value;
}
