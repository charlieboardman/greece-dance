import { loadArchive } from "../lib/archive.js";

try {
  const archive = await loadArchive(process.argv[2] || new URL("../info/", import.meta.url));
  console.log(`Valid archive: ${archive.regions.length} regions, ${archive.regions.reduce((n, r) => n + r.subregions.length, 0)} subregions, ${archive.places.length} villages.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
