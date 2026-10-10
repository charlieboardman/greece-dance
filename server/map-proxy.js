import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const WEEK = 7 * 24 * 60 * 60;
const DEFAULT_TILES = "https://vector.openstreetmap.org/shortbread_v1";
const DEFAULT_GLYPHS = "https://vector.openstreetmap.org/styles/shortbread/fonts";
const USER_AGENT = "NationalDanceMinistryMap/1.0 (+https://github.com/charlieboardman/greece-dance/issues)";

function expiry(headers, now) {
  const cc = headers.get("cache-control") || "";
  if (/\b(?:no-store|private)\b/iu.test(cc)) return null;
  if (/\bno-cache\b/iu.test(cc)) return now;
  const maxAge = cc.match(/(?:^|,)\s*(?:s-maxage)="?(\d+)/iu) || cc.match(/(?:^|,)\s*max-age="?(\d+)/iu);
  const age = Math.max(0, Number(headers.get("age")) || 0);
  if (maxAge) return now + Math.max(0, Number(maxAge[1]) - age) * 1000;
  const expires = Date.parse(headers.get("expires"));
  const date = Date.parse(headers.get("date"));
  if (Number.isFinite(expires)) return now + Math.max(0, expires - (Number.isFinite(date) ? date : now) - age * 1000);
  return now + WEEK * 1000;
}

