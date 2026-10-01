// Optional: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/map-browser.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server/app.js";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const app = await createApp({ editor: null });
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const errors = [];
try {
  for (const viewport of [
    { width: 1440, height: 950 }, { width: 1920, height: 1080 },
    { width: 1280, height: 1024 }, { width: 390, height: 844 },
    { width: 320, height: 960 }, { width: 240, height: 1200 }
  ]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && message.text().includes("Basemap error")) errors.push(message.text());
    });
    // Expose the closure's map only in the test browser.
    await page.route("**/app.js", async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace("map.addControl(new NavigationControl",
        "window.testMap = map; map.addControl(new NavigationControl");
      await route.fulfill({ response, body });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.testMap?.getMinZoom() > 0 && window.testMap.loaded());
    const villageCount = await page.evaluate(async () => {
      const content = await (await fetch("/api/content")).json();
      return content.regions.reduce((total, region) => total + region.villages.length +
        region.subregions.reduce((count, subregion) => count + subregion.villages.length, 0), 0);
    });
    assert.equal(await page.locator(".village-icon").count(), villageCount);
    async function checkCoverage() {
      const bounds = await page.evaluate(() => window.testMap.getBounds().toArray());
      assert.ok(bounds[0][0] >= -0.001 && bounds[0][1] >= -0.001 &&
        bounds[1][0] <= 60.001 && bounds[1][1] <= 60.001, JSON.stringify({ viewport, bounds }));
      return bounds;
    }
    const bounds = await checkCoverage();
    // On ordinary portrait/desktop screens all villages still fit at home.
    if (viewport.width >= 320) {
      const contained = await page.evaluate(async () => {
        const content = await (await fetch("/api/content")).json();
        return content.regions.flatMap(region => [
          ...region.villages, ...region.subregions.flatMap(subregion => subregion.villages)
        ]).every(village => window.testMap.getBounds().contains([village.coordinates[1], village.coordinates[0]]));
      });
      assert.ok(contained, `All villages fit ${JSON.stringify(viewport)}`);
    }
    await page.selectOption("#map-option", "land-sea");
    await page.waitForFunction(() => window.testMap.loaded());
    await checkCoverage();
    for (const center of [[0, 0], [60, 60]]) {
      await page.evaluate(center => window.testMap.jumpTo({ center }), center);
      await checkCoverage();
    }
    await page.setViewportSize({ width: 390, height: 1100 });
    await page.waitForTimeout(100);
    await checkCoverage();
    await page.evaluate(() => window.testMap.jumpTo({ center: [60, 60], zoom: 0 }));
    await checkCoverage();
    console.log(`Map coverage passed ${viewport.width}×${viewport.height}: ${JSON.stringify(bounds)}`);
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
