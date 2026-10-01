import assert from "node:assert/strict";
import test from "node:test";
import {
  expandedVillageBounds,
  constrainViewportToCoverage,
  localizedInfo,
  localizedName,
  sortRegionsAlphabetically
} from "../region-presentation.js";

test("localizedName uses the requested language with sensible fallbacks", () => {
  assert.equal(localizedName({ names: { en: "Thessaly", el: "Θεσσαλία" } }, "el"), "Θεσσαλία");
  assert.equal(localizedName({ names: { en: "Thessaly", el: "" } }, "el"), "Thessaly");
});

test("localizedInfo uses Greek when available and otherwise falls back to English", () => {
  assert.equal(
    localizedInfo({ info: { en: "English text", el: "Ελληνικό κείμενο" } }, "el"),
    "Ελληνικό κείμενο"
  );
  assert.equal(localizedInfo({ info: { en: "English text", el: "" } }, "el"), "English text");
});

test("expandedVillageBounds adds ten percent around the village extrema", () => {
  const villages = [
    { coordinates: [10, 2] },
    { coordinates: [3, 20] },
    { coordinates: [0, 5] },
    { coordinates: [4, 0] }
  ];

  assert.deepEqual(expandedVillageBounds(villages), [
    [-1, -0.5],
    [21, 10.5]
  ]);
  assert.equal(expandedVillageBounds([]), null);
});

test("sortRegionsAlphabetically orders regions in the displayed language", () => {
  const regions = [
    { id: "beta", names: { en: "Beta", el: "Άλφα" } },
    { id: "alpha", names: { en: "Alpha", el: "Βήτα" } }
  ];

  assert.deepEqual(
    sortRegionsAlphabetically(regions).map((region) => region.id),
    ["alpha", "beta"]
  );
  assert.deepEqual(
    sortRegionsAlphabetically(regions, "el").map((region) => region.id),
    ["beta", "alpha"]
  );
  assert.deepEqual(
    regions.map((region) => region.id),
    ["beta", "alpha"]
  );
});

test("viewport containment clamps longitude after a tall resize at the eastern edge", () => {
  const result = constrainViewportToCoverage(
    [[32.71360939751506, 0], [60.90124390248167, 60]],
    { west: 0, south: 0, east: 60, north: 60 }
  );
  assert.ok(Math.abs(result.center[0] - 45.9061827475167) < 1e-8);
  assert.ok(Math.abs(result.center[1] - 35.26438968275465) < 1e-8);
  assert.equal(result.zoomAdjustment, 0);
});

test("viewport containment increases zoom when the screen exceeds coverage", () => {
  const result = constrainViewportToCoverage([[-30, 0], [90, 60]],
    { west: 0, south: 0, east: 60, north: 60 });
  assert.equal(result.zoomAdjustment, 1);
  assert.equal(result.center[0], 30);
});