async function limitedBody(response, limit) {
  const chunks = [];
  let length = 0;
  if (!response.body) throw new Error("Missing map response");
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("Map response too large");
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export function createMapProxy({
  directory = process.env.MAP_CACHE_DIR || path.resolve(".state/tile-cache"),
  maxBytes = Number(process.env.MAP_CACHE_BYTES || 1024 ** 3),
  tileBase = process.env.OSM_TILE_BASE || DEFAULT_TILES,
  glyphBase = process.env.OSM_GLYPH_BASE || DEFAULT_GLYPHS,
  origin = "http://localhost:8000", request = globalThis.fetch, now = Date.now,
  maxConcurrent = 4, maxPending = 64, maxResponseBytes = 8 * 1024 * 1024, timeoutMs = 15000
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid map cache size");
  for (const base of [tileBase, glyphBase]) {
    const u = new URL(base);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new Error("Map upstream must be an HTTPS base URL without credentials or query");
  }
  const namespace = createHash("sha256").update(tileBase + "\n" + glyphBase).digest("hex");
  const referer = new URL("/", origin).href;
  const pending = new Map();
  const waiting = [];
  let database, active = 0, cooldownUntil = 0, cacheFullUntil = 0;
  function db() {
    if (!database) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      database = new DatabaseSync(path.join(directory, "tiles.sqlite"));
      database.exec(`PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=NORMAL; PRAGMA auto_vacuum=INCREMENTAL;
        PRAGMA max_page_count=${Math.max(256, Math.ceil(maxBytes * 1.15 / 4096))};
        CREATE TABLE IF NOT EXISTS tiles (key TEXT PRIMARY KEY, body BLOB NOT NULL, expires REAL NOT NULL, etag TEXT, modified TEXT, lifetime REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS tiles_expiry ON tiles(expires);
        CREATE TABLE IF NOT EXISTS cache_size (id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL);
        INSERT OR IGNORE INTO cache_size SELECT 1, coalesce(sum(length(body)),0) FROM tiles;
        CREATE TRIGGER IF NOT EXISTS cache_insert AFTER INSERT ON tiles BEGIN UPDATE cache_size SET bytes=bytes+length(new.body) WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS cache_delete AFTER DELETE ON tiles BEGIN UPDATE cache_size SET bytes=bytes-length(old.body) WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS cache_update AFTER UPDATE OF body ON tiles BEGIN UPDATE cache_size SET bytes=bytes+length(new.body)-length(old.body) WHERE id=1; END;`);
    }
    return database;
  }
  function store(key, entry) {
    const d = db();
    d.exec("BEGIN IMMEDIATE");
    try {
      const current = d.prepare("SELECT length(body) AS bytes FROM tiles WHERE key=?").get(key)?.bytes || 0;
      let total = d.prepare("SELECT bytes FROM cache_size WHERE id=1").get().bytes;
      if (total - current + entry.body.length > maxBytes) {
        // Retain fresh entries for their advertised cache lifetime. Do not churn
        // OSM downloads by evicting unexpired tiles when the disk budget fills.
        // Reclaim only enough expired data for this response, keeping the
        // rollback journal small instead of deleting the entire cache at once.
        while (total - current + entry.body.length > maxBytes) {
          const expired = d.prepare("SELECT key,length(body) AS bytes FROM tiles WHERE expires<=? AND key<>? ORDER BY length(body) DESC LIMIT 256").all(now(), key);
          if (!expired.length) break;
          for (const row of expired) {
            d.prepare("DELETE FROM tiles WHERE key=?").run(row.key);
            total -= row.bytes;
            if (total - current + entry.body.length <= maxBytes) break;
          }
        }
      }
      if (total - current + entry.body.length > maxBytes) {
        cacheFullUntil = d.prepare("SELECT min(expires) AS expires FROM tiles WHERE expires>?").get(now()).expires || now() + 30000;
        throw Object.assign(new Error("Map cache is full"), { status: 503 });
      }
      d.prepare("INSERT INTO tiles VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,expires=excluded.expires,etag=excluded.etag,modified=excluded.modified,lifetime=excluded.lifetime").run(key, entry.body, entry.expires, entry.etag, entry.modified, entry.lifetime);
      d.exec("COMMIT");
      d.exec("PRAGMA incremental_vacuum(128)");
    } catch (error) { try { d.exec("ROLLBACK"); } catch {} throw error; }
  }
  async function load(relative, base) {
    const url = `${base}/${relative}`;
    const key = namespace + ":" + url;
    if (pending.has(key)) return pending.get(key);
    const cached = db().prepare("SELECT body,expires,etag,modified,lifetime FROM tiles WHERE key=?").get(key);
    if (cached && cached.expires > now()) return cached;
    if (pending.size >= maxPending || cooldownUntil > now() || cacheFullUntil > now()) throw Object.assign(new Error("Map upstream busy"), { status: 503 });
    const task = (async () => {
      if (active >= maxConcurrent) await new Promise(resolve => waiting.push(resolve));
      else active++;
      if (cooldownUntil > now()) throw Object.assign(new Error("Map upstream busy"), { status: 503 });
      // Deliberately construct headers: no browser IP, cookies, search, Origin,
      // Referer path, or incoming request headers are forwarded upstream.
      const headers = { "User-Agent": USER_AGENT, Referer: referer, Accept: "application/x-protobuf, application/vnd.mapbox-vector-tile, application/octet-stream", "Accept-Encoding": "identity" };
      if (cached?.etag) headers["If-None-Match"] = cached.etag;
      if (cached?.modified) headers["If-Modified-Since"] = cached.modified;
      const response = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get("retry-after");
        const seconds = /^\d+$/u.test(retry || "") ? Number(retry) : (Date.parse(retry) - now()) / 1000;
        cooldownUntil = now() + Math.max(30, Math.min(3600, Number.isFinite(seconds) ? seconds : 30)) * 1000;
      }
      if (response.status !== 200 && !(response.status === 304 && cached)) {
        await response.body?.cancel();
        throw Object.assign(new Error("Map upstream unavailable"), { status: response.status === 404 ? 404 : 502 });
      }
      const expires = response.status === 304 && !response.headers.has("cache-control") && !response.headers.has("expires")
        ? now() + cached.lifetime : expiry(response.headers, now());
      let body;
      if (response.status === 304) { body = cached.body; await response.body?.cancel(); }
      else {
        if (!/^(?:application\/(?:x-protobuf|vnd\.mapbox-vector-tile|octet-stream|protobuf))(?:;|$)/iu.test(response.headers.get("content-type") || "")) {
          await response.body?.cancel(); throw new Error("Unexpected map content type");
        }
        body = await limitedBody(response, maxResponseBytes);
      }
      const entry = { body, expires, lifetime: expires === null ? 0 : Math.max(0, expires - now()), etag: response.headers.get("etag") || (response.status === 304 ? cached.etag : null),
        modified: response.headers.get("last-modified") || (response.status === 304 ? cached.modified : null) };
      if (expires !== null) store(key, entry);
      else db().prepare("DELETE FROM tiles WHERE key=?").run(key);
      return entry;
    })();
    pending.set(key, task);
    try { return await task; }
    finally { pending.delete(key); const next = waiting.shift(); if (next) next(); else active--; }
  }
  async function serve(req, res) {
    let relative, base;
    const tile = req.path.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.mvt$/u);
    const glyph = req.path.match(/^\/glyphs\/noto_sans_regular\/(\d+)-(\d+)\.pbf$/u);
    if (tile) {
      const [z, x, y] = tile.slice(1).map(Number), n = 2 ** z;
      if (z > 14 || x >= n || y >= n || ![z,x,y].every(Number.isSafeInteger)) return res.sendStatus(404);
      // Permit only tiles intersecting the atlas's existing 0–60° coverage.
      const west = x / n * 360 - 180, east = (x + 1) / n * 360 - 180;
      const lat = v => Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))) * 180 / Math.PI;
      if (east <= 0 || west >= 60 || lat(y) <= 0 || lat(y + 1) >= 60) return res.sendStatus(404);
      relative = `${z}/${x}/${y}.mvt`; base = tileBase;
    } else if (glyph) {
      const [start, end] = glyph.slice(1).map(Number);
      if (start % 256 || end !== start + 255 || start < 0 || end > 65535) return res.sendStatus(404);
      relative = `noto_sans_regular/${start}-${end}.pbf`; base = glyphBase;
    } else return res.sendStatus(404);
    try {
      const entry = await load(relative, base);
      const seconds = entry.expires === null ? null : Math.max(0, Math.floor((entry.expires - now()) / 1000));
      res.set("Cache-Control", seconds === null ? "no-store" : `public, max-age=${seconds}`);
      res.type("application/x-protobuf").send(Buffer.from(entry.body));
    } catch (error) {
      res.set("Cache-Control", "no-store");
      if (error.status === 503) res.set("Retry-After", "30");
      res.status(error.status || 502).json({ error: "Map data is temporarily unavailable." });
    }
  }
  return { serve, close() { database?.close(); database = null; } };
}
