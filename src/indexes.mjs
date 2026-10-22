import {
  FORECAST_SCHEMA,
  GRID_SCHEMA,
  encodeObject,
  sha256,
  validateForecastShard,
  validateGridShard
} from "./contracts.mjs";

export const INDEX_VERSION = "v1";
export const INDEX_TILE_SIZE = 8;
export const INDEX_MANIFEST_SCHEMA = "weather.gfs.tile-index-manifest.v1";
export const INDEX_TILE_SCHEMA = "weather.gfs.tile-index.v1";

export const indexManifestKey = (runId) => `runs/${runId}/indexes/${INDEX_VERSION}/manifest.json`;
export const indexTileKey = (runId, tileId) => `runs/${runId}/indexes/${INDEX_VERSION}/tiles/${tileId}.json`;

function descriptor(value, code) {
  if (!value || typeof value.key !== "string" || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || !/^[a-f0-9]{64}$/.test(value.sha256 || "")) throw new Error(code);
  return { key: value.key, bytes: value.bytes, sha256: value.sha256 };
}

function tileId(row, column) {
  return `r${String(row).padStart(2, "0")}-c${String(column).padStart(2, "0")}`;
}

export function buildTileIndexObjects({ runId, sourceManifest, grid, forecasts, tileSize = INDEX_TILE_SIZE }) {
  if (!/^\d{8}T\d{6}Z$/.test(runId || "")) throw new Error("GFS_INDEX_RUN_ID_INVALID");
  const source = descriptor(sourceManifest, "GFS_INDEX_SOURCE_MANIFEST_INVALID");
  if (source.key !== `runs/${runId}/manifest.json`) throw new Error("GFS_INDEX_SOURCE_MANIFEST_KEY_INVALID");
  if (!Number.isInteger(tileSize) || tileSize < 1 || tileSize > 16) throw new Error("GFS_INDEX_TILE_SIZE_INVALID");
  validateGridShard(grid);
  if (grid.schemaVersion !== GRID_SCHEMA || !Array.isArray(forecasts) || !forecasts.length) {
    throw new Error("GFS_INDEX_SOURCE_INVALID");
  }
  const points = grid.grid.points;
  const columns = Number(grid.grid.Ni);
  const rows = Number(grid.grid.Nj);
  if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1 || rows * columns !== points.length) {
    throw new Error("GFS_INDEX_GRID_SHAPE_INVALID");
  }
  const contracts = forecasts.map(({ descriptor: item, value }) => {
    const sourceShard = descriptor(item, "GFS_INDEX_FORECAST_DESCRIPTOR_INVALID");
    validateForecastShard(value, points.length);
    if (value.schemaVersion !== FORECAST_SCHEMA || value.frameId !== item.frameId || sourceShard.key !== item.key) {
      throw new Error("GFS_INDEX_FORECAST_MISMATCH");
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
  const groups = new Map();
  for (let position = 0; position < points.length; position += 1) {
    const point = points[position];
    const row = Math.floor(Math.floor(position / columns) / tileSize);
    const column = Math.floor((position % columns) / tileSize);
    const id = tileId(row, column);
    if (!groups.has(id)) groups.set(id, { id, row, column, points: [] });
    groups.get(id).points.push(point);
  }
  const valueMaps = forecasts.map(({ value }) => new Map(value.frame.values.map((item) => [item.pointId, item])));
  const tileObjects = [...groups.values()].sort((left, right) => left.id.localeCompare(right.id)).map((group) => {
    const tile = {
      schemaVersion: INDEX_TILE_SCHEMA,
      status: "AVAILABLE",
      runId,
      modelRunAt: grid.modelRunAt,
      sourceManifest: source,
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
      contracts,
      points: group.points.sort((left, right) => left.id - right.id).map((point) => ({
        pointId: point.id,
        latitude: point.latitude,
        longitude: point.longitude,
        values: contracts.map((contract, index) => {
          const value = valueMaps[index].get(point.id);
          if (!value) throw new Error("GFS_INDEX_POINT_VALUE_MISSING");
          return {
            frameId: contract.frameId,
            rawValue: value.rawValue,
            quantitativeValue: value.quantitativeValue,
            status: value.status
          };
        })
      }))
    };
    const encoded = encodeObject(tile);
    return {
      key: indexTileKey(runId, group.id),
      tileId: group.id,
      row: group.row,
      column: group.column,
      bounds: tile.tile.bounds,
      pointIds: tile.points.map((point) => point.pointId),
      ...encoded
    };
  });
  const manifest = {
    schemaVersion: INDEX_MANIFEST_SCHEMA,
    status: "COMPLETE",
    indexVersion: INDEX_VERSION,
    runId,
    modelRunAt: grid.modelRunAt,
    sourceManifest: source,
    grid: {
      key: `runs/${runId}/grid.json`,
      Ni: grid.grid.Ni,
      Nj: grid.grid.Nj,
      resolutionDegrees: grid.grid.resolutionDegrees,
      pointCount: points.length
    },
    tileSize,
    contractCount: contracts.length,
    tiles: tileObjects.map(({ body, ...item }) => item),
    objectCount: tileObjects.length
  };
  const encoded = encodeObject(manifest);
  return {
    manifest,
    manifestObject: { key: indexManifestKey(runId), ...encoded },
    tileObjects
  };
}

export function validateIndexManifest(value, { runId, sourceManifest } = {}) {
  if (value?.schemaVersion !== INDEX_MANIFEST_SCHEMA || value.status !== "COMPLETE" || value.indexVersion !== INDEX_VERSION
    || value.runId !== runId || !Array.isArray(value.tiles) || !value.tiles.length || value.objectCount !== value.tiles.length) {
    throw new Error("GFS_INDEX_MANIFEST_INVALID");
  }
  const source = descriptor(value.sourceManifest, "GFS_INDEX_SOURCE_MANIFEST_INVALID");
  if (source.key !== sourceManifest?.key || source.sha256 !== sourceManifest?.sha256 || source.bytes !== sourceManifest?.bytes) {
    throw new Error("GFS_INDEX_SOURCE_MANIFEST_MISMATCH");
  }
  const pointIds = new Set();
  for (const tile of value.tiles) {
    descriptor(tile, "GFS_INDEX_TILE_DESCRIPTOR_INVALID");
    if (!Array.isArray(tile.pointIds) || !tile.pointIds.length || tile.pointIds.some((id) => !Number.isInteger(id) || pointIds.has(id))) {
      throw new Error("GFS_INDEX_POINT_MAP_INVALID");
    }
    tile.pointIds.forEach((id) => pointIds.add(id));
  }
  if (pointIds.size !== value.grid?.pointCount) throw new Error("GFS_INDEX_POINT_COVERAGE_INVALID");
  return value;
}

export function validateIndexTile(value, { runId, sourceManifest, descriptor: expected, contractCount } = {}) {
  if (value?.schemaVersion !== INDEX_TILE_SCHEMA || value.status !== "AVAILABLE" || value.runId !== runId
    || value.tile?.id !== expected?.tileId || !Array.isArray(value.contracts) || value.contracts.length !== contractCount
    || !Array.isArray(value.points) || JSON.stringify(value.points.map((point) => point.pointId)) !== JSON.stringify(expected.pointIds)) {
    throw new Error("GFS_INDEX_TILE_INVALID");
  }
  const source = descriptor(value.sourceManifest, "GFS_INDEX_SOURCE_MANIFEST_INVALID");
  if (source.sha256 !== sourceManifest.sha256 || source.bytes !== sourceManifest.bytes || source.key !== sourceManifest.key) {
    throw new Error("GFS_INDEX_SOURCE_MANIFEST_MISMATCH");
  }
  for (const contract of value.contracts) descriptor(contract.sourceShard, "GFS_INDEX_SOURCE_SHARD_INVALID");
  for (const point of value.points) {
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || !Array.isArray(point.values)
      || point.values.length !== value.contracts.length) throw new Error("GFS_INDEX_TILE_POINT_INVALID");
    for (let index = 0; index < point.values.length; index += 1) {
      const item = point.values[index];
      if (item.frameId !== value.contracts[index].frameId || !["AVAILABLE", "MISSING"].includes(item.status)) {
        throw new Error("GFS_INDEX_TILE_VALUE_INVALID");
      }
      if (item.status === "MISSING" ? item.rawValue !== null || item.quantitativeValue !== null
        : typeof item.rawValue !== "string" || !Number.isFinite(item.quantitativeValue) || item.quantitativeValue < 0) {
        throw new Error("GFS_INDEX_TILE_VALUE_INVALID");
      }
    }
  }
  return value;
}

export async function buildIndexesFromPublishedStore(store, { latest, manifest } = {}) {
  if (!latest || !manifest) throw new Error("GFS_INDEX_PUBLICATION_REQUIRED");
  const gridBody = await store.get(manifest.grid.key);
  if (gridBody.byteLength !== manifest.grid.bytes || sha256(gridBody) !== manifest.grid.sha256) throw new Error("GFS_INDEX_GRID_INTEGRITY_FAILED");
  const grid = JSON.parse(gridBody.toString("utf8"));
  const forecasts = [];
  for (const item of manifest.forecasts) {
    const body = await store.get(item.key);
    if (body.byteLength !== item.bytes || sha256(body) !== item.sha256) throw new Error("GFS_INDEX_FORECAST_INTEGRITY_FAILED");
    forecasts.push({ descriptor: item, value: JSON.parse(body.toString("utf8")) });
  }
  return buildTileIndexObjects({ runId: latest.runId, sourceManifest: latest.manifest, grid, forecasts });
}
