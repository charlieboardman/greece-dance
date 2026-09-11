import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadArchive, parseArchiveFiles, jsonText } from "../lib/archive.js";
import { changeFiles } from "../lib/changes.js";
import { parseDancesMarkdown } from "../scripts/legacy-dances.js";
import { migrateContent } from "../scripts/migrate-content.js";

const names = { en: "Region", el: "Περιοχή" };
const base = () => new Map([["region/region.json", jsonText({ names, color: "#336699" })]]);
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

test("the current canonical folder archive validates without freezing its size", async () => {
  const archive = await loadArchive(new URL("../info/", import.meta.url));
  assert.equal(new Set(archive.places.map((p) => p.id)).size, archive.places.length);
  assert.equal(archive.records.filter((r) => r.type === "village").length, archive.places.length);
});

test("folders establish membership and support empty regions/subregions and full Markdown", () => {
  let files = base();
  files = changeFiles(files, { action: "create", path: "region/area (subregion)", metadata: { names } });
  files = changeFiles(files, { action: "create", path: "region/area (subregion)/village",
    metadata: { names, latitude: 40, longitude: 22 }, info: { en: "# History\n\n## Dances\n\nInfo:\n<!-- note -->", el: "" } });
  const archive = parseArchiveFiles(files);
  assert.equal(archive.regions[0].subregions[0].villages[0].id, "region--area--village");
  assert.match(archive.places[0].info.en, /^# History/u);
  assert.equal(archive.places[0].info.el, "");
  assert.throws(() => changeFiles(files, { action: "delete", path: "region" }), /contents/u);
  files = changeFiles(files, { action: "delete", path: "region/area (subregion)/village" });
  assert.equal(parseArchiveFiles(files).regions[0].subregions[0].villages.length, 0);
  files = changeFiles(files, { action: "delete", path: "region/area (subregion)" });
  assert.throws(() => changeFiles(files, { action: "delete", path: "region" }), /at least one region/u);
});

test("schema rejects unknown fields, unsafe paths, invalid coordinates and missing parents", () => {
  for (const folder of ["../escape", "/absolute", "region/../escape", "region/village/child", "region/bad--slug"]) {
    assert.throws(() => changeFiles(base(), { action: "create", path: folder, metadata: { names } }));
  }
  assert.throws(() => parseArchiveFiles(new Map([["region/region.json", jsonText({ names, color: "red" })]])), /color/u);
  assert.throws(() => parseArchiveFiles(new Map([["region/region.json", jsonText({ names, color: "#336699", id: "region" })]])), /exactly/u);
  assert.throws(() => changeFiles(base(), { action: "create", path: "region/village", metadata: { names, latitude: "40", longitude: 22 }, info: { en: "", el: "" } }), /latitude/u);
  assert.throws(() => changeFiles(base(), { action: "create", path: "missing/village", metadata: { names, latitude: 40, longitude: 22 }, info: { en: "", el: "" } }), /parent/u);
  assert.throws(() => parseArchiveFiles(new Map([["region/village/info.en.md", "notes"]])), /Missing/u);
});

test("filesystem loader rejects symlinks instead of following them", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dance-links-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await writeFile(path.join(temporary, "secret"), "private");
  await symlink(path.join(temporary, "secret"), path.join(temporary, "link"));
  await assert.rejects(loadArchive(temporary), /Symbolic links|Files must/u);
});
