# National Dance Ministry Map

An interactive bilingual map with folder-based research content and a
password-protected editor that records changes in GitHub before publishing them.
The map uses MapLibre, bundled relief basemaps, and an OpenStreetMap boundary view.

## Run locally

Use Node.js 24 LTS and npm:

```bash
npm ci
cp .env.example .env
npm run dev
```

Open <http://localhost:8000/>. The map works immediately with the editor disabled.
Local content edits appear after refreshing the map. The editor lives at
`/editor/`; enabling it requires a password hash, session secret, and a GitHub
App installed on the target repository. See [deployment setup](deploy/README.md).
If enabled locally, submissions push real commits directly to the configured
repository's canonical branch and publish accepted content. Automated tests use
temporary local remotes instead. Linux `flock` (util-linux) is required for editing.

## Content and editing

[`info/`](info/) is the canonical content directory. Region and village JSON
store names and metadata in flat `regions/`, `subregions/`, and `villages/`
collections. JSON references determine membership; directory IDs stay fixed.
village `info.en.md` and `info.el.md` contain the dances and research notes.
Read the [complete folder schema and editing guide](content/README.md).

Both direct file edits and web editor submissions meet in GitHub. `main` is the
canonical accepted version. The editor makes no per-edit branches or PRs: it pushes
a content-only commit, fetches accepted `main`, validates and publishes `info/`.
The code image stays read-only. Live content lives on a separate persistent mount
and refreshes without an app rebuild or restart. For manual content changes use
`sudo ./update-info.sh`; `sudo ./upgrade.sh` performs a full code deployment.

```bash
npm run validate
npm test
npm run smoke
```

Tests cover the legacy migration, folder schema, authenticated editor API,
content-only Git commits, conflicting edits, partial-failure retries, and
release/rollback behavior. Deployment tests use local fixture repositories and
service hooks. `npm run smoke` checks the actual app and map byte-range serving.

### Optional village location lookup

In the village editor, select a region, enter an English place name, and click
**Find location**. The lookup searches Wikidata, including spelling variants,
then falls back to Wikipedia when it has no usable candidates. **Search more
matches, including Wikipedia** also checks Wikipedia when the first suggestions
are not the right place. Wikipedia article coordinates, language links and
English/Greek disambiguation links are read through its API; no AI agent or
page scraping is involved. There is no GNS integration or new package/API key.

Only supported geographic place types in the region's approximate search area
are suggested. Search windows include historical areas outside modern Greece;
they are deliberately generous, not administrative boundaries. Existing village
locations in the selected subregion/region help rank suggestions, but do not
establish that a match is correct. Check the description, source and **View on
map** link, then explicitly choose **Use these coordinates**. A single result
is never automatically applied. The English name and notes stay unchanged;
using the suggested Greek name is optional and defaults off if one is already
entered. Greek names can include administrative qualifiers or modern names in
place of historical ones. All fields remain editable.

The editor calls its authenticated, CSRF-protected server endpoint; the server
contacts only Wikidata and English/Greek Wikipedia. Requests have a 25-second
overall deadline, a 28-request budget, bounded result/link traversal and a
short-lived in-memory cache. Provider throttling is respected. Lookup errors
preserve the form, and manual entry, saving and publication never depend on a
lookup service. Opening **View on map** is an optional external OpenStreetMap
link, not another automatic lookup provider.

The feature lives in `editor/location-lookup.js` (UI) and
`server/location-lookup.js` (providers, filters and ranking). Unit/API tests run
with `npm test`. With Playwright available, run the isolated browser regression:

```bash
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/location-lookup-browser.mjs
```

It uses local fixtures and mocked provider responses, not live geocoding or
production content. The general editor browser test is `tests/editor-browser.mjs`.

## Deployment

[Deployment instructions](deploy/README.md) cover Ubuntu/Debian droplets. Run
`sudo ./setup.sh --hostname YOUR_DOMAIN_OR_IPV4` from a checkout to install
Podman Compose, build a tested Node.js 24 app image, configure the GitHub App,
set up HTTPS and renewal, and enable the editor. Code deployments remain manual;
setup disables the legacy automatic deployment timer. An IPv4 address uses sslip.io, so a
purchased domain is optional. GitHub App creation and key transfer are guided
manual steps. Existing credentials are reused when retrying.

Deployment uses staged releases, validation, health checks and rollback, separate
from the editor's Git workspace. The scripts act on the droplet only when run there.

## Region color palette

Region colors are a fixed categorical palette selected with a Glasbey-style
maximin process. Candidate colors are sampled in OKLCH, which makes geometric
distance correspond much more closely to perceived difference than RGB or HSL.
Candidates must:

- fit inside the sRGB gamut;
- have OKLCH lightness from 0.56 to 0.76 and chroma from 0.13 to 0.28, keeping
  them bright and vivid;
- maintain at least 3.5:1 contrast against the map's neutral black dots and
  2.15:1 against the original pale `#edf2ec` land color used when the palette
  was generated.

A multi-start farthest-point search chooses the candidate whose nearest
existing palette color is farthest away in OKLab at each step. The resulting
colors are converted to hex and stored explicitly in
each region’s `region.json`, so a region never changes color just
because content was added or reordered. The current colors were assigned to
minimize their total perceptual shift from the previous palette.

When adding a region, retain all existing assignments and choose the valid
candidate with the greatest minimum OKLab distance from the colors already in
use. Do not regenerate the whole palette: stable region identity is more
valuable than a small global improvement after each edit.

## Project structure

```text
info/                       Canonical region/subregion/village content
content/README.md           Schema and editing guide
app.js, index.html          Public map
editor/                     Password login, forms and change previews
lib/                        Shared content loader, validation and edit operations
server/                     Express API, sessions, Git and GitHub App integration
deploy/                     Droplet install, service, update and rollback tooling
scripts/                    Validation, migration, smoke checks and basemap tools
tests/                      Unit and integration tests; original Markdown fixture
assets/basemaps/            Bundled SRTM and ETOPO relief maps
vendor/                     Browser libraries and licenses
```

The original master Markdown, including its source comments, is preserved in
`tests/fixtures/legacy-dances.md` solely for migration testing. It is no longer
served or used as live data.

NASA SRTM, NOAA ETOPO, and Natural Earth supply the relief-map data.
OpenStreetMap supplies the live boundary view. Marked renders village info,
and DOMPurify sanitizes the resulting HTML. Library licenses are in `vendor/`.
