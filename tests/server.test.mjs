import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server/app.js";
import { hashPassword } from "../server/auth.js";

async function fixture(t, options = {}) {
  const editor = { snapshot: async () => ({ revision: "a".repeat(40), records: [] }), preview: async (body) => ({ accepted: body }), submit: async () => ({ number: 1 }) };
  const app = await createApp({ editor, passwordHash: await hashPassword("correct horse battery"),
    sessionSecret: "s".repeat(64), origin: "http://editor.test", ...options });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { request: (url, init) => fetch(base + url, init) };
}

test("public archive, map assets and byte ranges work; private files are not served", async (t) => {
  const { request } = await fixture(t, { editor: null });
  assert.equal((await request("/")).status, 200);
  assert.equal((await (await request("/api/archive")).json()).regions.length > 0, true);
  const range = await request("/assets/basemaps/srtm-relief/greece-srtm-relief.pmtiles", { headers: { Range: "bytes=0-126" } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 127);
  for (const filename of ["/.env", "/.git/config", "/server/index.js", "/package.json", "/info/thessaly/region.json"]) assert.equal((await request(filename)).status, 404);
  assert.equal((await request("/api/editor/archive")).status, 503);
});

test("editor requires login, same-origin JSON requests and a session CSRF token", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request("/api/editor/archive")).status, 401);
  const login = { method: "POST", headers: { Origin: "http://editor.test", "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse battery" }) };
  assert.equal((await request("/api/editor/login", { ...login, headers: { ...login.headers, Origin: "https://attacker.test" } })).status, 403);
  assert.equal((await request("/api/editor/login", { ...login, body: JSON.stringify({ password: "wrong" }) })).status, 401);
  const response = await request("/api/editor/login", login);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.match(response.headers.get("set-cookie"), /HttpOnly/u); assert.match(response.headers.get("set-cookie"), /SameSite=Strict/u);
  const { csrf } = await response.json();
  assert.equal((await request("/api/editor/archive", { headers: { Cookie: cookie } })).status, 200);
  const mutation = { method: "POST", headers: { ...login.headers, Cookie: cookie }, body: "{}" };
  assert.equal((await request("/api/editor/preview", mutation)).status, 403);
  mutation.headers["X-CSRF-Token"] = csrf;
  assert.equal((await request("/api/editor/preview", mutation)).status, 200);
  assert.equal((await request("/api/editor/logout", mutation)).status, 200);
  assert.equal((await request("/api/editor/archive", { headers: { Cookie: cookie } })).status, 401);
});

test("login attempts are rate limited", async (t) => {
  const { request } = await fixture(t, { loginLimit: 1 });
  const init = { method: "POST", headers: { Origin: "http://editor.test", "Content-Type": "application/json" }, body: '{"password":"wrong"}' };
  assert.equal((await request("/api/editor/login", init)).status, 401);
  assert.equal((await request("/api/editor/login", init)).status, 429);
});
