// Optional editor assistance only: never used for validation, saving or publishing.
// All provider requests stay here, not in the browser or the content repository.
const USER_AGENT = "NationalDanceMinistryMap/0.1 (https://github.com/charlieboardman/greece-dance)";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const WIKIPEDIA = lang => `https://${lang}.wikipedia.org/w/api.php`;
const EARTH = "http://www.wikidata.org/entity/Q2";
const SETTLEMENT_TYPES = new Set(["Q486972", "Q515", "Q532", "Q3957"]);
const PLACE_TYPES = new Set([...SETTLEMENT_TYPES, "Q23442", "Q56061", "Q8502", "Q39816", "Q4421"]);
const WIKI_PLACE = /^(?:village|town|city|community|human settlement|settlement|suburb|municipal(?:ity| unit)|island|region|valley|mountain|forest|place in|οικισμός|χωριό|πόλη|κοινότητα|δήμος|νησί|περιοχή|κωμόπολη)(?=\s|$)/iu;

// Generous search windows, NOT administrative borders. Historical research areas
// deliberately extend beyond modern Greece. Unknown/new regions use the whole area.
const RESEARCH_AREA = [34, 19, 44.5, 45]; // south, west, north, east
const AREAS = {
  "anatoliki-romelia": [41, 23, 44, 29], "asia-minor": [35, 25, 43, 45],
  cappadokia: [37, 32, 40.5, 37.5], pontos: [39, 33, 43, 44], cyprus: [34, 32, 36, 35.5],
  "macedonia-northern": [39.8, 20.5, 41.8, 23.5], "macedonia-central": [39.8, 21, 41.8, 24],
  "macedonia-eastern": [40.3, 22.7, 42, 25], "macedonia-western": [39.5, 20.3, 41.5, 22.5],
  pieria: [39.7, 21.7, 40.8, 23], thessaloniki: [40, 22, 41.3, 24], thrace: [40, 24, 42.3, 27.5],
  thessaly: [38.6, 20.8, 40.4, 23.7], epirus: [38.7, 19.5, 40.7, 21.8],
  attiki: [37.3, 22.6, 38.8, 24.5], peloponnisos: [36, 20.4, 38.7, 23.8],
  crete: [34.6, 23.2, 36, 26.6], "ionian-islands": [37.5, 19, 40.2, 21.5],
  "cyclades-islands": [36, 23.5, 38.5, 27], "aegean-islands": [35, 23, 41.3, 28.5],
  "dodecanese-islands": [35, 26, 37.8, 30], evia: [37.8, 22.7, 39.3, 24.8], sporades: [38.5, 23, 40, 25],
};
const COUNTRY_IDS = { GR: "Q41", TR: "Q43", BG: "Q219", CY: "Q229" };
function allowedCountries(region) {
  if (region === "anatoliki-romelia") return ["BG"];
  if (["asia-minor", "cappadokia", "pontos"].includes(region)) return ["TR"];
  if (region === "cyprus") return ["CY"];
  return AREAS[region] ? ["GR"] : [];
}
function countryFits(entity, region, country) {
  const allowed = allowedCountries(region);
  if (!allowed.length) return true;
  const countries = claims(entity, "P17").map(c => c.id);
  if (countries.length) return allowed.some(code => countries.includes(COUNTRY_IDS[code]));
  return !country || allowed.includes(country);
}

export function inSearchArea(point, region) {
  if (!Number.isFinite(point?.latitude) || !Number.isFinite(point?.longitude)) return false;
  const [south, west, north, east] = AREAS[region] || RESEARCH_AREA;
  return point.latitude >= south && point.latitude <= north && point.longitude >= west && point.longitude <= east;
}

