# Working on the Greek folk dance archive

Read `content/README.md` before editing archive content.

- `info/` is the sole live content source. Region and village JSON contain
  metadata; village Markdown contains the dances and research notes.
- Follow the documented ` (subregion)` folder convention. Keep folder slugs
  stable when renaming displayed names. Preserve existing region colors.
- Do not invent separate dance entities or infer shared dances from names.
- Do not change the legacy migration fixture when adding or correcting content.
- Run `npm run validate` and relevant tests. Use Node.js 24 LTS.
- The map's release and the editor's Git workspace are separate. Web edits must
  produce content-only proposal branches/PRs; never mutate the live release.
- Keep conflict detection based on the version the editor loaded. Preserve user
  input on submission errors and idempotent retry after a partial push.
- Keep credentials outside Git and never expose them in command arguments,
  logs, frontend code, test fixtures or API responses.
- Deployment scripts/configuration live in `deploy/`. Deployment tests use
  temporary local remotes and service hooks, not production infrastructure.
