import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadContent, parseContentFiles, jsonText } from "../lib/content.js";
import { changeFiles } from "../lib/changes.js";
import { parseDancesMarkdown } from "../scripts/legacy-dances.js";
import { migrateContent } from "../scripts/migrate-content.js";

const names = { en: "Region", el: "Περιοχή" };
const base = () => new Map([["regions/region/region.json", jsonText({ names, color: "#336699" })]]);
const normalize = (regions) => regions.map((region) => ({ ...region,
  villages: [...region.villages].sort((a, b) => a.id.localeCompare(b.id)),
  subregions: region.subregions.map((subregion) => ({ ...subregion,
    villages: [...subregion.villages].sort((a, b) => a.id.localeCompare(b.id))
  })).sort((a, b) => a.id.localeCompare(b.id))
})).sort((a, b) => a.id.localeCompare(b.id));

test("migration preserves every region, subregion, village, ID, coordinate, color and info field", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dance-migrate-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = await readFile(new URL("./fixtures/legacy-dances.md", import.meta.url), "utf8");
  const migrated = await migrateContent(source, path.join(temporary, "info"));
  assert.deepEqual(normalize(migrated.regions), normalize(parseDancesMarkdown(source).regions));
  await assert.rejects(migrateContent(source, path.join(temporary, "info")), /already exists/u);
});

test("the current canonical folder content validates without freezing its size", async () => {
  const content = await loadContent(new URL("../info/", import.meta.url));
  assert.equal(new Set(content.places.map((p) => p.id)).size, content.places.length);
  assert.equal(content.records.filter((r) => r.type === "village").length, content.places.length);
});

test("references establish membership and support empty regions/subregions and full Markdown", () => {
  let files = base();
  files = changeFiles(files, { action: "create", path: "subregions/area", metadata: { names, region: "region" } });
  files = changeFiles(files, { action: "create", path: "villages/village",
    metadata: { names, region: "region", subregion: "area", latitude: 40, longitude: 22 }, info: { en: "# History\n\n## Dances\n\nInfo:\n<!-- note -->", el: "" } });
  const content = parseContentFiles(files);
  assert.equal(content.regions[0].subregions[0].villages[0].id, "village");
  assert.match(content.places[0].info.en, /^# History/u);
  assert.equal(content.places[0].info.el, "");
  assert.throws(() => changeFiles(files, { action: "delete", path: "regions/region" }), /contents/u);
  files = changeFiles(files, { action: "delete", path: "villages/village" });
  assert.equal(parseContentFiles(files).regions[0].subregions[0].villages.length, 0);
  files = changeFiles(files, { action: "delete", path: "subregions/area" });
  assert.throws(() => changeFiles(files, { action: "delete", path: "regions/region" }), /at least one region/u);
});

test("schema rejects unknown fields, unsafe paths, invalid coordinates and missing parents", () => {
  for (const folder of ["../escape", "/absolute", "region/../escape", "region/village/child", "region/bad--slug"]) {
    assert.throws(() => changeFiles(base(), { action: "create", path: folder, metadata: { names, region: "region" } }));
  }
  assert.throws(() => parseContentFiles(new Map([["regions/region/region.json", jsonText({ names, color: "red" })]])), /color/u);
  assert.throws(() => parseContentFiles(new Map([["regions/region/region.json", jsonText({ names, color: "#336699", id: "region" })]])), /exactly/u);
  assert.throws(() => changeFiles(base(), { action: "create", path: "villages/village", metadata: { names, region: "region", subregion: "area", latitude: "40", longitude: 22 }, info: { en: "", el: "" } }), /latitude/u);
  assert.throws(() => changeFiles(base(), { action: "create", path: "villages/missing", metadata: { names, region: "missing", subregion: null, latitude: 40, longitude: 22 }, info: { en: "", el: "" } }), /referenced/u);
  assert.throws(() => parseContentFiles(new Map([["villages/village/info.en.md", "notes"]])), /Missing/u);
});

test("filesystem loader rejects symlinks instead of following them", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dance-links-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await writeFile(path.join(temporary, "secret"), "private");
  await symlink(path.join(temporary, "secret"), path.join(temporary, "link"));
  await assert.rejects(loadContent(temporary), /Symbolic links|Files must/u);
});

test("flat migration preserves map output and every Markdown byte", async (t) => {
  const { readContentFiles: readNested } = await import("../scripts/nested-content.js");
  const { flattenFiles, flattenContent } = await import("../scripts/flatten-content.js");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dance-flat-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = await readFile(new URL("./fixtures/legacy-dances.md", import.meta.url), "utf8");
  const nested = path.join(temporary, "nested");
  const before = await migrateContent(source, nested);
  const files = await readNested(nested);
  const markdown = [...files].filter(([key]) => key.endsWith(".md"));
  files.set(markdown[0][0], `\n${markdown[0][1]}\n<!-- preserved spacing -->\n\n`);
  const flat = flattenFiles(files);
  for (const [filename, text] of files) {
    if (!filename.endsWith(".md")) continue;
    const parts = filename.split("/");
    const leaf = parts.pop();
    const id = parts.map(p => p.replace(/ \(subregion\)$/u, "")).join("--");
    assert.equal(flat.get(`villages/${id}/${leaf}`), text);
  }
  const destination = path.join(temporary, "flat");
  const after = await flattenContent(nested, destination);
  assert.deepEqual(normalize(after.regions), normalize(before.regions));
  await assert.rejects(flattenContent(nested, destination), { code: "EEXIST" });
});

test("village moves preserve IDs and notes, validate references, and detect source/destination conflicts", async () => {
  const { checkConflict } = await import("../lib/changes.js");
  let files = base();
  files = changeFiles(files, { action: "create", path: "regions/second", metadata: { names, color: "#abcdef" } });
  files = changeFiles(files, { action: "create", path: "subregions/area", metadata: { names, region: "second" } });
  const village = { action: "create", path: "villages/stable-id", metadata: { names, region: "region", subregion: null, latitude: 40, longitude: 22 }, info: { en: "Notes", el: "Χοροί" } };
  files = changeFiles(files, village);
  files.set("villages/stable-id/info.en.md", "\nNotes\n\n");
  const move = { ...village, action: "update", metadata: { ...village.metadata, region: "second", subregion: "area" } };
  const moved = changeFiles(files, move);
  assert.equal(parseContentFiles(moved).places[0].id, "stable-id");
  assert.equal(parseContentFiles(moved).places[0].regionId, "second");
  assert.equal(parseContentFiles(moved).regions.find(r => r.id === "second").subregions[0].villages.length, 1);
  assert.equal(moved.get("villages/stable-id/info.en.md"), "\nNotes\n\n");
  assert.deepEqual([...moved.keys()].sort(), [...files.keys()].sort());
  assert.throws(() => changeFiles(files, { ...move, metadata: { ...move.metadata, region: "region" } }), /does not belong/u);
  for (const key of ["regions/region/region.json", "regions/second/region.json", "subregions/area/subregion.json", "villages/stable-id/village.json"]) {
    const latest = new Map(files); latest.set(key, latest.get(key) + "\n");
    assert.throws(() => checkConflict(files, latest, move), error => error.status === 409);
  }
  const direct = changeFiles(moved, { ...move, metadata: { ...move.metadata, subregion: null } });
  assert.equal(parseContentFiles(direct).regions.find(r => r.id === "second").villages.length, 1);
});