const cleanQuery = text => text.normalize("NFKC").replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/gu, " ").trim();
const fold = text => text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] !== b[j])));
    row = next;
  }
  return row[b.length];
}
export function nameScore(query, names) {
  const q = fold(query);
  if (!q) return 0;
  return Math.max(0, ...names.filter(n => typeof n === "string").map(name => {
    const n = fold(name);
    if (q === n) return 1;
    // Allow a geographic qualifier after a name, not an arbitrary mention in prose.
    const prefix = n.split(" ").slice(0, q.split(" ").length).join(" ");
    if (q === prefix) return .95;
    const d = Math.min(editDistance(q, n), editDistance(q, prefix));
    return d <= Math.min(3, Math.floor(q.length / 4)) ? 1 - d / Math.max(q.length, 1) : 0;
  }));
}
function leadAliasScore(query, title, snippet = "") {
  // Wikipedia search can match a historical name in an article's opening
  // parenthesis, e.g. "Topolovgrad (... Greek: Καβακλί Kavakli)". Do not accept
  // arbitrary mentions elsewhere in an article about a different place.
  const plain = snippet.replace(/<[^>]*>/gu, "");
  if (!plain.startsWith(title)) return 0;
  const names = plain.slice(title.length).match(/^\s*\((.{0,400}?)\)/u)?.[1];
  return names && ` ${fold(names)} `.includes(` ${fold(query)} `) ? .9 : 0;
}
function claims(entity, property) {
  const statements = (entity?.claims?.[property] || []).filter(c => c.rank !== "deprecated" && c.mainsnak?.snaktype !== "novalue" && c.mainsnak?.datavalue);
  const preferred = statements.filter(c => c.rank === "preferred");
  return (preferred.length ? preferred : statements).map(c => c.mainsnak.datavalue.value);
}
function points(entity) {
  return claims(entity, "P625").filter(p => p.globe === EARTH && Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}
function distance(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((a.latitude - b.latitude) * r / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin((a.longitude - b.longitude) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export class LocationLookupError extends Error {}

export function createLocationLookup({ fetch: request = globalThis.fetch, now = Date.now, timeoutMs = 25000, requestTimeoutMs = 5000, maxRequests = 28 } = {}) {
  const cache = new Map();
  const cooldowns = new Map();
  let active = 0;

  return async function lookup({ query, region, subregion, includeWikipedia = false }, records = []) {
    const name = cleanQuery(query);
    if (!name || name.length > 200 || name.split(" ").length > 12) throw new LocationLookupError("Enter a place name of up to 200 characters.");
    if (active >= 2) throw new LocationLookupError("Location search is busy. Try again shortly, or enter the location manually.");
    active++;
    const signal = AbortSignal.timeout(timeoutMs);
    let calls = 0;
    const entities = new Map();
    const warnings = new Set();
    const candidates = [];
    let wikipediaSearched = false;
    async function api(endpoint, params) {
      signal.throwIfAborted();
      const url = new URL(endpoint);
      url.search = new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
      const cached = cache.get(url.href);
      if (cached && cached.expires > now()) return cached.data;
      if ((cooldowns.get(url.host) || 0) > now()) throw new Error("Provider is cooling down");
      if (++calls > maxRequests) throw new Error("Lookup request budget reached");
      const response = await request(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
      });
      if (!response.ok) {
        if (response.status === 429 || response.status === 503) {
          const retry = response.headers?.get("retry-after");
          const wait = /^\d+$/u.test(retry || "") ? Number(retry) * 1000 : Date.parse(retry) - now();
          cooldowns.set(url.host, now() + Math.max(60000, Number.isFinite(wait) ? wait : 0));
        }
        throw new Error("Provider unavailable");
      }
      const data = await response.json();
      if (data.error) {
        if (data.error.code === "maxlag" || data.error.code === "ratelimited") cooldowns.set(url.host, now() + 60000);
        throw new Error("Provider error");
      }
      // Bounded, short-lived cache. Failed responses are never cached.
      cache.delete(url.href);
      cache.set(url.href, { expires: now() + 10 * 60000, data });
      while (cache.size > 128) cache.delete(cache.keys().next().value);
      return data;
    }
    async function stage(provider, task) {
      try { await task(); } catch { warnings.add(`${provider} search was incomplete. You can retry or enter the location manually.`); }
    }
    async function getEntities(ids) {
      const missing = [...new Set(ids)].filter(id => /^Q\d+$/u.test(id) && !entities.has(id));
      for (let i = 0; i < Math.min(missing.length, 80); i += 40) {
        const data = await api(WIKIDATA, { action: "wbgetentities", ids: missing.slice(i, i + 40).join("|"), props: "labels|aliases|descriptions|claims", languages: "en|el" });
        for (const [id, entity] of Object.entries(data.entities || {})) entities.set(id, entity);
      }
    }
    async function placeTypes(items) {
      let ids = items.flatMap(e => claims(e, "P31").map(c => c.id));
      // A bounded subclass walk handles country-specific village/municipality types.
      for (let depth = 0; depth < 3; depth++) {
        ids = [...new Set(ids)].filter(id => id && !PLACE_TYPES.has(id)).slice(0, 40);
        if (!ids.length) break;
        await getEntities(ids);
        ids = ids.flatMap(id => claims(entities.get(id), "P279").map(c => c.id));
      }
    }
    function isPlace(entity, types = PLACE_TYPES) {
      const visit = (id, seen = new Set()) => {
        if (types.has(id)) return true;
        if (!id || seen.has(id) || seen.size > 80) return false;
        seen.add(id);
        return claims(entities.get(id), "P279").some(c => visit(c.id, seen));
      };
      return claims(entity, "P31").some(c => visit(c.id));
    }
    function entityNames(e) {
      return [e?.labels?.en?.value, e?.labels?.el?.value, ...(e?.aliases?.en || []).map(a => a.value)];
    }
    async function addEntities(ids, matches = new Map()) {
      await getEntities(ids);
      const items = ids.map(id => entities.get(id)).filter(e => e && countryFits(e, region) && points(e).some(p => inSearchArea(p, region)));
      await stage("Wikidata", () => placeTypes(items));
      const contextIds = items.flatMap(e => [...claims(e, "P17"), ...claims(e, "P131")].map(c => c.id)).filter(Boolean);
      await stage("Wikidata", () => getEntities(contextIds));
      for (const e of items) {
        const score = nameScore(name, [...entityNames(e), matches.get(e.id)]);
        if (!isPlace(e) || !score) continue;
        if (new Set(points(e).map(p => `${p.latitude},${p.longitude}`)).size > 1) {
          warnings.add("A Wikidata place had conflicting coordinates and was skipped. Check Wikipedia or enter its location manually.");
          continue;
        }
        const context = [...claims(e, "P17"), ...claims(e, "P131")].map(c => entities.get(c.id)?.labels?.en?.value).filter(Boolean);
        for (const point of points(e).filter(p => inSearchArea(p, region))) candidates.push({
          id: `${e.id}:${point.latitude}:${point.longitude}`, entityId: e.id,
          name: e.labels?.en?.value || matches.get(e.id) || e.labels?.el?.value || name,
          greek: e.labels?.el?.value || "", description: [e.descriptions?.en?.value, ...new Set(context)].filter(Boolean).join(" · "),
          latitude: point.latitude, longitude: point.longitude, score, settlement: isPlace(e, SETTLEMENT_TYPES),
          source: "Wikidata", url: `https://www.wikidata.org/wiki/${e.id}`
        });
      }
    }
    async function wikidata() {
      const data = await api(WIKIDATA, { action: "wbsearchentities", search: name, language: "en", uselang: "en", type: "item", limit: "10" });
      const hits = data.search || [];
      await addEntities(hits.map(h => h.id), new Map(hits.map(h => [h.id, h.match?.text || h.label])));
      // Irrelevant unfiltered hits must not suppress broader search.
      if (!candidates.length || includeWikipedia) {
        for (const query of [name, name.split(" ").map(w => `${w}~2`).join(" ")]) {
          const result = await api(WIKIDATA, { action: "query", list: "search", srsearch: `${query} haswbstatement:P625`, srnamespace: "0", srlimit: "10" });
          await addEntities((result.query?.search || []).map(h => h.title));
        }
      }
    }
    const wikiProps = { prop: "coordinates|langlinks|pageprops|description", ppprop: "wikibase_item|disambiguation", coprimary: "primary", coprop: "globe|type|country", colimit: "max", lllang: "el", lllimit: "max" };
    async function wikiPages(lang, titles) {
      const pages = [];
      for (let i = 0; i < Math.min(titles.length, 80); i += 40) {
        const data = await api(WIKIPEDIA(lang), { action: "query", titles: titles.slice(i, i + 40).join("|"), redirects: "1", ...wikiProps });
        pages.push(...(data.query?.pages || []).filter(p => !p.missing).map(p => ({ ...p })));
        if (data.continue) warnings.add("Some Wikipedia results were omitted. Try a more specific place name.");
      }
      return pages;
    }
    async function addPages(pages, lang, linkedFromDisambiguation = false) {
      const located = pages.filter(p => p.pageprops?.disambiguation === undefined && p.coordinates?.some(c => c.primary && (!c.globe || c.globe === "earth") && inSearchArea({ latitude: c.lat, longitude: c.lon }, region)));
      // IDs are an exact cross-reference, never a join on a similar place name.
      await stage("Wikidata", async () => {
        await getEntities(located.map(p => p.pageprops?.wikibase_item).filter(Boolean));
        await placeTypes(located.map(p => entities.get(p.pageprops?.wikibase_item)).filter(Boolean));
      });
      for (const p of located) {
        const entity = entities.get(p.pageprops?.wikibase_item);
        if (!countryFits(entity, region, p.coordinates[0]?.country) || !(entity ? isPlace(entity) : WIKI_PLACE.test(p.description || ""))) continue;
        const score = nameScore(name, [p.title, p.redirectTitle, ...entityNames(entity)]) || leadAliasScore(name, p.title, p.snippet) || (linkedFromDisambiguation ? .7 : 0);
        if (!score) continue;
        const point = p.coordinates.find(c => c.primary && (!c.globe || c.globe === "earth") && inSearchArea({ latitude: c.lat, longitude: c.lon }, region));
        candidates.push({ id: `${lang}:${p.pageid}`, entityId: p.pageprops?.wikibase_item || null,
          name: lang === "en" ? p.title : entity?.labels?.en?.value || p.title,
          greek: lang === "el" ? p.title : p.langlinks?.find(l => l.lang === "el")?.title || "",
          description: p.description || "Geographic place", latitude: point.lat, longitude: point.lon, score,
          settlement: entity ? isPlace(entity, SETTLEMENT_TYPES) : /^(village|town|city|community|human settlement|settlement|suburb|οικισμός|χωριό|πόλη)(?=\s|$)/iu.test(p.description || ""),
          source: lang === "el" ? "Greek Wikipedia" : "Wikipedia", url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replaceAll(" ", "_"))}`
        });
      }
    }
    async function wikipedia() {
      wikipediaSearched = true;
      const disambiguation = new Map();
      for (const query of [name, name.split(" ").map(w => `${w}~2`).join(" ")]) {
        const data = await api(WIKIPEDIA("en"), { action: "query", list: "search", srsearch: query, srnamespace: "0", srlimit: "10", srprop: "snippet|redirecttitle" });
        const titles = (data.query?.search || []).map(p => p.title);
        if (!titles.length) continue;
        const pages = await wikiPages("en", titles);
        for (const page of pages) {
          const hit = data.query.search.find(h => h.title === page.title);
          page.snippet = hit?.snippet; page.redirectTitle = hit?.redirecttitle;
        }
        await addPages(pages, "en");
        for (const p of pages.filter(p => p.pageprops?.disambiguation !== undefined && nameScore(name, [p.title]))) disambiguation.set(p.pageid, p);
      }
      // Two disambiguation pages, one level deep, at most 80 linked titles each.
      for (const page of [...disambiguation.values()].slice(0, 2)) {
        for (const [lang, title] of [["en", page.title], ["el", page.langlinks?.find(l => l.lang === "el")?.title]]) {
          if (!title) continue;
          const data = await api(WIKIPEDIA(lang), { action: "query", titles: title, prop: "links", plnamespace: "0", pllimit: "80" });
          const titles = (data.query?.pages?.[0]?.links || []).map(l => l.title);
          if (data.continue) warnings.add("Some Wikipedia matches were omitted. Try a more specific place name.");
          if (titles.length) await addPages(await wikiPages(lang, titles), lang, true);
        }
      }
    }
    try {
      await stage("Wikidata", wikidata);
      if (!candidates.length || includeWikipedia) await stage("Wikipedia", wikipedia);
      const regionPoints = records.filter(r => r.type === "village" && r.metadata.region === region && (!subregion || r.metadata.subregion === subregion)).map(r => r.metadata);
      const allRegionPoints = regionPoints.length ? regionPoints : records.filter(r => r.type === "village" && r.metadata.region === region).map(r => r.metadata);
      const unique = new Map();
      for (const c of candidates) {
        const key = c.entityId || c.id;
        const existing = unique.get(key);
        // Keep each provider's coordinates intact; no name-based cross-provider merge.
        if (!existing || (!existing.greek && c.greek)) unique.set(key, c);
      }
      const rank = c => c.score * 100 + (c.settlement ? 10 : 0) - (allRegionPoints.length ? Math.min(500, ...allRegionPoints.map(p => distance(c, p))) / 10 : 0);
      const ranked = [...unique.values()].sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name, "en"));
      return { candidates: ranked.slice(0, 8).map(({ score, settlement, entityId, ...c }) => c), wikipediaSearched,
        warnings: [...warnings], limited: ranked.length > 8 };
    } finally { active--; }
  };
}
