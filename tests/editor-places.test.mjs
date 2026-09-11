import test from "node:test";
import assert from "node:assert/strict";
import { slugFromEnglish, newPlacePath, placeLabel } from "../editor/places.js";

test("English names produce stable safe creation paths without a slug field", () => {
  assert.equal(slugFromEnglish("  Ágios Ioánnis  "), "agios-ioannis");
  assert.equal(slugFromEnglish("St. John's"), "st-johns");
  assert.throws(() => slugFromEnglish("---"), /English name/u);
  assert.equal(newPlacePath("region", "Central Greece", []), "regions/central-greece");
  assert.equal(newPlacePath("subregion", "Agrafa", []), "subregions/agrafa");
  assert.equal(newPlacePath("village", "New Village", [{ path: "villages/new-village" }]), "villages/new-village-2");
});

test("region choices display English names and retain subregion context", () => {
  const records = [
    { path: "regions/old-slug", type: "region", metadata: { names: { en: "Updated Region" } } },
    { path: "subregions/area", type: "subregion", metadata: { names: { en: "Mountain Area" }, region: "old-slug" } }
  ];
  assert.equal(placeLabel(records[0], records), "Updated Region");
  assert.equal(placeLabel(records[1], records), "Updated Region / Mountain Area");
});

test("the editor reconstructs hierarchy and filters subregions using metadata", async () => {
  const { hierarchyRecords, availableSubregions } = await import("../editor/places.js");
  const records = [
    { type: "region", path: "regions/a", metadata: { names: { en: "A" } } },
    { type: "region", path: "regions/b", metadata: { names: { en: "B" } } },
    { type: "subregion", path: "subregions/s", metadata: { region: "b", names: { en: "S" } } },
    { type: "village", path: "villages/stable", metadata: { region: "b", subregion: "s", names: { en: "Village" } } }
  ];
  assert.deepEqual(hierarchyRecords(records).map(({ record, depth }) => [record.path, depth]), [
    ["regions/a", 0], ["regions/b", 0], ["subregions/s", 1], ["villages/stable", 2]
  ]);
  assert.equal(availableSubregions(records, "a").length, 0);
  assert.equal(availableSubregions(records, "b")[0].path, "subregions/s");
});
