import test from "node:test";
import assert from "node:assert/strict";
import { open } from "node:fs/promises";

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
  assert.match(style.sources.shortbread.tiles[0], /vector\.openstreetmap\.org/u);
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

test("committed terrain archives match the advertised coverage", async () => {
  for (const [filename, expectedBounds, maximumZoom] of [
    ["srtm-relief/overview.pmtiles", BASEMAP_BOUNDS, 8],
    ["srtm-relief/greece-srtm-relief.pmtiles", TERRAIN_DETAIL_BOUNDS, 11]
  ]) {
    const file = await open(new URL(`../assets/basemaps/${filename}`, import.meta.url));
    try {
      const header = Buffer.alloc(127);
      await file.read(header, 0, header.length, 0);
      assert.equal(header.subarray(0, 7).toString(), "PMTiles", filename);
      assert.equal(header[7], 3, filename);
      assert.equal(header[100], 0, filename);
      assert.equal(header[101], maximumZoom, filename);
      assert.deepEqual([102, 106, 110, 114].map(offset => header.readInt32LE(offset) / 1e7),
        [expectedBounds.west, expectedBounds.south, expectedBounds.east, expectedBounds.north], filename);
    } finally { await file.close(); }
  }
});
