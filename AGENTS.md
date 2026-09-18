# Working on the National Dance Ministry Map

Read `content/README.md` before editing map content.

- `info/` is the sole live content source. Region and village JSON contain
  metadata; village Markdown contains the dances and research notes.
- Follow the documented flat `regions/`, `subregions/`, and `villages/` schema.
  Keep directory IDs stable; membership comes from JSON references. Preserve
  existing region colors.
- Do not invent separate dance entities or infer shared dances from names.
- Do not change the legacy migration fixture when adding or correcting content.
- Run `npm run validate` and relevant tests. Use Node.js 24 LTS.
- Code releases, the editor's partial Git workspace, and published content are
  separate. Web edits push content-only commits directly to the canonical branch
  (no PRs), then fetch accepted content back before publication. Never mutate the
  code release. Editor and CLI must share publication code and a process-safe lock.
- Publish complete validated snapshots atomically; preserve the last live map content
  on failure. setup.sh must be rerunnable without losing credentials or state.
- Keep conflict detection based on the version the editor loaded. Preserve user
  input on submission errors and idempotent retry after a partial push.
- Keep credentials outside Git and never expose them in command arguments,
  logs, frontend code, test fixtures or API responses.
- Deployment scripts/configuration live in `deploy/`. Deployment tests use
  temporary local remotes and service hooks, not production infrastructure.
