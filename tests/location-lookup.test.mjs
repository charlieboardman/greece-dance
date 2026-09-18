import test from "node:test";
import assert from "node:assert/strict";
import { createLocationLookup, inSearchArea, nameScore, LocationLookupError } from "../server/location-lookup.js";

const statement = (value, rank = "normal") => ({ rank, mainsnak: { snaktype: "value", datavalue: { value } } });
const point = (latitude = 40.32, longitude = 22.265, globe = "http://www.wikidata.org/entity/Q2") => ({ latitude, longitude, globe });
function place(id, name, options = {}) {
  return { id, labels: { en: { value: name }, el: { value: options.greek || "Ελατοχώρι" } },
    aliases: { en: (options.aliases || []).map(value => ({ value })) }, descriptions: { en: { value: "village in Greece" } },
    claims: { P31: [statement({ id: options.type || "Q532" })], P17: [statement({ id: options.country || "Q41" })],
      P625: (options.points || [point()]).map(p => statement(p)), ...options.claims } };
}
function harness({ search = [], fuzzy = [], entities = {}, pages = {}, wikiSearch = [], links = {}, fail = () => false } = {}) {
  const calls = [];
  const fetch = async (url, options) => {
    url = new URL(url); calls.push({ url, options });
    assert(["www.wikidata.org", "en.wikipedia.org", "el.wikipedia.org"].includes(url.host), "Only Wikimedia providers are allowed");
    assert.equal(options.redirect, "error");
    assert(options.signal instanceof AbortSignal);
    assert.match(options.headers["User-Agent"], /NationalDanceMinistryMap/u);
    const p = Object.fromEntries(url.searchParams);
    const failure = fail(url, p);
    if (failure) return { ok: false, status: typeof failure === "number" ? failure : 500, headers: new Headers() };
    let data;
    if (url.host === "www.wikidata.org") {
      if (p.action === "wbsearchentities") data = { search: typeof search === "function" ? search(p.search) : search };
      else if (p.action === "wbgetentities") data = { entities: Object.fromEntries(p.ids.split("|").map(id => [id, entities[id] || { id, labels: { en: { value: id } }, claims: {} }])) };
      else data = { query: { search: (typeof fuzzy === "function" ? fuzzy(p.srsearch) : fuzzy).map(title => ({ title })) } };
    } else {
      const lang = url.host.slice(0, 2);
      if (p.list === "search") data = { query: { search: (typeof wikiSearch === "function" ? wikiSearch(p.srsearch, lang) : wikiSearch).map(hit => typeof hit === "string" ? { title: hit } : hit) } };
      else if (p.prop === "links") data = { query: { pages: [{ links: (links[`${lang}:${p.titles}`] || []).map(title => ({ title })) }] } };
      else data = { query: { pages: p.titles.split("|").map(title => pages[`${lang}:${title}`] || { title, missing: true }) } };
    }
    return { ok: true, json: async () => data };
  };
  return { fetch, calls };
}
const input = { query: "Elatohori", region: "pieria" };

test("geographic windows include historical areas but reject Niger and invalid points", () => {
  assert(inSearchArea(point(), "pieria"));
  assert(!inSearchArea(point(14, 3), "pieria"));
  assert(!inSearchArea(point(NaN, 22), "pieria"));
  assert(inSearchArea(point(38.28, 26.37), "asia-minor"));
  assert(inSearchArea(point(42.08, 26.34), "anatoliki-romelia"));
  assert(!inSearchArea(point(38.28, 26.37), "attiki"));
  assert(inSearchArea(point(39, 35), "new-research-region"));
});

test("matching supports romanizations and qualifiers without matching arbitrary mentions", () => {
  assert(nameScore("Elatohori", ["Elatochori"]) > 0);
  assert(nameScore("Neohorouda", ["Neochorouda"]) > 0);
  assert(nameScore("Naoussa", ["Naoussa, Imathia"]) > 0);
  assert.equal(nameScore("Pertouli Meadows", ["Elati, Trikala"]), 0);
  assert.equal(nameScore("", ["Village"]), 0);
});

test("good Wikidata candidates carry their own Greek name, point and source; requests are cached", async () => {
  const h = harness({ search: [{ id: "Q100", label: "Elatochori" }], entities: { Q100: place("Q100", "Elatochori") } });
  const lookup = createLocationLookup(h);
  const result = await lookup(input);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].greek, "Ελατοχώρι");
  assert.equal(result.candidates[0].source, "Wikidata");
  assert.equal(result.wikipediaSearched, false);
  const count = h.calls.length;
  assert.deepEqual(await lookup(input), result);
  assert.equal(h.calls.length, count);
});

