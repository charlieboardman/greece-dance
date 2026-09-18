import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseContentFiles as parseNested, readContentFiles as readNested } from "./nested-content.js";
import { parseContentFiles, jsonText, loadContent } from "../lib/content.js";

export function flattenFiles(files) {
  const content = parseNested(files);
  const output = new Map(), subregions = new Map(), used = new Set();
  for (const record of content.records.filter(r => r.type === "subregion")) {
    const parts = record.path.split("/");
    let id = parts[1].replace(/ \(subregion\)$/u, "");
    if (used.has(id)) id = `${parts[0]}--${id}`;
    if (used.has(id)) throw new Error("Duplicate subregion ID during migration.");
    used.add(id); subregions.set(record.path, id);
  }
  for (const record of content.records) {
    const parts = record.path.split("/");
    const id = record.type === "region" ? parts[0] : record.type === "subregion" ? subregions.get(record.path)
      : parts.map(p => p.replace(/ \(subregion\)$/u, "")).join("--");
    const folder = `${record.type}s/${id}`;
    const metadata = { ...record.metadata };
    if (record.type !== "region") metadata.region = parts[0];
    if (record.type === "village") metadata.subregion = parts.length === 3 ? subregions.get(parts.slice(0, -1).join("/")) : null;
    if (output.has(`${folder}/${record.type}.json`)) throw new Error("Duplicate ID during migration.");
    output.set(`${folder}/${record.type}.json`, jsonText(metadata));
    for (const language of ["en", "el"]) {
      const text = files.get(`${record.path}/info.${language}.md`);
      if (text !== undefined) output.set(`${folder}/info.${language}.md`, text);
    }
  }
  parseContentFiles(output);
  return output;
}
export async function flattenContent(source, destination) {
  const files = flattenFiles(await readNested(source));
  // Refuse existing destinations, including empty ones.
  await mkdir(destination);
  for (const [filename, text] of files) {
    const target = path.join(destination, filename);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  return loadContent(destination);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await flattenContent(process.argv[2] || "info", process.argv[3] || "info-flat");
}
