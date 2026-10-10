import { readFile, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { contentService } from "./content-service.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const production = process.env.NODE_ENV === "production";
let editor = null;
let published = null;
let service = null;
if (process.env.LIVE_INFO_DIR || process.env.EDITOR_ENABLED === "true") {
  service = await contentService();
  if (process.env.EDITOR_ENABLED === "true") editor = service.editor;
  if (process.env.LIVE_INFO_DIR || editor) {
    published = service.publisher;
    try { await published.snapshot(); }
    catch (error) { if (error.code !== "ENOENT") throw error; await service.editor.publish(); }
  }
}
let revision = "development";
try { revision = (await readFile(path.join(root, ".release-sha"), "utf8")).trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
let basemapVersion = "development";
try { basemapVersion = (await readFile(path.join(root, ".basemap-version"), "utf8")).trim(); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  if (production) throw new Error("Missing terrain release metadata; deploy with the current setup.sh.");
}
if (!/^(?:development|[a-f0-9]{64})$/u.test(basemapVersion)) throw new Error("Invalid basemap release version.");
if (basemapVersion !== "development") {
  const directory = path.join(process.env.BASEMAP_DIR || path.join(root, "assets/basemaps/generated"), basemapVersion);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.version !== basemapVersion) throw new Error("Terrain artifact version mismatch.");
  for (const name of ["overview.pmtiles", "greece-srtm-relief.pmtiles"]) {
    if (!/^[a-f0-9]{64}$/u.test(manifest.files?.[name] || "")) throw new Error("Terrain manifest is incomplete.");
    const file = await open(path.join(directory, name));
    try {
      const header = Buffer.alloc(127);
      const { bytesRead } = await file.read(header, 0, 127, 0);
      if (bytesRead !== 127 || header.subarray(0, 7).toString() !== "PMTiles" || header[7] !== 3) throw new Error("Terrain archive is unavailable.");
    } finally { await file.close(); }
  }
}
const app = await createApp({ root, editor, production, revision, published, basemapVersion,
  passwordHash: process.env.EDITOR_PASSWORD_HASH, sessionSecret: process.env.SESSION_SECRET,
  origin: process.env.APP_ORIGIN || "http://localhost:8000" });
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";
const server = app.listen(port, host, () => console.log(`National Dance Ministry Map listening on http://${host}:${port} (${revision})`));
// Recover only interrupted operations. This does not automatically deploy code
// or publish arbitrary laptop pushes; operators use update-info.sh for those.
server.on("close", () => app.locals.closeMaps());
const recovery = service && setInterval(() => service.editor.recover().catch(() => {}), 5000);
recovery?.unref();
if (service) void service.editor.recover().catch(() => {});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
});