test("insects, humans, non-Earth points, countries outside the selected area and distant communes are filtered before fuzzy fallback", async () => {
  const entities = {
    Q101: place("Q101", "Elatohori", { type: "Q16521" }),
    Q102: place("Q102", "Elatohori", { type: "Q5" }),
    Q103: place("Q103", "Elatohori", { points: [point(14, 3)] }),
    Q104: place("Q104", "Elatohori", { points: [point(40, 22, "http://www.wikidata.org/entity/Q111")] }),
    Q105: place("Q105", "Elatohori", { country: "Q43" }),
    Q100: place("Q100", "Elatochori")
  };
  const h = harness({ search: [101, 102, 103, 104, 105].map(n => ({ id: `Q${n}`, label: "Elatohori" })),
    fuzzy: q => q.includes("~2") ? ["Q100"] : [], entities });
  const result = await createLocationLookup(h)(input);
  assert.deepEqual(result.candidates.map(c => c.name), ["Elatochori"]);
  assert(h.calls.some(c => c.url.searchParams.get("srsearch")?.includes("Elatohori~2")));
});

test("country-specific settlement subclasses are accepted; preferred coordinates beat normal/deprecated statements", async () => {
  const entity = place("Q100", "Elatohori", { type: "Q900", claims: { P625: [statement(point(40.1, 22), "deprecated"), statement(point(40.2, 22)), statement(point(40.3, 22), "preferred")] } });
  const h = harness({ search: [{ id: "Q100" }], entities: { Q100: entity, Q900: { claims: { P279: [statement({ id: "Q532" })] } } } });
  const result = await createLocationLookup(h)(input);
  assert.equal(result.candidates[0].latitude, 40.3);
});

test("multiple conflicting points are not silently reduced to the first", async () => {
  const h = harness({ search: [{ id: "Q100" }], entities: { Q100: place("Q100", "Elatohori", { points: [point(), point(40.2, 22)] }) } });
  const result = await createLocationLookup(h)(input);
  assert.equal(result.candidates.length, 0);
  assert(result.warnings.some(w => w.includes("conflicting coordinates")));
  assert(result.wikipediaSearched);
});

test("Wikipedia fallback uses article primary coordinates and the actual Greek language link", async () => {
  const h = harness({ wikiSearch: ["Giannitsa", "Unrelated insect", "Elati, Trikala"], entities: { Q200: place("Q200", "Giannitsa", { aliases: ["Yiannitsa"], points: [] }) }, pages: {
    "en:Giannitsa": { pageid: 200, title: "Giannitsa", pageprops: { wikibase_item: "Q200" }, coordinates: [{ lat: 40.7833, lon: 22.4, primary: true, globe: "earth" }], langlinks: [{ lang: "el", title: "Γιαννιτσά" }] },
    "en:Unrelated insect": { pageid: 201, title: "Unrelated insect", description: "Insect species", coordinates: [{ lat: 40.7, lon: 22, primary: true, globe: "earth" }] },
    "en:Elati, Trikala": { pageid: 202, title: "Elati, Trikala", description: "Village in Greece", coordinates: [{ lat: 40.7, lon: 22, primary: true, globe: "earth" }] }
  } });
  const result = await createLocationLookup(h)({ query: "Yiannitsa", region: "macedonia-northern" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, "Wikipedia");
  assert.equal(result.candidates[0].greek, "Γιαννιτσά");
  assert.equal(result.candidates[0].latitude, 40.7833);
  assert(result.wikipediaSearched);
});

test("Wikipedia works during a Wikidata outage; secondary coordinates and disambiguation pages are not locations", async () => {
  const h = harness({ fail: u => u.host === "www.wikidata.org", wikiSearch: ["Elatohori", "Elatohori (other)", "Elatohori (disambiguation)"], pages: {
    "en:Elatohori": { pageid: 1, title: "Elatohori", description: "Village in Greece", coordinates: [{ lat: 40.32, lon: 22.265, primary: true, globe: "earth" }], langlinks: [{ lang: "el", title: "Ελατοχώρι" }] },
    "en:Elatohori (other)": { pageid: 2, title: "Elatohori (other)", description: "Village in Greece", coordinates: [{ lat: 40.32, lon: 22.265, primary: false, globe: "earth" }] },
    "en:Elatohori (disambiguation)": { pageid: 3, title: "Elatohori (disambiguation)", pageprops: { disambiguation: "" } }
  } });
  const result = await createLocationLookup(h)(input);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, "Wikipedia");
  assert(result.warnings.length);
});

