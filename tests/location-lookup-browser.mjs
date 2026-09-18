// Optional real-browser regression test. Uses a local server and deterministic
// provider responses; no network geocoding or content publication.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/password.js";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const records = [
  { type: "region", path: "regions/pieria", metadata: { names: { en: "Pieria", el: "Πιερία" }, color: "#336699" } },
  { type: "region", path: "regions/thessaly", metadata: { names: { en: "Thessaly", el: "Θεσσαλία" }, color: "#663399" } }
];
const candidate = { id: "Q3555789", name: "Elatochori", greek: "Ελατοχώρι", description: "Village in Pieria, Greece", latitude: 40.32, longitude: 22.265, source: "Wikidata", url: "https://www.wikidata.org/wiki/Q3555789" };
let server, browser, release, serverBusy = false;
const calls = [];
try {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const editor = {
    status: async () => ({ busy: serverBusy, operation: null }),
    snapshot: async () => ({ revision: "a".repeat(40), records }),
    preview: async () => ({ previewHash: "test-preview", changes: [] }),
    submit: () => assert.fail("Lookup must not submit content")
  };
  const app = await createApp({ editor, origin, passwordHash: await hashPassword("test-password"), sessionSecret: "s".repeat(64),
    locationLookup: async input => {
      calls.push(input);
      if (input.query === "Slow") await new Promise(resolve => { release = resolve; });
      if (input.query === "Failure") throw new Error("Do not leak provider internals");
      return { candidates: input.query === "Missing" ? [] : input.includeWikipedia
        ? [{ ...candidate, source: "Wikipedia", name: "<img src=x onerror=alert(1)>", url: "https://en.wikipedia.org/wiki/Elatochori" }]
        : [candidate], wikipediaSearched: input.includeWikipedia || input.query === "Missing", warnings: [] };
    }
  });
  server = app.listen(port, "127.0.0.1"); await once(server, "listening");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", req => { if (!req.url().startsWith(origin)) external.push(req.url()); });
  page.on("dialog", dialog => dialog.accept());
  await page.goto(`${origin}/editor/`);
  await page.locator('[name="password"]').fill("test-password");
  await page.locator('#login button').click();
  await page.waitForFunction(() => !document.getElementById("new-region").disabled);
  await page.locator("#new-region").click();
  assert.equal(await page.locator("#find-location").isVisible(), false);
  await page.locator("#new-village").click();
  await page.locator("#find-location").click();
  assert.match(await page.locator("#lookup-status").textContent(), /Enter an English/u);
  assert.equal(calls.length, 0);
  await page.locator("#name-en").fill("Elatohori");
  await page.locator("#name-el").fill("My historical Greek name");
  await page.locator("#latitude").fill("40.1");
  await page.locator("#longitude").fill("22.1");
  await page.locator("#info-en").fill("Do not alter these research notes.");
  await page.locator('#edit button[type="submit"]').click();
  await page.waitForFunction(() => !document.getElementById("preview").hidden);
  await page.locator("#find-location").click();
  await page.locator("#lookup-results button").waitFor();
  assert.equal(await page.locator("#latitude").inputValue(), "40.1", "Even one result requires confirmation");
  assert.equal(await page.locator("#lookup-use-greek").isChecked(), false);
  await page.locator("#lookup-results button").click();
  assert.equal(await page.locator("#latitude").inputValue(), "40.32");
  assert.equal(await page.locator("#name-el").inputValue(), "My historical Greek name");
  assert.equal(await page.locator("#name-en").inputValue(), "Elatohori");
  assert.equal(await page.locator("#preview").isVisible(), false);
  assert.equal(await page.locator("#info-en").inputValue(), "Do not alter these research notes.");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("name-en").value === "Elatohori");
  assert.equal(await page.locator("#latitude").inputValue(), "40.32");
  assert.equal(await page.locator("#name-el").inputValue(), "My historical Greek name");
  await page.locator("#name-el").fill("");
  await page.locator("#find-location").click();
  await page.locator("#lookup-results button").waitFor();
  assert.equal(await page.locator("#lookup-use-greek").isChecked(), true);
  await page.locator("#lookup-results button").click();
  assert.equal(await page.locator("#name-el").inputValue(), "Ελατοχώρι");
  await page.locator("#find-location").click();
  await page.locator("#lookup-more").click();
  await page.waitForFunction(() => document.getElementById("lookup-results").textContent.includes("<img"));
  assert.equal(calls.at(-1).includeWikipedia, true);
  assert.equal(await page.locator("#lookup-results img").count(), 0);
  assert.equal(await page.locator("#lookup-more").isVisible(), false);
  await page.setViewportSize({ width: 375, height: 800 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Typing another name aborts the request and prevents a late response being applied.
  await page.locator("#name-en").fill("Slow");
  await page.locator("#find-location").click();
  await page.waitForFunction(() => document.getElementById("location-lookup").getAttribute("aria-busy") === "true");
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  await page.locator("#name-en").fill("Changed while looking up");
  release(); release = null;
  await page.waitForFunction(() => document.getElementById("location-lookup").getAttribute("aria-busy") === "false");
  assert.equal(await page.locator("#lookup-results button").count(), 0);
  assert.equal(await page.locator("#name-en").inputValue(), "Changed while looking up");
  await page.locator("#name-en").fill("Failure");
  await page.locator("#find-location").click();
  await page.waitForFunction(() => document.getElementById("lookup-status").textContent.includes("unavailable"));
  assert.equal(await page.locator("#latitude").inputValue(), "40.32");
  assert.equal(await page.locator("#name-el").inputValue(), "Ελατοχώρι");
  assert.doesNotMatch(await page.locator("#lookup-status").textContent(), /provider internals/u);
  await page.locator("#name-en").fill("Missing");
  await page.locator("#find-location").click();
  await page.waitForFunction(() => document.getElementById("lookup-status").textContent.includes("No matching"));
  assert.equal(await page.locator("#latitude").inputValue(), "40.32");
  await page.locator("#name-en").fill("Elatohori");
  await page.locator("#find-location").click();
  await page.locator("#lookup-results button").waitFor();
  await page.locator("#region").selectOption("thessaly");
  assert.equal(await page.locator("#lookup-results button").count(), 0);
  await page.locator("#new-village").click();
  assert.equal(await page.locator("#lookup-status").textContent(), "");
  assert.equal(await page.locator("#name-en").inputValue(), "");
  serverBusy = true;
  await page.waitForFunction(() => document.getElementById("find-location").disabled);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], "Provider/map requests must not originate from the editor browser");
  console.log("Location browser checks passed: confirmation, Wikipedia expansion, safe text, mobile layout, draft persistence, preview invalidation, stale responses, errors, context reset and busy state.");
} finally {
  release?.();
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
