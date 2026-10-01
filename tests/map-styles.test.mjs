import test from "node:test";
import assert from "node:assert/strict";
import { open } from "node:fs/promises";

import {
  boundaryLabelExpression,
  createMapStyle,
  MAP_OPTIONS,
  BASEMAP_BOUNDS,
  TERRAIN_DETAIL_BOUNDS
} from "../map-styles.js";

test("the map selector exposes the three intended choices", () => {
  assert.deepEqual(MAP_OPTIONS, [
    { id: "terrain", label: "Terrain" },
    { id: "land-sea", label: "Land & Sea" },
    { id: "boundaries", label: "Boundaries" }
  ]);
});

test("terrain uses the range-addressable SRTM PMTiles file", () => {
  const style = createMapStyle("terrain", { terrainUrl: "https://example.test/terrain.pmtiles" });

  assert.equal(style.sources["srtm-relief"].url, "pmtiles://https://example.test/terrain.pmtiles");
  assert.equal(style.layers[1].source, "srtm-relief");
});

test("land and sea creates one image source and raster layer per segment", () => {
  const segments = [
    { id: "west", url: "west.webp", coordinates: [[1, 2], [3, 2], [3, 0], [1, 0]] },
    { id: "east", url: "east.webp", coordinates: [[3, 2], [5, 2], [5, 0], [3, 0]] }
  ];
  const style = createMapStyle("land-sea", { landSeaSegments: segments });

  assert.deepEqual(Object.keys(style.sources), ["etopo-west", "etopo-east"]);
  assert.deepEqual(style.layers.slice(1).map((layer) => layer.source), ["etopo-west", "etopo-east"]);
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

test("land and sea places the tiled overview behind its detailed textures", () => {
  const style = createMapStyle("land-sea", {
    landSeaOverviewUrl: "https://example.test/overview.pmtiles",
    landSeaSegments: [{ id: "detail", url: "detail.webp", coordinates: [[12, 44], [48, 44], [48, 34], [12, 34]] }]
  });
  assert.deepEqual(style.layers.slice(1).map(layer => layer.source), ["etopo-overview", "etopo-detail"]);
  assert.deepEqual(style.sources["etopo-overview"].bounds, [0, 0, 60, 60]);
  assert.deepEqual(createMapStyle("boundaries").sources.shortbread.bounds, [0, 0, 60, 60]);
});

test("committed terrain and land-sea archives match the advertised coverage", async () => {
  for (const [filename, expectedBounds, maximumZoom] of [
    ["srtm-relief/overview.pmtiles", BASEMAP_BOUNDS, 8],
    ["etopo-2022-hydrography/overview.pmtiles", BASEMAP_BOUNDS, 8],
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