test("Wikipedia finds a historical name in the lead, but not a mention of a different place", async () => {
  const h = harness({ wikiSearch: [
    { title: "Topolovgrad", snippet: "Topolovgrad (Bulgarian: Тополовград; Greek: Καβακλί <span class=\"searchmatch\">Kavakli</span>) is a town in Bulgaria." },
    { title: "Other Town", snippet: "Other Town is north of Kavakli." }
  ], pages: {
    "en:Topolovgrad": { pageid: 1, title: "Topolovgrad", description: "Place in Haskovo, Bulgaria", coordinates: [{ lat: 42.08, lon: 26.34, primary: true, globe: "earth", country: "BG" }], langlinks: [{ lang: "el", title: "Τοπόλοβγκραντ" }] },
    "en:Other Town": { pageid: 2, title: "Other Town", description: "Village in Bulgaria", coordinates: [{ lat: 42.2, lon: 26.4, primary: true, globe: "earth", country: "BG" }] }
  } });
  const result = await createLocationLookup(h)({ query: "Kavakli", region: "anatoliki-romelia" });
  assert.deepEqual(result.candidates.map(c => c.name), ["Topolovgrad"]);
  assert.equal(result.candidates[0].greek, "Τοπόλοβγκραντ");
});

test("a settlement ranks ahead of its same-named municipality", async () => {
  const h = harness({ search: [{ id: "Q100" }, { id: "Q101" }], entities: {
    Q100: place("Q100", "Naousa Municipality", { type: "Q56061", aliases: ["Naoussa"] }),
    Q101: place("Q101", "Naoussa")
  } });
  const result = await createLocationLookup(h)({ query: "Naoussa", region: "macedonia-central" });
  assert.equal(result.candidates[0].name, "Naoussa");
});

test("Greek disambiguation traversal is bounded, API-driven and does not splice names onto another point", async () => {
  const h = harness({ wikiSearch: ["Agia Marina"], pages: {
    "en:Agia Marina": { pageid: 1, title: "Agia Marina", pageprops: { disambiguation: "" }, langlinks: [{ lang: "el", title: "Αγία Μαρίνα (αποσαφήνιση)" }] },
    "el:Αγία Μαρίνα Ημαθίας": { pageid: 2, title: "Αγία Μαρίνα Ημαθίας", description: "οικισμός της Ελλάδας", coordinates: [{ lat: 40.598, lon: 22.215, primary: true, globe: "earth" }] }
  }, links: { "el:Αγία Μαρίνα (αποσαφήνιση)": ["Αγία Μαρίνα Ημαθίας"] } });
  const result = await createLocationLookup(h)({ query: "Aghia Marina", region: "macedonia-northern" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].source, "Greek Wikipedia");
  assert.equal(result.candidates[0].greek, "Αγία Μαρίνα Ημαθίας");
  assert.equal(result.candidates[0].latitude, 40.598);
});

test("more matches actually searches Wikipedia even with useful Wikidata hits, and preserves partial results on errors", async () => {
  const h = harness({ search: [{ id: "Q100" }], entities: { Q100: place("Q100", "Elatohori") }, fail: u => u.host.endsWith("wikipedia.org") });
  const result = await createLocationLookup(h)({ ...input, includeWikipedia: true });
  assert.equal(result.candidates.length, 1);
  assert(result.wikipediaSearched);
  assert(result.warnings.some(w => w.startsWith("Wikipedia")));
});

test("rank by selected subregion's existing locations, keeping same-name alternatives separate", async () => {
  const h = harness({ search: [{ id: "Q100" }, { id: "Q101" }], entities: {
    Q100: place("Q100", "Episkopi", { points: [point(40, 21)] }), Q101: place("Q101", "Episkopi", { points: [point(40.7, 22.14)] })
  } });
  const records = [{ type: "village", metadata: { region: "macedonia-northern", subregion: "episkopi", latitude: 40.69, longitude: 22.14 } }];
  const result = await createLocationLookup(h)({ query: "Episkopi", region: "macedonia-northern", subregion: "episkopi" }, records);
  assert.equal(result.candidates.length, 2);
  assert.match(result.candidates[0].id, /^Q101:/u);
});

test("lookups respect a total request budget and provider rate-limit cooldowns", async () => {
  const budget = harness({ search: [{ id: "Q100" }] });
  const limited = await createLocationLookup({ ...budget, maxRequests: 1 })(input);
  assert.equal(budget.calls.length, 1);
  assert(limited.warnings.length);
  const throttled = harness({ fail: () => 429 });
  const lookup = createLocationLookup(throttled);
  await lookup(input);
  const count = throttled.calls.length;
  await lookup(input);
  assert.equal(throttled.calls.length, count);
});

test("a stalled provider is aborted and returns manual-entry guidance", async () => {
  const fetch = (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  // Keep the test event loop alive while AbortSignal's unref'd timer fires.
  const timer = setTimeout(() => {}, 1000);
  try {
    const result = await createLocationLookup({ fetch, timeoutMs: 40, requestTimeoutMs: 15 })(input);
    assert.equal(result.candidates.length, 0);
    assert(result.warnings.length);
  } finally { clearTimeout(timer); }
});

test("invalid queries are rejected without contacting providers", async () => {
  const h = harness();
  const lookup = createLocationLookup(h);
  for (const query of ["", ":~!", "a".repeat(201)]) await assert.rejects(lookup({ ...input, query }), LocationLookupError);
  assert.equal(h.calls.length, 0);
});
