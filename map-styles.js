export const MAP_OPTIONS = [
  { id: "terrain", label: "Terrain" },
  { id: "boundaries", label: "Boundaries" },
  { id: "streets", label: "OSM Streets" }
];

export function mapMaxZoom(id) {
  return id === "streets" ? 19 : 11;
}

export const BASEMAP_BOUNDS = { south: 0, west: 0, north: 60, east: 60 };
export const TERRAIN_DETAIL_BOUNDS = { south: 34, west: 12, north: 44, east: 48 };

export function boundaryLabelExpression(language) {
  return ["coalesce", ["get", `name_${language}`], ["get", "name"]];
}

export function createMapStyle(id, {
  language = "en",
  terrainUrl,
  terrainOverviewUrl,
  bounds = BASEMAP_BOUNDS
} = {}) {
  if (id === "streets") {
    const style = createMapStyle("boundaries", { language, bounds });
    const countryLabels = style.layers.pop();
    style.layers[0] = backgroundLayer("#f3f1e9", "land-background");
    style.layers.splice(1, 0, {
      id: "land-cover", type: "fill", source: "shortbread", "source-layer": "land",
      paint: { "fill-color": ["match", ["get", "kind"],
        ["forest", "wood", "park", "grass", "grassland"], "#dce7d0",
        ["residential", "commercial", "industrial"], "#e9e5df", "#eeeede"] }
    });
    style.layers.push(...streetLayers(language), countryLabels);
    return style;
  }
  if (id === "terrain") {
    return {
      version: 8,
      sources: {
        ...(terrainOverviewUrl ? {
          "srtm-overview": rasterSource(terrainOverviewUrl, bounds)
        } : {}),
        "srtm-relief": rasterSource(terrainUrl, TERRAIN_DETAIL_BOUNDS)
      },
      layers: [
        backgroundLayer("#b4d8e9"),
        ...(terrainOverviewUrl ? [rasterLayer("srtm-overview")] : []),
        {
          id: "srtm-relief",
          type: "raster",
          source: "srtm-relief",
          paint: { "raster-resampling": "linear", "raster-fade-duration": 0 }
        }
      ]
    };
  }

  if (id === "boundaries") {
    return {
      version: 8,
      glyphs: "https://vector.openstreetmap.org/styles/shortbread/fonts/{fontstack}/{range}.pbf",
      sources: {
        shortbread: {
          type: "vector",
          tiles: ["https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt"],
          minzoom: 0,
          maxzoom: 14,
          bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
          attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>'
        }
      },
      layers: [
        backgroundLayer("#d6e7cf", "land-background"),
        {
          id: "ocean",
          type: "fill",
          source: "shortbread",
          "source-layer": "ocean",
          paint: { "fill-color": "#b9d7e8" }
        },
        {
          id: "inland-water",
          type: "fill",
          source: "shortbread",
          "source-layer": "water_polygons",
          paint: {
            "fill-color": "#b9d7e8",
            "fill-outline-color": "#a8c8da"
          }
        },
        {
          id: "internal-boundaries",
          type: "line",
          source: "shortbread",
          "source-layer": "boundaries",
          filter: [
            "all",
            [">", ["to-number", ["get", "admin_level"]], 2],
            ["!=", ["get", "maritime"], true]
          ],
          paint: {
            "line-color": "#d0d9d2",
            "line-width": 0.7
          }
        },
        {
          id: "country-boundaries",
          type: "line",
          source: "shortbread",
          "source-layer": "boundaries",
          filter: [
            "all",
            ["<=", ["to-number", ["get", "admin_level"]], 2],
            ["!=", ["get", "maritime"], true]
          ],
          paint: {
            "line-color": "#b7c5bd",
            "line-width": 1
          }
        },
        {
          id: "country-labels",
          type: "symbol",
          source: "shortbread",
          "source-layer": "boundary_labels",
          filter: ["==", ["to-number", ["get", "admin_level"]], 2],
          layout: {
            "text-field": boundaryLabelExpression(language),
            "text-font": ["noto_sans_regular"],
            "text-size": [
              "interpolate",
              ["linear"],
              ["zoom"],
              5, 10,
              8, 13
            ],
            "text-letter-spacing": 0.12,
            "text-transform": "uppercase",
            "text-max-width": 10,
            "text-padding": 4
          },
          paint: {
            "text-color": "#7c8982",
            "text-halo-color": "rgba(214, 231, 207, 0.85)",
            "text-halo-width": 1.5,
            "text-halo-blur": 0.5
          }
        }
      ]
    };
  }

  throw new Error(`Unknown map style “${id}”.`);
}

