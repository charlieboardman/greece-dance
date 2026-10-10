import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  boundaryLabelExpression,
  createMapStyle,
  MAP_OPTIONS,
  BASEMAP_BOUNDS,
  TERRAIN_DETAIL_BOUNDS,
  mapMaxZoom
} from "../map-styles.js";

test("the map selector exposes three choices including OSM Streets", () => {
  assert.deepEqual(MAP_OPTIONS, [
    { id: "terrain", label: "Terrain" },
    { id: "boundaries", label: "Boundaries" },
    { id: "streets", label: "OSM Streets" }
  ]);
});

test("OSM Streets displays surrounding towns and street detail with localized labels", () => {
  const style = createMapStyle("streets", { language: "el" });
  for (const id of ["place-labels", "road-labels"]) {
    assert.deepEqual(style.layers.find(layer => layer.id === id).layout["text-field"], boundaryLabelExpression("el"));
  }
  for (const id of ["major-roads", "minor-roads", "buildings", "rivers"]) {
    assert.ok(style.layers.some(layer => layer.id === id));
  }
  assert.match(style.sources.shortbread.attribution, /OpenStreetMap/);
  assert.equal(style.sources.shortbread.maxzoom, 14);
  assert.equal(mapMaxZoom("streets"), 19);
  assert.equal(mapMaxZoom("terrain"), 11);
  assert.equal(mapMaxZoom("boundaries"), 11);
});

test("terrain uses the range-addressable SRTM PMTiles file", () => {
  const style = createMapStyle("terrain", { terrainUrl: "https://example.test/terrain.pmtiles" });

  assert.equal(style.sources["srtm-relief"].url, "pmtiles://https://example.test/terrain.pmtiles");
  assert.equal(style.layers[1].source, "srtm-relief");
});

test("boundaries uses localized OpenStreetMap labels", () => {
  const style = createMapStyle("boundaries", { language: "el" });
  const labels = style.layers.find((layer) => layer.id === "country-labels");

  assert.deepEqual(labels.layout["text-field"], boundaryLabelExpression("el"));
  assert.deepEqual(labels.layout["text-field"], ["coalesce", ["get", "name_el"], ["get", "name"]]);
  assert.equal(style.sources.shortbread.tiles[0], "/map-data/tiles/{z}/{x}/{y}.mvt");
  assert.equal(style.glyphs, "/map-data/glyphs/{fontstack}/{range}.pbf");
});

test("unknown map choices are rejected", () => {
  assert.throws(() => createMapStyle("satellite"), /Unknown map style/u);
});

test("terrain keeps the regional detail above a broad tiled overview", () => {
  const style = createMapStyle("terrain", {
    terrainUrl: "https://example.test/detail.pmtiles",
    terrainOverviewUrl: "https://example.test/overview.pmtiles"
  });
  assert.deepEqual(style.layers.slice(1).map(layer => layer.source), ["srtm-overview", "srtm-relief"]);
  assert.deepEqual(style.sources["srtm-overview"].bounds, [0, 0, 60, 60]);
  assert.deepEqual(style.sources["srtm-relief"].bounds, [12, 34, 48, 44]);
});

test("terrain build manifest matches advertised coverage", async () => {
  const manifest = JSON.parse(await readFile(new URL("../deploy/basemaps/terrain.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.outputs.map(o => o.bounds), [
    [BASEMAP_BOUNDS.west, BASEMAP_BOUNDS.south, BASEMAP_BOUNDS.east, BASEMAP_BOUNDS.north],
    [TERRAIN_DETAIL_BOUNDS.west, TERRAIN_DETAIL_BOUNDS.south, TERRAIN_DETAIL_BOUNDS.east, TERRAIN_DETAIL_BOUNDS.north]
  ]);
  assert.deepEqual(manifest.outputs.map(o => o.maxzoom), [8, 11]);
});
