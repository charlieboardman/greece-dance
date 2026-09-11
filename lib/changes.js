import { createHash } from "node:crypto";
import { ContentError, jsonText, parseArchiveFiles, recordType, validateMetadata } from "./archive.js";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export function changeFiles(files, change) {
  if (!change || !["create", "update", "delete"].includes(change.action) || typeof change.path !== "string") {
    throw new ContentError("Choose an action and a record path.");
  }
  const type = recordType(change.path);
  const metadataPath = `${change.path}/${type}.json`;
  const exists = files.has(metadataPath);
  if (change.action === "create" ? exists : !exists) {
    throw new ContentError(change.action === "create" ? "That folder already exists." : "That record no longer exists.", 409);
  }
  const result = new Map(files);
  if (change.action === "delete") {
    const id = change.path.split("/")[1];
    const children = parseArchiveFiles(files).records.filter(record => type === "region"
      ? record.metadata.region === id : type === "subregion" && record.metadata.subregion === id);
    if (children.length) throw new ContentError("Move or delete the contents before deleting a region or subregion.");
    for (const key of result.keys()) if (key.startsWith(`${change.path}/`)) result.delete(key);
  } else {
    validateMetadata(type, change.metadata);
    result.set(metadataPath, jsonText(change.metadata));
    if (type === "village") {
      if (!change.info || Object.keys(change.info).some((key) => !["en", "el"].includes(key))) throw new ContentError("Provide English and Greek info text.");
      for (const language of ["en", "el"]) {
        const text = change.info[language];
        if (typeof text !== "string") throw new ContentError(`info.${language} must be text.`);
        const filename = `${change.path}/info.${language}.md`;
        // Preserve untouched Markdown byte for byte, including hand-written spacing.
        if ((files.get(filename) || "").trim() === text.trim()) continue;
        if (text.trim()) result.set(filename, `${text.trim()}\n`);
        else result.delete(filename);
      }
    }
  }
  parseArchiveFiles(result);
  return result;
}

export function checkConflict(baseFiles, latestFiles, change) {
  recordType(change.path);
  const dependencies = new Set();
  const addReferences = metadata => {
    if (metadata?.region) dependencies.add(`regions/${metadata.region}/region.json`);
    if (metadata?.subregion) dependencies.add(`subregions/${metadata.subregion}/subregion.json`);
  };
  const type = recordType(change.path);
  const original = baseFiles.get(`${change.path}/${type}.json`);
  if (original) addReferences(JSON.parse(original));
  addReferences(change.metadata);
  // Include both source and destination relationships as loaded by the editor.
  for (const key of [...dependencies]) {
    if (key.startsWith("subregions/") && baseFiles.has(key)) addReferences(JSON.parse(baseFiles.get(key)));
  }
  if (change.action === "delete" && type !== "village") {
    const id = change.path.split("/")[1];
    for (const files of [baseFiles, latestFiles]) {
      for (const record of parseArchiveFiles(files).records) {
        if (type === "region" ? record.metadata.region === id : record.metadata.subregion === id) {
          dependencies.add(`${record.path}/${record.type}.json`);
        }
      }
    }
  }
  const relevant = key => key.startsWith(`${change.path}/`) || dependencies.has(key);
  const keys = new Set([...baseFiles.keys(), ...latestFiles.keys()]);
  if ([...keys].some((key) => relevant(key) && baseFiles.get(key) !== latestFiles.get(key))) {
    throw new ContentError("This record or its region/subregion changed since you opened it. Your input has been kept. Reload the latest archive and review your edits before trying again.", 409);
  }
}

export function fileChanges(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((filename) => {
    if (before.get(filename) === after.get(filename)) return [];
    return [{ path: `info/${filename}`, before: before.get(filename) ?? null, after: after.get(filename) ?? null }];
  });
}
