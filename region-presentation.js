export function localizedName(item, language) {
  return item.names?.[language] || item.names?.en || item.names?.el || item.name || "";
}

export function localizedInfo(item, language) {
  if (typeof item.info === "string") return item.info;
  return item.info?.[language] || item.info?.en || item.info?.el || "";
}

export function expandedVillageBounds(villages, scale = 1.1) {
  if (!villages.length) return null;

  const latitudes = villages.map((village) => village.coordinates[0]);
  const longitudes = villages.map((village) => village.coordinates[1]);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const centerLatitude = (south + north) / 2;
  const centerLongitude = (west + east) / 2;

  return [
    [
      centerLongitude + (west - centerLongitude) * scale,
      centerLatitude + (south - centerLatitude) * scale
    ],
    [
      centerLongitude + (east - centerLongitude) * scale,
      centerLatitude + (north - centerLatitude) * scale
    ]
  ];
}

export function sortRegionsAlphabetically(regions, language = "en") {
  const collator = new Intl.Collator(language, {
    numeric: true,
    sensitivity: "base"
  });
  return [...regions].sort((first, second) =>
    collator.compare(localizedName(first, language), localizedName(second, language))
    || collator.compare(first.id, second.id)
  );
}

export function constrainViewportToCoverage([[west, south], [east, north]], coverage) {
  const mercatorY = latitude => Math.asinh(Math.tan(latitude * Math.PI / 180));
  const coverageSouth = mercatorY(coverage.south);
  const coverageNorth = mercatorY(coverage.north);
  const viewSouth = mercatorY(south);
  const viewNorth = mercatorY(north);
  const scale = Math.max(1, (east - west) / (coverage.east - coverage.west),
    (viewNorth - viewSouth) / (coverageNorth - coverageSouth));
  const halfWidth = (east - west) / scale / 2;
  const halfHeight = (viewNorth - viewSouth) / scale / 2;
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const longitude = clamp((west + east) / 2, coverage.west + halfWidth, coverage.east - halfWidth);
  const latitudeY = clamp((viewSouth + viewNorth) / 2,
    coverageSouth + halfHeight, coverageNorth - halfHeight);
  return {
    center: [longitude, Math.atan(Math.sinh(latitudeY)) * 180 / Math.PI],
    zoomAdjustment: Math.log2(scale)
  };
}
