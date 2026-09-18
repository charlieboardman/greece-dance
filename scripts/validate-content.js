import { loadContent } from "../lib/content.js";

try {
  const content = await loadContent(process.argv[2] || new URL("../info/", import.meta.url));
  console.log(`Valid map content: ${content.regions.length} regions, ${content.regions.reduce((n, r) => n + r.subregions.length, 0)} subregions, ${content.places.length} villages.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
