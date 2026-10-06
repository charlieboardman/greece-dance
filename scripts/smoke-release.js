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
  const html = await (await fetch(base + "/")).text();
  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/u);
  assert.match(html, /href="assets\/fonts\/fonts\.css"/u);
  const fontStylesheet = await fetch(base + "/assets/fonts/fonts.css");
  assert.equal(fontStylesheet.status, 200);
  const fontCss = await fontStylesheet.text();
  const fontUrls = [...fontCss.matchAll(/url\("\.\/([^"]+\.woff2)"\)/gu)].map(match => match[1]);
  assert.equal(fontUrls.length, 4);
  assert.doesNotMatch(fontCss, /https?:\/\//u);
  for (const fontUrl of fontUrls) {
    const response = await fetch(`${base}/assets/fonts/${fontUrl}`);
    assert.equal(response.status, 200, fontUrl);
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), "wOF2", fontUrl);
  }
  for (const family of ["dm-sans", "gloock"]) {
    const response = await fetch(`${base}/assets/fonts/${family}/OFL.txt`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /SIL OPEN FONT LICENSE Version 1\.1/u);
  }
  for (const asset of ["srtm-relief/greece-srtm-relief.pmtiles", "srtm-relief/overview.pmtiles", "etopo-2022-hydrography/overview.pmtiles"]) {
    const response = await fetch(`${base}/assets/basemaps/${asset}`, { headers: { Range: "bytes=0-126" } });
    assert.equal(response.status, 206, asset);
    assert.equal((await response.arrayBuffer()).byteLength, 127, asset);
  }
  console.log("Release smoke check passed (map content, public pages, local fonts and licenses, editor assets, PMTiles byte ranges).");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
