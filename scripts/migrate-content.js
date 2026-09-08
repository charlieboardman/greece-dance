import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseDancesMarkdown } from "./legacy-dances.js";
import { jsonText, SUBREGION_SUFFIX, loadArchive } from "../lib/archive.js";

export async function migrateContent(source, destination) {
  try { await access(destination); throw new Error(`Destination already exists: ${destination}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const atlas = parseDancesMarkdown(source);
  await mkdir(destination, { recursive: true });
  async function writeMetadata(folder, type, metadata) {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${type}.json`), jsonText(metadata));
  }
  async function village(parent, item) {
    const folder = path.join(parent, item.id.split("--").at(-1));
    await writeMetadata(folder, "village", { names: item.names, latitude: item.coordinates[0], longitude: item.coordinates[1] });
    for (const language of ["en", "el"]) {
      if (item.info[language]) await writeFile(path.join(folder, `info.${language}.md`), `${item.info[language]}\n`);
    }
  }
  for (const region of atlas.regions) {
    const folder = path.join(destination, region.id);
    await writeMetadata(folder, "region", { names: region.names, color: region.color });
    for (const item of region.villages) await village(folder, item);
    for (const subregion of region.subregions) {
      const subfolder = path.join(folder, `${subregion.id}${SUBREGION_SUFFIX}`);
      await writeMetadata(subfolder, "subregion", { names: subregion.names });
      for (const item of subregion.villages) await village(subfolder, item);
    }
  }
  return loadArchive(destination);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2] || "tests/fixtures/legacy-dances.md";
  const destination = process.argv[3] || "info";
  const archive = await migrateContent(await readFile(source, "utf8"), destination);
  console.log(`Migrated ${archive.regions.length} regions and ${archive.places.length} villages to ${destination}.`);
}
