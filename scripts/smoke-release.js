import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server/app.js";

const app = await createApp({ editor: null, production: true });
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const url of ["/", "/api/health", "/api/content", "/editor/", "/vendor/maplibre-gl.mjs"]) {
    assert.equal((await fetch(base + url)).status, 200, url);
  }
  const response = await fetch(`${base}/assets/basemaps/srtm-relief/greece-srtm-relief.pmtiles`, { headers: { Range: "bytes=0-126" } });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 127);
  console.log("Release smoke check passed (map content, public pages, editor assets, PMTiles byte ranges).");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
