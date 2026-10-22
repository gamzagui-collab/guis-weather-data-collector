import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

function checkedKey(key) {
  const value = String(key || "").replaceAll("\\", "/");
  if (!value || value.startsWith("/") || value.includes("..") || value.includes(":") || !/^[a-zA-Z0-9._/-]+$/.test(value)) {
    throw new Error("OBJECT_KEY_INVALID");
  }
  return value;
}

function checksum(body) {
  return createHash("sha256").update(body).digest("hex");
}

export class LocalObjectStore {
  constructor(root) {
    this.root = resolve(root);
  }

  path(key) {
    const value = resolve(this.root, ...checkedKey(key).split("/"));
    if (value !== this.root && !value.startsWith(`${this.root}${sep}`)) throw new Error("OBJECT_KEY_ESCAPE");
    return value;
  }

  async put(key, input, { atomic = false } = {}) {
    const target = this.path(key);
    const body = Buffer.isBuffer(input) ? input : Buffer.from(input);
    await mkdir(dirname(target), { recursive: true });
    if (atomic) {
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { flag: "wx" });
      await rename(temporary, target);
    } else await writeFile(target, body);
    return { key: checkedKey(key), bytes: body.byteLength, sha256: checksum(body) };
  }

  async get(key) {
    try { return await readFile(this.path(key)); }
    catch (error) {
      if (error?.code === "ENOENT") throw new Error("OBJECT_NOT_FOUND");
      throw error;
    }
  }

  async tryGet(key) {
    try { return await this.get(key); }
    catch (error) { if (error.message === "OBJECT_NOT_FOUND") return null; throw error; }
  }

  async head(key) {
    try {
      const target = this.path(key);
      const info = await stat(target);
      if (!info.isFile()) throw new Error("OBJECT_NOT_FOUND");
      return { key: checkedKey(key), bytes: info.size, lastModified: info.mtime.toISOString() };
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("OBJECT_NOT_FOUND");
      throw error;
    }
  }

  async list(prefix = "") {
    const normalizedPrefix = prefix ? checkedKey(prefix) : "";
    const base = this.path(normalizedPrefix || ".");
    const results = [];
    const walk = async (directory) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error?.code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const target = join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() && !entry.name.endsWith(".tmp")) results.push(relative(this.root, target).replaceAll("\\", "/"));
      }
    };
    await walk(base);
    return results.sort();
  }

  async delete(key) {
    await rm(this.path(key), { force: true });
  }
}

export function assertObjectStore(store) {
  for (const method of ["put", "get", "tryGet", "head", "list", "delete"]) {
    if (typeof store?.[method] !== "function") throw new Error(`OBJECT_STORE_${method.toUpperCase()}_MISSING`);
  }
  return store;
}
