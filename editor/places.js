export function slugFromEnglish(name) {
  const slug = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/['’]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!slug) throw new Error("Enter an English name containing letters or numbers.");
  return slug;
}

export const recordId = record => record.path.split("/")[1];

export function placeLabel(record, records) {
  if (record.type !== "subregion") return record.metadata.names.en;
  const region = records.find(item => item.type === "region" && recordId(item) === record.metadata.region);
  return `${region.metadata.names.en} / ${record.metadata.names.en}`;
}

export function newPlacePath(type, name, records) {
  const base = `${type}s/${slugFromEnglish(name)}`;
  let candidate = base;
  let number = 2;
  while (records.some(record => record.path === candidate)) candidate = `${base}-${number++}`;
  return candidate;
}

export function hierarchyRecords(records) {
  const alphabetical = items => items.sort((a, b) => a.metadata.names.en.localeCompare(b.metadata.names.en, "en"));
  return alphabetical(records.filter(r => r.type === "region")).flatMap(region => [
    { record: region, depth: 0 },
    ...alphabetical(records.filter(r => r.type === "village" && r.metadata.region === recordId(region) && r.metadata.subregion === null)).map(record => ({ record, depth: 1 })),
    ...alphabetical(records.filter(r => r.type === "subregion" && r.metadata.region === recordId(region))).flatMap(subregion => [
      { record: subregion, depth: 1 },
      ...alphabetical(records.filter(r => r.type === "village" && r.metadata.subregion === recordId(subregion))).map(record => ({ record, depth: 2 }))
    ])
  ]);
}

export function availableSubregions(records, region) {
  return records.filter(record => record.type === "subregion" && record.metadata.region === region)
    .sort((a, b) => a.metadata.names.en.localeCompare(b.metadata.names.en, "en"));
}
