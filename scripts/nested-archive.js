// Historical nested format reader, used only by migration tools/tests.
// Live archive loading is implemented in lib/archive.js.
import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUBREGION_SUFFIX = " (subregion)";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_FILE = 128 * 1024;
export class ContentError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (location, message) => { throw new ContentError(`${location}: ${message}`); };
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function recordType(folder) {
  const parts = folder.split("/");
  if (!parts.length || parts.length > 3) fail(folder, "Invalid record path.");
  parts.forEach((part, index) => {
    const subregion = part.endsWith(SUBREGION_SUFFIX);
    if (subregion && index !== 1) fail(folder, "Subregions belong directly to a region.");
    if (!SLUG.test(subregion ? part.slice(0, -SUBREGION_SUFFIX.length) : part)) {
      fail(folder, "Use lowercase letters, numbers, and single hyphens for folder slugs.");
    }
  });
  if (parts.length === 1) return "region";
  if (parts.length === 2) return parts[1].endsWith(SUBREGION_SUFFIX) ? "subregion" : "village";
  if (!parts[1].endsWith(SUBREGION_SUFFIX)) fail(folder, "Villages cannot contain other records.");
  return "village";
}

function object(value, location, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(location, "Expected an object.");
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) {
    fail(location, `Expected exactly these fields: ${keys.join(", ")}.`);
  }
}

export function validateMetadata(type, value, location = type) {
  const fields = type === "region" ? ["names", "color"]
    : type === "village" ? ["names", "latitude", "longitude"] : ["names"];
  object(value, location, fields);
  object(value.names, `${location}.names`, ["en", "el"]);
  for (const lang of ["en", "el"]) {
    const name = value.names[lang];
    if (typeof name !== "string" || !name.trim() || name !== name.trim() || name.length > 200 || /[\r\n\x00-\x1f]/u.test(name)) {
      fail(location, `names.${lang} must be a nonempty, trimmed, single-line name (up to 200 characters).`);
    }
  }
  if (type === "region" && (typeof value.color !== "string" || !/^#[\da-f]{6}$/iu.test(value.color))) fail(location, "color must be a six-digit hex color.");
  if (type === "village") {
    for (const [key, limit] of [["latitude", 90], ["longitude", 180]]) {
      if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || Math.abs(value[key]) > limit) {
        fail(location, `${key} must be a number between ${-limit} and ${limit}.`);
      }
    }
  }
  return value;
}

// File keys are relative to info/. This pure entry point also validates Git trees.
export function parseArchiveFiles(files) {
  const records = new Map();
  let total = 0;
  for (const [filename, text] of files) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_FILE || text.includes("\0")) fail(filename, "Invalid or oversized text file.");
    total += Buffer.byteLength(text);
    if (total > 16 * 1024 * 1024) fail("info/", "Archive text size limit exceeded.");
    const slash = filename.lastIndexOf("/");
    if (slash < 0) fail(filename, "Files must belong to a region or village folder.");
    const folder = filename.slice(0, slash);
    const name = filename.slice(slash + 1);
    const type = recordType(folder);
    const allowed = [`${type}.json`, ...(type === "village" ? ["info.en.md", "info.el.md"] : [])];
    if (!allowed.includes(name)) fail(filename, `Expected ${allowed.join(" or ")}.`);
    if (!records.has(folder)) records.set(folder, { path: folder, type, info: { en: "", el: "" } });
    const record = records.get(folder);
    if (name.endsWith(".json")) {
      let metadata;
      try { metadata = JSON.parse(text); } catch { fail(filename, "Invalid JSON."); }
      record.metadata = validateMetadata(type, metadata, filename);
    } else record.info[name === "info.en.md" ? "en" : "el"] = text.trim();
  }
  const regions = [];
  const nodes = new Map();
  const places = [];
  const orderedRecords = [...records.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
  for (const record of orderedRecords) {
    const { path: folder, type, metadata, info } = record;
    if (!metadata) fail(folder, `Missing ${type}.json.`);
    const parts = folder.split("/");
    const parent = nodes.get(parts.slice(0, -1).join("/"));
    const idParts = parts.map((part) => part.replace(/ \(subregion\)$/u, ""));
    const node = { id: type === "village" ? idParts.join("--") : idParts.at(-1), name: metadata.names.en, names: metadata.names };
    if (type === "region") {
      Object.assign(node, { color: metadata.color.toLowerCase(), villages: [], subregions: [] });
      regions.push(node);
    } else {
      if (!parent) fail(folder, "Missing parent metadata.");
      if (type === "subregion") {
        Object.assign(node, { villages: [] });
        parent.subregions.push(node);
      } else {
        Object.assign(node, { coordinates: [metadata.latitude, metadata.longitude], info });
        parent.villages.push(node);
        const subregion = parts.length === 3 ? parent : null;
        places.push({ ...node, lat: metadata.latitude, lon: metadata.longitude, regionId: parts[0],
          subregionName: subregion?.name || "", subregionNames: subregion?.names || { en: "", el: "" } });
      }
    }
    nodes.set(folder, node);
  }
  if (!regions.length) fail("info/", "Keep at least one region in the archive (it may be empty).");
  return { regions, places, records: orderedRecords };
}

export async function readArchiveFiles(root) {
  if (root instanceof URL) root = fileURLToPath(root);
  if (!(await lstat(root)).isDirectory()) fail(root, "Expected a real directory.");
  const files = new Map();
  let total = 0;
  async function walk(relative = "", depth = 0) {
    if (depth > 3) fail(relative, "Unexpected nested directory.");
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail(key, "Symbolic links are not allowed in info/.");
      if (entry.isDirectory()) {
        recordType(key);
        // A tracked metadata file is required even for an otherwise empty folder.
        await walk(key, depth + 1);
        if (!files.has(`${key}/${recordType(key)}.json`)) fail(key, "Missing metadata file.");
      } else if (entry.isFile()) {
        const stat = await lstat(path.join(root, key));
        if (stat.mode & 0o111) fail(key, "Executable files are not allowed in info/.");
        total += stat.size;
        if (stat.size > MAX_FILE || total > 16 * 1024 * 1024) fail(key, "Archive text size limit exceeded.");
        files.set(key, await readFile(path.join(root, key), "utf8"));
      } else fail(key, "Only regular files and directories are allowed.");
    }
  }
  await walk();
  return files;
}

export async function loadArchive(root) { return parseArchiveFiles(await readArchiveFiles(root)); }
