# Greek Folk Dance Research Map

An interactive bilingual atlas with a folder-based research archive and a
password-protected editor that proposes changes through GitHub pull requests.
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
If enabled locally, submissions create real proposal branches and PRs in the
configured repository. Automated tests use temporary local remotes instead.

## Content and editing

[`info/`](info/) is the canonical content directory. Region and village JSON
store names and metadata; optional subregion folders end in ` (subregion)`;
village `info.en.md` and `info.el.md` contain the dances and research notes.
Read the [complete folder schema and editing guide](content/README.md).

Both direct file edits and web editor submissions meet in GitHub. `main` is the
canonical accepted version; unmerged PRs are proposals. The web editor never
modifies the deployed app or automatically merges its PRs.

```bash
npm run validate
npm test
npm run smoke
```

Tests cover the legacy migration, folder schema, authenticated editor API,
content-only Git proposals, conflicting edits, partial-failure retries, and
release/rollback behavior. Deployment tests use local fixture repositories and
service hooks. `npm run smoke` checks the actual app and map byte-range serving.

## Deployment

[Deployment instructions](deploy/README.md) cover Ubuntu/Debian droplets. Run
`sudo ./setup.sh --hostname YOUR_DOMAIN_OR_IPV4` from a checkout to install Node.js
24 and dependencies, configure the GitHub App, deploy, set up HTTPS and renewal,
and enable the editor and automatic updates. An IPv4 address uses sslip.io, so a
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
lib/                        Shared archive loader, validation and edit operations
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
