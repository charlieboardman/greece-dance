# Editing the archive

`info/` is the canonical content source. Edit these JSON and Markdown files
directly, or use `/editor/` to propose the same changes in a pull request.
There are no separate dance records: a village's info text contains its dances.

```text
info/
  thessaly/
    region.json
    agrafa (subregion)/
      subregion.json
      argithea/
        village.json
        info.en.md
        info.el.md
    another-village/
      village.json
      info.en.md
```

Top-level folders are regions. A folder ending in exactly ` (subregion)` is a
subregion directly under a region. Villages sit directly under a region or
under one of its subregions. Deeper nesting is not supported.

Folder slugs contain lowercase ASCII letters, numbers and single hyphens:
`argithea`, `macedonia-eastern`, `agrafa (subregion)`. Keep slugs stable when
changing a display name. The path establishes membership and the map's internal
ID; moving or renaming folders changes that ID. Names need not be unique; the
same geographic place can have records in different cultural regions.

## Metadata

Every folder needs its matching metadata file, including empty regions and
subregions. Both names are required, nonempty and trimmed. Unknown fields are
rejected so misspellings cannot silently lose data.

`region.json` (example color only; retain the actual region's existing color):

```json
{
  "names": { "en": "Thessaly", "el": "Θεσσαλία" },
  "color": "#123456"
}
```

`subregion.json`:

```json
{
  "names": { "en": "Agrafa", "el": "Άγραφα" }
}
```

`village.json`:

```json
{
  "names": { "en": "Argithea", "el": "Αργιθέα" },
  "latitude": 39.357,
  "longitude": 21.538
}
```

Colors must be six-digit hex colors. Coordinates are JSON numbers, latitude
between -90 and 90 and longitude between -180 and 180. Region/subregion references
are not duplicated in village metadata.

## Info

`info.en.md` and `info.el.md` are optional UTF-8 Markdown files next to
`village.json`. English is the fallback for missing Greek text; English display
also falls back to Greek if only Greek is present, preserving the existing app.
Headings of any level are ordinary Markdown because structural metadata is in
separate files. The public map and editor preview escape raw HTML and render
images as their alt text, as the original map did.

Use paragraphs, lists, headings and links for dance information and sources.
There is no new dance schema or attachment system. Only documented metadata
and info files belong inside `info/`; keep supporting documentation elsewhere.
Symlinks and executable files are not supported. Each file is limited to 128 KiB,
and the filesystem archive to 16 MiB of text.

## Add, edit, delete and validate

Create the relevant folder and metadata; add info files for a village as needed.
Delete a village by deleting its folder. The web editor only deletes empty
regions/subregions; remove or move their children deliberately first. Keep at
least one region, which may itself be empty.

```bash
npm run validate
npm test
git diff -- info/
```

Commit and push through the usual review workflow. GitHub `main` is canonical;
the deployed site updates after a successful deployment. Unmerged editor PRs
are proposals and will not appear in editor snapshots until merged.

`tests/fixtures/legacy-dances.md` preserves the original master Markdown,
including source comments, as a migration fixture. It is not live content.
`scripts/migrate-content.js` converts that format into a new directory and
refuses to overwrite an existing directory.
