# Editing the archive

`info/` is the sole live content source. JSON stores names and relationships;
Markdown stores each village's dances and research notes. There is no database
or separate dance entity. Files may be edited directly or through `/editor/`,
which pushes content-only commits to GitHub's canonical branch and publishes them.
The running map reads a separately mounted, validated copy of accepted `info/`;
application images do not need rebuilding for content edits.

```text
info/
  regions/
    thessaly/
      region.json
  subregions/
    agrafa/
      subregion.json
  villages/
    thessaly--agrafa--petrilo/
      village.json
      info.en.md
      info.el.md
```

Each collection is flat. Directory names are permanent IDs, not geographic
paths. Existing village IDs retain their historical `--` components to preserve
map identity, but those components no longer determine membership. Do not rename
an ID when changing its displayed name or region. New IDs derive from English
names; the editor adds a numeric suffix on collision. IDs are unique within each
collection. They contain lowercase ASCII letters, digits and single or double
hyphens between words. Different records may share display names.

## Metadata

Every record directory needs its type's JSON file. Both names must be nonempty,
trimmed, single-line strings of at most 200 characters. Unknown or missing fields
are rejected. Region and subregion membership comes exclusively from references
in JSON, never from names or the physical folder location.

`regions/thessaly/region.json` (example color; preserve existing colors):

```json
{
  "names": { "en": "Thessaly", "el": "Θεσσαλία" },
  "color": "#123456"
}
```

`subregions/agrafa/subregion.json`:

```json
{
  "names": { "en": "Agrafa", "el": "Άγραφα" },
  "region": "thessaly"
}
```

`villages/thessaly--agrafa--petrilo/village.json`:

```json
{
  "names": { "en": "Petrilo", "el": "Πετρίλο" },
  "latitude": 39.29,
  "longitude": 21.46,
  "region": "thessaly",
  "subregion": "agrafa"
}
```

The coordinates above illustrate the schema, not a research correction. Latitude
and longitude must be numeric, within -90..90 and -180..180. Colors must be
six-digit hex values. `region` must reference an existing region ID. A village's
`subregion` must be `null` (direct region membership) or an existing subregion ID
belonging to that same region. Empty regions and subregions are supported.

## Moves and editing

To move a village, edit only its `region` and `subregion` fields. Keep the directory
and Markdown files in place. The web editor shows a required Region dropdown and
an optional Subregion dropdown filtered by region, with a None option. These
fields appear when creating and editing villages. English names appear throughout
the editor; IDs are internal. The archive tree is reconstructed from references.

Moving a subregion with villages through direct file edits requires updating its
villages' region references in the same commit. The editor validates the entire
result and rejects inconsistent relationships. Delete a village by deleting its
record directory. Regions/subregions must be empty before deletion. At least one
region must remain.

Submissions use the revision the form originally loaded, even after refreshing
the archive. Conflicts include the edited record and its source/destination
region/subregion metadata. Unrelated edits are retained. Errors preserve the form,
and a partially pushed submission can be retried without duplicate commits.
Each save carries a durable submission ID. The editor checks shared processing
status on load and while open, and retains the draft and ID in tab session storage
across reloads. Only one save/publication runs at a time. A failed publication after
a successful push is reported as saved to GitHub with publication pending.

The publisher fetches the canonical branch back from GitHub, extracts only its
`info/` Git tree into a temporary directory, validates the complete archive, and
atomically switches the live snapshot. No working-tree files are copied. The map
reloads a changed snapshot on the next archive request; existing browser tabs need
refreshing. Manual content pushes are published with `sudo ./update-info.sh` (or
the full `sudo ./upgrade.sh`). Neither the editor nor the content update command
rebuilds or restarts the application container.

## Markdown and file rules

Optional `info.en.md` and `info.el.md` live beside `village.json`. English is the
fallback for missing Greek, and the map can fall back to Greek when English is
missing. Headings are ordinary Markdown. Raw HTML is escaped and images render
as alt text. Existing text is preserved byte-for-byte on moves when unchanged.

Only the documented files belong in `info/`; keep supporting documentation
elsewhere. Symlinks, executable files and extra nesting are rejected. Each file
is limited to 128 KiB and the entire archive to 16 MiB of text.

```bash
npm run validate
npm test
git diff -- info/
```

## Migration history

`tests/fixtures/legacy-dances.md` is an unchanged historical fixture, never live
content. `scripts/migrate-content.js` still converts that original Markdown into
the historical nested format using `scripts/nested-archive.js` (migration-only).

`scripts/flatten-content.js SOURCE DESTINATION` converts a nested archive to the
current flat format. It validates before writing and refuses existing destination
directories. It preserves names, colors, coordinates, map village IDs, and exact
Markdown bytes. Subregion ID collisions are disambiguated with the original
region ID. The live loader accepts only the current flat schema.

Existing unmerged proposals using old paths must be recreated against the new
archive before merging. Old PRs are not automatically merged by the editor.
Reload/reopen the editor after a schema deployment. Changes to the content format
must remain compatible with the deployed application or be coordinated with a code
upgrade; ordinary notes and metadata edits need no code deployment.
