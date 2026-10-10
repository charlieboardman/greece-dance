# SRTM land-relief basemap

Two static, range-addressable raster archives form the terrain basemap:

- `overview.pmtiles`: 0°E–60°E and 0°N–60°N, zoom levels 0–8. This generous
  rectangle covers portrait phone home views and navigation beyond the villages.
- `greece-srtm-relief.pmtiles`: 12°E–48°E and 34°N–44°N, zoom levels 0–11.
  This retains the original detailed coverage and extends it east past all
  current villages. The highest zoom uses 3 arc-second (roughly 90 m) elevation.

The detailed archive overlays the overview. Beyond the detailed rectangle,
the browser enlarges overview tiles when zooming in. Boundary tiles have
transparent pixels outside their crop so detail never erases overview terrain.
The sea is a single flat color, with no bathymetry. The browser fetches only
headers, indexes, and visible WebP tiles, rather than entire archives.

All map styles and camera limits use `BASEMAP_BOUNDS` in `map-styles.js`.
Camera limits account for the viewport, keeping visible edges inside the built
coverage even on unusually tall screens. Such screens can require a closer
view than the initial fit of all villages.

The terrain comes from NASA's version-3 SRTMGL3S product. Natural Earth's
1:10m lakes and rivers are drawn over it, along with its coastline at overview
zooms. At deep zooms the coastline follows the more detailed SRTM land mask.
Build outputs and source inputs have checksums in this directory's manifests.

## Sources and rights

NASA's [SRTMGL3S version 3 dataset](https://doi.org/10.5067/MEaSUREs/SRTM/SRTMGL3S.003)
provides one signed 16-bit, 1201×1201 elevation grid per one-degree land
granule. It is a work of the United States government and is not subject to
copyright in the United States. NASA's canonical download requires a free
Earthdata login; these build inputs were downloaded without modification from
the public `https://srtm.fasma.org/` mirror. The exact 3,159 source archive names
and checksums are in [`SRTMGL3S-SHA256SUMS`](SRTMGL3S-SHA256SUMS). That
manifest's SHA-256 is
`b6b8c5b117109f628e5446dac709f019658ef380b434e934d98265a87dbe1cf8`.
The build uses all listed granules within 0–60°E and 0–60°N. Missing granules
are initialized as water, so download every listed input before rendering.

Natural Earth inputs:

- `ne_10m_coastline.zip` — `bfa04cdbcbef07ef90dfca1dabb48062eca29900a113df0f389303e255484017`
- `ne_10m_lakes.zip` — `0803a06f9c3cb4671d89b68c48b142aad9366ba40f665245e12a913fbc61722a`
- `ne_10m_lakes_europe.zip` — `c0b1f0da4dce6af3b27c49b3ed11a664d801ff3d140ca5b9814e7e85a35c1de1`
- `ne_10m_rivers_lake_centerlines.zip` — `ded71b01870855ccfe19b51f2ec14c9bb48fae23c0e9f3c11974d426433b5c38`
- `ne_10m_rivers_europe.zip` — `c730ccb4cbe21c1f03d006de4032a0dc69ade342de941d10aa1facab59019dbf`

Natural Earth makes all of its data available under its
[public-domain terms of use](https://www.naturalearthdata.com/about/terms-of-use/).
Neither source requires map attribution.

## Building and caching

Generated archives are no longer tracked in Git. `deploy/build-basemaps.sh` builds
both outputs on the deployment machine, before switching releases. See
[the build/deployment guide](../../../deploy/basemaps/README.md) for resource
limits, cache keys, recovery, and local development.

`deploy/basemaps/terrain.json` defines coverage and quality. The renderer samples
source HGT files directly with a bounded map of open files and renders at most
four tiles per chunk, with interpolation halos preserved across chunk edges.
There is no intermediate continent-sized elevation mosaic. Python, NumPy,
Pillow, pyshp, and the PMTiles packer run in the separate builder container.

The historical `BUILD-SHA256SUMS` describes the previously committed archives.
New builds record their checksums in each immutable version's `manifest.json`;
encoder/packer changes can change bytes while preserving map coverage and detail.
