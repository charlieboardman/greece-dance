import test from "node:test";
import assert from "node:assert/strict";
import { slugFromEnglish, newPlacePath, placeLabel } from "../editor/places.js";

test("English names produce stable safe creation paths without a slug field", () => {
  assert.equal(slugFromEnglish("  Ágios Ioánnis  "), "agios-ioannis");
  assert.equal(slugFromEnglish("St. John's"), "st-johns");
  assert.throws(() => slugFromEnglish("---"), /English name/u);
  assert.equal(newPlacePath("region", "Central Greece", "", []), "central-greece");
  assert.equal(newPlacePath("subregion", "Agrafa", "thessaly", []), "thessaly/agrafa (subregion)");
  assert.equal(newPlacePath("village", "New Village", "thessaly", [{ path: "thessaly/new-village" }]), "thessaly/new-village-2");
});

test("region choices display English names and retain subregion context", () => {
  const records = [
    { path: "old-slug", type: "region", metadata: { names: { en: "Updated Region" } } },
    { path: "old-slug/area (subregion)", type: "subregion", metadata: { names: { en: "Mountain Area" } } }
  ];
  assert.equal(placeLabel(records[0], records), "Updated Region");
  assert.equal(placeLabel(records[1], records), "Updated Region / Mountain Area");
});
