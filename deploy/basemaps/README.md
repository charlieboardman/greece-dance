# Same-origin basemaps

Browsers load all tiles, glyphs, fonts, scripts, and styles from the app's origin.
The public and editor CSP restricts connections to that origin. Ordinary external
research and attribution links still navigate to other sites when clicked.
Wikipedia/Wikidata location lookup already runs on the server.

## OSM: on-demand server cache

`/map-data/tiles/{z}/{x}/{y}.mvt` and
`/map-data/glyphs/noto_sans_regular/{range}.pbf` proxy only validated atlas tile
coordinates and the one configured font stack. The 0–60° camera extent and street
zoom remain unchanged. No country selection, preload, or bulk tile download is
performed. Uncached requests still need the upstream service to be available.

The server sends its own application/contact User-Agent and the configured site's
root Referer. It never forwards visitor IP headers, cookies, authentication,
request headers, or browsing paths. OSM receives the server's IP and requested
tile/glyph coordinates. This does not establish an exemption from privacy notices.
The [OSM vector policy](https://operations.osmfoundation.org/policies/vector/)
applies, including attribution and caching-proxy identification.

The persistent SQLite cache lives in `/var/lib/greece-dance-tile-cache`. It stores
map bytes, tile/glyph keys, validators and expiry, not visitors or access events.
`MAP_CACHE_BYTES` in app.env defaults to 1 GiB of payload. Allow about 15% additional
space for SQLite metadata/free pages, plus a small transaction journal. Expiry
respects upstream Cache-Control/Expires (seven days when unspecified); stale data
is revalidated where validators exist. No-store responses are not retained.
Four upstream fetches run at a time, up to 64 distinct requests wait/coalesce, and
responses are limited to 8 MiB with a 15-second timeout. Provider throttling causes
a cooldown. Cache failures never fall back to external browser URLs.

When the payload budget fills, expired entries are reclaimed. Unexpired entries
are retained for their cache lifetime, rather than evicted and fetched repeatedly.
New entries that still cannot fit return a temporary error. Increase the budget
if that happens under sustained use. Completed cached tiles continue to work.
Upstreams can be changed with `OSM_TILE_BASE` and `OSM_GLYPH_BASE`; old cache entries
are isolated by upstream URL and expire normally. No HTTP request logs are added.

## Terrain: production build cache

On upgrade, the release's `deploy/build-basemaps.sh` runs before the new app image
is activated. It uses a separate Python builder image, built in cached layers from
pinned dependency versions. The app image contains neither Python rendering
dependencies nor generated maps. The builder runs with one CPU quota, reduced CPU
weight, 300 MiB memory, and no swap allowance. Existing app service stays running.

`/var/lib/greece-dance-basemaps` contains:

- `cache/hgt`: verified extracted elevation granules, reused across builds.
- `cache/downloads`: Natural Earth archives and resumable partial downloads.
  SRTM ZIPs are removed after extraction and receipt/checksum publication.
- `cache/work-<hash>`: disposable current-build MBTiles intermediates.
- `versions/.building-<hash>`: completed individual outputs retained after failure.
- `versions/<hash>`: validated, immutable PMTiles and a checksum manifest.

The version hash covers the terrain configuration, source checksum manifest,
renderer, builder logic, builder image recipe and dependency versions. Village
content, application code, UI changes, and code release SHA do not invalidate it.
Downloads are checksum-verified; extracted files have verified local receipts.
Failed downloads resume where the origin supports byte ranges. A rerun skips a
completed output after checking its hash and PMTiles structure/tile count. An
interrupted output restarts that output. The whole version is renamed into place
only after both archives validate. Corrupt published versions fail deployment;
the builder never changes bytes behind an existing immutable URL.

Each app image records its exact terrain version. `/api/content` supplies that
version to the browser, and `/basemaps/<hash>/...` supports immutable caching and
byte ranges. The app mounts the versions directory read-only. Keeping old versions
means existing browser tabs and rollback releases retain their exact assets.
No automatic removal of published versions occurs. Deployment and asset builds
have separate locks; concurrent upgrades cannot publish partial assets.

A cached upgrade verifies the ~89 MB output and skips all downloads/rendering.
The first build downloads 3,159 elevation archives and retains **9.11 GB decimal**
of extracted HGT data. Final terrain was approximately **89 MB** with the previous
encoder. There is no 10 GB intermediate mosaic. A preflight checks free space for
missing source files plus a 2 GiB reserve for temporary outputs, the OSM cache,
and live services. Builder/container image storage also needs room. Build time
includes source downloads and packing, beyond the measured sample rendering time. The revised renderer projects to about
three hours under the deliberately pessimistic local VM CPU cap; see
[benchmark measurements and limitations](BENCHMARK.md).

The deployment service has no fixed startup timeout because a first build may
exceed several hours. To survive a disconnected SSH terminal, launch an already
installed upgrade with `sudo systemctl start --no-block greece-dance-update`.
Check its status with `systemctl status greece-dance-update`. This does not enable
the disabled update timer. setup.sh remains rerunnable after an interrupted build.

## Local development and checks

Node 24 is required. A fresh checkout does not contain generated terrain. Build it
with a writable local cache (this is a full build and downloads ~9 GB extracted):

```sh
GREECE_DANCE_BASEMAP_ROOT="$PWD/.state/basemaps" bash deploy/build-basemaps.sh "$PWD"
BASEMAP_DIR="$PWD/.state/basemaps/versions" npm run dev
```

The builder writes `.basemap-version` for the local server. For tests/dev using
an independently prepared tiny sample, `createApp` accepts explicit `basemapDir`
and `basemapVersion` options. No tests download the full atlas.

```sh
npm run validate
npm test
podman build --layers -f deploy/basemaps/Containerfile -t localhost/greece-dance-basemap-builder .
podman run --rm --network=none --cpus=1 --memory=300m --memory-swap=300m \
  -v "$PWD:/source:ro" --entrypoint python localhost/greece-dance-basemap-builder tests/terrain-build.py
```

The Python checks compare direct HGT sampling and chunk halos to the original
mosaic, validate PMTiles, and exercise a fresh/interrupted/resumed/cached build
using generated local fixtures. `tests/osm-map-browser.mjs` is an opt-in live
upstream check: all browser requests must remain same-origin; only visible map
requests go to OSM through the server. `deploy/check-container.mjs` exercises a
real local Compose deployment using temporary local remotes and fixtures.