function backgroundLayer(color, id = "basemap-background") {
  return {
    id,
    type: "background",
    paint: { "background-color": color }
  };
}

function rasterSource(url, bounds) {
  return { type: "raster", url: `pmtiles://${url}`, tileSize: 256,
    bounds: [bounds.west, bounds.south, bounds.east, bounds.north] };
}

function rasterLayer(id) {
  return { id, type: "raster", source: id,
    paint: { "raster-resampling": "linear", "raster-fade-duration": 0 } };
}

function streetLayers(language) {
  const source = { source: "shortbread" };
  const majorRoad = ["in", ["get", "kind"],
    ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary"]]];
  const minorRoad = ["in", ["get", "kind"],
    ["literal", ["residential", "unclassified", "living_street", "service"]]];
  const roadWidth = ["interpolate", ["exponential", 1.4], ["zoom"], 5, 0.5, 11, 2.5, 16, 10, 19, 24];
  const textLayout = {
    "text-field": boundaryLabelExpression(language),
    "text-font": ["noto_sans_regular"]
  };
  const textPaint = { "text-color": "#46534b", "text-halo-color": "#f9f7ef", "text-halo-width": 1.5 };
  return [
    {
      id: "rivers", type: "line", ...source, "source-layer": "water_lines", minzoom: 9,
      paint: { "line-color": "#a8ccdf", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 16, 3] }
    },
    {
      id: "buildings", type: "fill", ...source, "source-layer": "buildings", minzoom: 14,
      paint: { "fill-color": "#ded8cc", "fill-outline-color": "#c9c0b0" }
    },
    {
      id: "minor-roads", type: "line", ...source, "source-layer": "streets", minzoom: 12,
      filter: minorRoad, layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 12, 1, 16, 6, 19, 16] }
    },
    {
      id: "road-casing", type: "line", ...source, "source-layer": "streets", filter: majorRoad,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#c9b99b",
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 5, 2, 11, 4, 16, 11.5, 19, 25.5] }
    },
    {
      id: "major-roads", type: "line", ...source, "source-layer": "streets", filter: majorRoad,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["match", ["get", "kind"], ["motorway", "trunk"], "#f0c580", "#fff1c8"],
        "line-width": roadWidth }
    },
    {
      id: "paths", type: "line", ...source, "source-layer": "streets", minzoom: 14,
      filter: ["in", ["get", "kind"], ["literal", ["path", "footway", "pedestrian", "track", "cycleway"]]],
      paint: { "line-color": "#b9a68b", "line-width": 1.2, "line-dasharray": [2, 2] }
    },
    {
      id: "railways", type: "line", ...source, "source-layer": "streets", minzoom: 10,
      filter: ["==", ["get", "rail"], true],
      paint: { "line-color": "#a6a5a0", "line-width": 1, "line-dasharray": [3, 2] }
    },
    {
      id: "road-labels", type: "symbol", ...source, "source-layer": "street_labels", minzoom: 13,
      layout: { ...textLayout, "symbol-placement": "line", "text-size": 11, "text-max-angle": 30 },
      paint: textPaint
    },
    {
      id: "place-labels", type: "symbol", ...source, "source-layer": "place_labels", minzoom: 4,
      layout: { ...textLayout,
        "text-size": ["interpolate", ["linear"], ["zoom"],
          4, ["match", ["get", "kind"], "city", 12, 10],
          12, ["match", ["get", "kind"], "city", 17, "town", 14, 12]],
        "text-padding": 5,
        "symbol-sort-key": ["match", ["get", "kind"], "city", 0, "town", 1, "village", 2, 3] },
      paint: textPaint
    }
  ];
}
