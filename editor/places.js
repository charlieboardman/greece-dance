export function slugFromEnglish(name) {
  const slug = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/['’]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!slug) throw new Error("Enter an English name containing letters or numbers.");
  return slug;
}

export function placeLabel(record, records) {
  if (record.type !== "subregion") return record.metadata.names.en;
  const region = records.find((item) => item.path === record.path.split("/")[0]);
  return `${region.metadata.names.en} / ${record.metadata.names.en}`;
}

export function newPlacePath(type, name, region, records) {
  const slug = slugFromEnglish(name);
  const suffix = type === "subregion" ? " (subregion)" : "";
  const base = type === "region" ? slug : `${region}/${slug}`;
  let candidate = `${base}${suffix}`;
  let number = 2;
  while (records.some((record) => record.path === candidate)) candidate = `${base}-${number++}${suffix}`;
  return candidate;
}
