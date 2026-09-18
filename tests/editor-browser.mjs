// Optional real-browser check: PLAYWRIGHT_MODULE may point at an installed
// Playwright entry point. Everything uses temporary local remotes and HTTP.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { createApp } from "../server/app.js";
import { GitEditor, runGit } from "../server/git.js";
import { PublishedContent } from "../server/publisher.js";
import { hashPassword } from "../server/password.js";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = await mkdtemp(path.join(os.tmpdir(), "dance-editor-browser-"));
let server, browser, unblock;
try {
  const remote = path.join(root, "remote.git"), clone = path.join(root, "client");
  await runGit(["init", "--bare", "--initial-branch=main", remote]);
  await runGit(["clone", remote, clone]);
  const git = (...args) => runGit(args, { cwd: clone });
  await git("config", "user.name", "Browser fixture"); await git("config", "user.email", "test@example.test");
  await mkdir(path.join(clone, "info/regions/region"), { recursive: true });
  await writeFile(path.join(clone, "info/regions/region/region.json"), JSON.stringify({ names: { en: "Region", el: "Περιοχή" }, color: "#336699" }));
  await git("add", "."); await git("commit", "-m", "Fixture"); await git("push", "origin", "main");
  const publisher = new PublishedContent(path.join(root, "published"));
  const editor = new GitEditor({ remote, directory: path.join(root, "state/repository.git"), publisher });
  await editor.publish();
  // Reserve a local port so Origin can be configured before constructing Express.
  const { createServer } = await import("node:net");
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const app = await createApp({ editor, published: publisher, origin, passwordHash: await hashPassword("test-password"), sessionSecret: "s".repeat(64) });
  server = app.listen(port, "127.0.0.1"); await once(server, "listening");
  browser = await chromium.launch({ headless: true });
  const pages = await Promise.all([browser.newPage(), browser.newPage()]);
  const errors = [];
  for (const page of pages) {
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => dialog.accept());
    await page.goto(`${origin}/editor/`);
    await page.locator('[name="password"]').fill("test-password");
    await page.locator('#login button').click();
    await page.waitForFunction(() => !document.getElementById("new-region").disabled);
    await page.locator("#records").selectOption("regions/region");
  }
  for (const [i, page] of pages.entries()) {
    await page.locator("#name-en").fill(i ? "Second draft" : "First edit");
    await page.locator('#edit button[type="submit"]').click();
    await page.waitForFunction(() => !document.getElementById("submit").disabled && !document.getElementById("preview").hidden);
  }
  const publish = publisher.publish.bind(publisher);
  let entered;
  const publishing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  publisher.publish = async (...args) => { entered(); await gate; return publish(...args); };
  await pages[0].locator("#submit").click();
  await publishing;
  await pages[0].reload();
  await pages[0].waitForFunction(() => !document.getElementById("processing").hidden);
  await pages[1].waitForFunction(() => document.getElementById("submit").disabled);
  assert.equal(await pages[1].locator("#name-en").inputValue(), "Second draft");
  unblock();
  await pages[0].waitForFunction(() => document.getElementById("status").textContent.includes("Saved and live"));
  await pages[1].waitForFunction(() => !document.getElementById("submit").disabled);
  assert.equal(await pages[0].locator("#name-en").inputValue(), "First edit");
  await pages[1].locator("#submit").click();
  await pages[1].waitForFunction(() => document.getElementById("status").textContent.includes("changed since you opened"));
  assert.equal(await pages[1].locator("#name-en").inputValue(), "Second draft");
  await pages[1].reload();
  await pages[1].waitForFunction(() => document.getElementById("name-en").value === "Second draft");
  assert.equal((await (await fetch(`${origin}/api/content`)).json()).regions[0].name, "First edit");
  assert.deepEqual(errors, []);
  console.log("Browser check passed: two visitors, busy spinner, reload during save, restored draft/revision, conflict preservation, and live content without restart.");
} finally {
  unblock?.();
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
