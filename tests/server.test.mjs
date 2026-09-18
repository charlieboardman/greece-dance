import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";

async function fixture(t, options = {}) {
  const editor = { status: async () => ({ busy: false, operation: null }), snapshot: async () => ({ revision: "a".repeat(40), records: [] }), preview: async (body) => ({ accepted: body }), submit: async () => ({ state: "completed" }) };
  const app = await createApp({ editor, passwordHash: await hashPassword("correct horse battery"),
    sessionSecret: "s".repeat(64), origin: "http://editor.test", ...options });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { request: (url, init) => fetch(base + url, init) };
}

test("public map content, map assets and byte ranges work; private files are not served", async (t) => {
  const { request } = await fixture(t, { editor: null });
  assert.equal((await request("/")).status, 200);
  assert.equal((await (await request("/api/content")).json()).regions.length > 0, true);
  const range = await request("/assets/basemaps/srtm-relief/greece-srtm-relief.pmtiles", { headers: { Range: "bytes=0-126" } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 127);
  for (const filename of ["/.env", "/.git/config", "/server/index.js", "/package.json", "/info/thessaly/region.json"]) assert.equal((await request(filename)).status, 404);
  assert.equal((await request("/api/editor/content")).status, 503);
});

test("editor requires login, same-origin JSON requests and a session CSRF token", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request("/api/editor/content")).status, 401);
  assert.equal((await request("/api/editor/status")).status, 401);
  const login = { method: "POST", headers: { Origin: "http://editor.test", "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse battery" }) };
  assert.equal((await request("/api/editor/login", { ...login, headers: { ...login.headers, Origin: "https://attacker.test" } })).status, 403);
  assert.equal((await request("/api/editor/login", { ...login, body: JSON.stringify({ password: "wrong" }) })).status, 401);
  const response = await request("/api/editor/login", login);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.match(response.headers.get("set-cookie"), /HttpOnly/u); assert.match(response.headers.get("set-cookie"), /SameSite=Strict/u);
  const { csrf } = await response.json();
  assert.equal((await request("/api/editor/content", { headers: { Cookie: cookie } })).status, 200);
  assert.deepEqual(await (await request("/api/editor/status", { headers: { Cookie: cookie } })).json(), { busy: false, operation: null });
  const mutation = { method: "POST", headers: { ...login.headers, Cookie: cookie }, body: "{}" };
  assert.equal((await request("/api/editor/preview", mutation)).status, 403);
  mutation.headers["X-CSRF-Token"] = csrf;
  assert.equal((await request("/api/editor/preview", mutation)).status, 200);
  assert.equal((await request("/api/editor/logout", mutation)).status, 200);
  assert.equal((await request("/api/editor/content", { headers: { Cookie: cookie } })).status, 401);
});

test("login attempts are rate limited", async (t) => {
  const { request } = await fixture(t, { loginLimit: 1 });
  const init = { method: "POST", headers: { Origin: "http://editor.test", "Content-Type": "application/json" }, body: '{"password":"wrong"}' };
  assert.equal((await request("/api/editor/login", init)).status, 401);
  assert.equal((await request("/api/editor/login", init)).status, 429);
});

test("location lookup is authenticated, CSRF-protected, validates context and never submits content", async t => {
  const records = [
    { type: "region", path: "regions/pieria", metadata: { names: { en: "Pieria" } } },
    { type: "subregion", path: "subregions/elsewhere", metadata: { region: "other" } }
  ];
  let calls = 0;
  const { request } = await fixture(t, {
    editor: { snapshot: async () => ({ records }), submit: () => assert.fail("Lookup must not save") },
    locationLookup: async (input, passedRecords) => {
      calls++; assert.equal(input.query, "Elatohori"); assert.equal(input.region, "pieria");
      assert.deepEqual(passedRecords, records);
      return { candidates: [], wikipediaSearched: true, warnings: [] };
    }
  });
  const headers = { Origin: "http://editor.test", "Content-Type": "application/json" };
  const body = JSON.stringify({ query: "Elatohori", region: "pieria" });
  assert.equal((await request("/api/editor/find-location", { method: "POST", headers, body })).status, 401);
  const login = await request("/api/editor/login", { method: "POST", headers, body: JSON.stringify({ password: "correct horse battery" }) });
  headers.Cookie = login.headers.get("set-cookie").split(";")[0];
  const { csrf } = await login.json();
  assert.equal((await request("/api/editor/find-location", { method: "POST", headers, body })).status, 403);
  headers["X-CSRF-Token"] = csrf;
  for (const input of [{}, { query: "Elatohori", region: "missing" }, { query: "Elatohori", region: "pieria", subregion: "elsewhere" },
    { query: "a".repeat(201), region: "pieria" }, { query: "Elatohori", region: "pieria", includeWikipedia: "yes" }]) {
    assert.equal((await request("/api/editor/find-location", { method: "POST", headers, body: JSON.stringify(input) })).status, 400);
  }
  assert.equal(calls, 0);
  const response = await request("/api/editor/find-location", { method: "POST", headers, body });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { candidates: [], wikipediaSearched: true, warnings: [] });
  assert.equal(calls, 1);
  assert.equal((await request("/editor/location-lookup.js")).status, 200);
  assert.equal((await request("/server/location-lookup.js")).status, 404);
});


test("public files work inside hidden deployment staging directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), ".staging-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["info", "index.html", "app.js", "styles.css", "region-presentation.js", "map-styles.js"]) {
    await cp(new URL(`../${name}`, import.meta.url), path.join(root, name), { recursive: true });
  }
  const { request } = await fixture(t, { editor: null, root });
  for (const url of ["/", "/index.html", "/app.js", "/styles.css", "/region-presentation.js", "/map-styles.js"]) {
    assert.equal((await request(url)).status, 200, url);
  }
  for (const url of ["/.env", "/.git/config", "/server/auth.js"]) {
    assert.equal((await request(url)).status, 404, url);
  }
});
