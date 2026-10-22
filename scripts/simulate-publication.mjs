import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { readGfsForLocation } from "../src/adapter.mjs";
import { LocalObjectStore } from "../src/object-store.mjs";
import { publishDataset } from "../src/publisher.mjs";

if (!process.argv[2]) throw new Error("GFS_SIMULATION_INPUT_REQUIRED");
const input = resolve(process.argv[2]);
const output = resolve(process.argv[3] || ".mock-r2");
if (process.argv.includes("--clean")) await rm(output, { recursive: true, force: true });
const dataset = JSON.parse(await readFile(input, "utf8"));
const store = new LocalObjectStore(output);
const publication = await publishDataset(store, dataset, { now: new Date("2026-10-22T19:00:00Z") });
const sites = [
  { name: "Gimje", latitude: 35.8036, longitude: 126.8809 },
  { name: "Seoul", latitude: 37.5665, longitude: 126.978 },
  { name: "Busan", latitude: 35.1796, longitude: 129.0756 },
  { name: "Jeju", latitude: 33.4996, longitude: 126.5312 }
];
const locations = [];
for (const site of sites) {
  const result = await readGfsForLocation(store, { ...site, enabled: true, now: new Date("2026-10-22T12:00:00Z") });
  locations.push({ name: site.name, status: result.status, gridPoint: result.gridPoint, frames: result.values.length });
}
process.stdout.write(`${JSON.stringify({ publication, locations }, null, 2)}\n`);
