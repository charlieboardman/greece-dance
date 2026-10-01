// Optional live OSM check; requests only tiles visible in the test browser.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server/app.js";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = (await createApp({ editor: null })).listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
try {
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && message.text().includes("Basemap error")) errors.push(message.text());
  });
  await page.route("**/app.js", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("map.addControl(new NavigationControl",
      "window.testMap = map; map.addControl(new NavigationControl") });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("#map-option option").count(), 4);
  const count = await page.locator(".village-icon").count();
  await page.selectOption("#map-option", "streets");
  await page.waitForFunction(() => window.testMap.getLayer("place-labels") && window.testMap.loaded());
  assert.equal(await page.evaluate(() => window.testMap.getMaxZoom()), 19);
  await page.evaluate(() => window.testMap.jumpTo({ center: [23.73, 37.98], zoom: 10 }));
  await page.waitForFunction(() => window.testMap.loaded() &&
    window.testMap.queryRenderedFeatures({ layers: ["place-labels"] }).length > 0);
  const names = await page.evaluate(() => window.testMap.queryRenderedFeatures({ layers: ["place-labels"] })
    .map(feature => feature.properties.name_en || feature.properties.name));
  assert.ok(names.some(name => /Athens|Αθήνα/.test(name)), JSON.stringify(names));
  // Reproduce the three duplicate village labels from the screenshot.
  await page.evaluate(() => window.testMap.jumpTo({ center: [26.28, 41.517], zoom: 12 }));
  await page.waitForTimeout(100);
  await page.waitForFunction(() => window.testMap.loaded() && window.testMap.getFilter("place-labels") &&
    window.testMap.querySourceFeatures("shortbread", { sourceLayer: "place_labels" }).length > 0);
  async function checkVillageLabelSuppression() {
    await page.waitForFunction(() => window.testMap.loaded());
    const labels = await page.evaluate(async () => {
      const map = window.testMap;
      const { regions } = await (await fetch("/api/content")).json();
      const dots = regions.flatMap(region => [...region.villages,
        ...region.subregions.flatMap(subregion => subregion.villages)])
        .map(village => map.project([village.coordinates[1], village.coordinates[0]]));
      const nearby = feature => {
        const point = map.project(feature.geometry.coordinates);
        return dots.some(dot => Math.hypot(dot.x - point.x, dot.y - point.y) < 35);
      };
      const raw = map.querySourceFeatures("shortbread", { sourceLayer: "place_labels" });
      const rendered = map.queryRenderedFeatures({ layers: ["place-labels"] });
      return { nearbySourceLabels: raw.filter(nearby).length,
        nearbyRenderedLabels: rendered.filter(nearby).length, surroundingLabels: rendered.length };
    });
    assert.ok(labels.nearbySourceLabels >= 3, JSON.stringify(labels));
    assert.equal(labels.nearbyRenderedLabels, 0, JSON.stringify(labels));
    assert.ok(labels.surroundingLabels > 0, JSON.stringify(labels));
  }
  await checkVillageLabelSuppression();
  await page.evaluate(() => window.testMap.jumpTo({ center: [26.285, 41.517], zoom: 11.5 }));
  await page.waitForTimeout(100);
  await checkVillageLabelSuppression();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(100);
  await checkVillageLabelSuppression();
  await page.evaluate(() => window.testMap.jumpTo({ center: [23.73, 37.98], zoom: 18 }));
  await page.waitForFunction(() => window.testMap.loaded() &&
    window.testMap.queryRenderedFeatures({ layers: ["buildings"] }).length > 0);
  assert.ok(await page.evaluate(() => window.testMap.queryRenderedFeatures({ layers: ["road-labels"] }).length > 0));
  await page.locator('[data-language="el"]').click();
  assert.deepEqual(await page.evaluate(() => window.testMap.getLayoutProperty("place-labels", "text-field")),
    ["coalesce", ["get", "name_el"], ["get", "name"]]);
  assert.equal(await page.locator(".village-icon").count(), count);
  assert.ok(await page.locator(".maplibregl-ctrl-attrib").textContent().then(text => text.includes("OpenStreetMap")));
  // Existing village notes remain available over the detailed basemap.
  await page.locator(".village-icon").first().evaluate(element => element.click());
  assert.equal(await page.locator("#village-info-popup").isVisible(), true);
  await page.locator("#village-info-close").click();
  await page.selectOption("#map-option", "terrain");
  assert.equal(await page.evaluate(() => window.testMap.getMaxZoom()), 11);
  assert.ok(await page.evaluate(() => window.testMap.getZoom() <= 11));
  await page.selectOption("#map-option", "streets");
  await page.waitForFunction(() => window.testMap.getLayer("place-labels") && window.testMap.loaded());
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator("#map-option").inputValue(), "streets");
  assert.equal(await page.evaluate(() => window.testMap.getMaxZoom()), 19);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#home-button").click();
  await page.waitForFunction(() => window.testMap.loaded());
  assert.equal(await page.locator(".village-icon").count(), count);
  assert.deepEqual(errors, []);
  console.log("OSM Streets passed: real data, duplicate-label suppression after pan/zoom/resize, surrounding towns, languages, markers, switching, persistence, and mobile.");
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
