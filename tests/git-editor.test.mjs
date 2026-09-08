import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GitEditor, runGit } from "../server/git.js";
import { jsonText } from "../lib/archive.js";

const names = { en: "Region", el: "Περιοχή" };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dance-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git"); const clone = path.join(root, "client");
  await runGit(["init", "--bare", "--initial-branch=main", remote]);
  await runGit(["clone", remote, clone]);
  const git = async (...args) => (await runGit(args, { cwd: clone })).output.toString("utf8").trim();
  await git("config", "user.email", "test@example.test"); await git("config", "user.name", "Client");
  await mkdir(path.join(clone, "info", "region"), { recursive: true });
  await writeFile(path.join(clone, "info", "region", "region.json"), jsonText({ names, color: "#336699" }));
  await writeFile(path.join(clone, "app.js"), "original code\n");
  await git("add", "."); await git("commit", "-m", "Initial archive"); await git("push", "origin", "main");
  const pullRequests = { calls: [], fail: false, async ensure(value) { this.calls.push(value); if (this.fail) throw new Error("Offline"); return { number: 1, url: "https://github.com/example/archive/pull/1" }; } };
  const editor = new GitEditor({ directory: path.join(root, "cache.git"), remote, pullRequests });
  return { editor, clone, git, pullRequests };
}
const update = (base, en = "Renamed") => ({ base, change: { action: "update", path: "region", metadata: { names: { ...names, en }, color: "#336699" } } });
async function proposal(editor, request) { return { ...request, ...await editor.preview(request), submissionId: randomUUID() }; }

test("web proposal changes only content on its own branch and is retryable after PR failure", async (t) => {
  const { editor, clone, git, pullRequests } = await fixture(t);
  const snapshot = await editor.snapshot();
  const request = await proposal(editor, update(snapshot.revision));
  pullRequests.fail = true;
  await assert.rejects(editor.submit(request), /branch was pushed/u);
  assert.equal(await git("ls-remote", "origin", "refs/heads/main"), `${snapshot.revision}\trefs/heads/main`);
  assert.equal(await readFile(path.join(clone, "app.js"), "utf8"), "original code\n");
  pullRequests.fail = false;
  const result = await editor.submit(request);
  const retried = await editor.submit(request);
  assert.equal(result.commit, retried.commit);
  await git("fetch", "origin", result.branch);
  assert.equal(await git("diff", "--name-only", snapshot.revision, result.commit), "info/region/region.json");
  assert.equal(JSON.parse(await git("show", `${result.commit}:info/region/region.json`)).names.en, "Renamed");
  assert.equal((await editor.snapshot()).revision, snapshot.revision);
  await assert.rejects(editor.submit({ ...request, change: { ...request.change, metadata: { ...request.change.metadata, color: "#ffffff" } } }), /different edit/u);
});

test("stale forms reject overlapping edits, including parent changes", async (t) => {
  const { editor, clone, git } = await fixture(t);
  const { revision } = await editor.snapshot();
  await writeFile(path.join(clone, "info/region/region.json"), jsonText({ names, color: "#ffffff" }));
  await git("add", "."); await git("commit", "-m", "Client changes region"); await git("push", "origin", "main");
  await assert.rejects(editor.preview(update(revision)), (error) => error.status === 409);
  await assert.rejects(editor.preview({ base: revision, change: { action: "create", path: "region/village", metadata: { names, latitude: 40, longitude: 22 }, info: { en: "notes", el: "" } } }), /parent changed/u);
});

test("unrelated client edits are retained in a web proposal", async (t) => {
  const { editor, clone, git } = await fixture(t);
  const { revision } = await editor.snapshot();
  const request = await proposal(editor, update(revision));
  await mkdir(path.join(clone, "info/second"));
  await writeFile(path.join(clone, "info/second/region.json"), jsonText({ names, color: "#ffffff" }));
  await git("add", "."); await git("commit", "-m", "Add another region"); await git("push", "origin", "main");
  const latest = await git("rev-parse", "HEAD");
  const result = await editor.submit(request);
  await git("fetch", "origin", result.branch);
  assert.equal(await git("rev-parse", `${result.commit}^`), latest);
  assert.equal(await git("show", `${result.commit}:info/second/region.json`), jsonText({ names, color: "#ffffff" }).trim());
});

test("malformed operations and invalid previews never push branches", async (t) => {
  const { editor, git } = await fixture(t);
  const { revision } = await editor.snapshot();
  await assert.rejects(editor.preview({ base: revision, change: { action: "create", path: "../app.js" } }));
  const request = await proposal(editor, update(revision));
  await assert.rejects(editor.submit({ ...request, previewHash: "0".repeat(64) }), /preview/u);
  assert.equal(await git("ls-remote", "origin", "refs/heads/editor/*"), "");
});

test("Git proposals handle subregion paths with spaces and village removal", async (t) => {
  const { editor, clone, git } = await fixture(t);
  const folder = "region/area (subregion)";
  await mkdir(path.join(clone, "info", folder, "village"), { recursive: true });
  await writeFile(path.join(clone, "info", folder, "subregion.json"), jsonText({ names }));
  await writeFile(path.join(clone, "info", folder, "village/village.json"), jsonText({ names, latitude: 40, longitude: 22 }));
  await writeFile(path.join(clone, "info", folder, "village/info.el.md"), "Χοροί\n");
  await git("add", "."); await git("commit", "-m", "Add village"); await git("push", "origin", "main");
  const { revision } = await editor.snapshot();
  const request = await proposal(editor, { base: revision, change: { action: "update", path: `${folder}/village`,
    metadata: { names, latitude: 40.5, longitude: 22 }, info: { en: "Dance notes", el: "Χοροί" } } });
  const result = await editor.submit(request);
  await git("fetch", "origin", result.branch);
  assert.equal(await git("show", `${result.commit}:info/${folder}/village/info.en.md`), "Dance notes");
  const deletion = await editor.submit(await proposal(editor, { base: revision, change: { action: "delete", path: `${folder}/village` } }));
  await git("fetch", "origin", deletion.branch);
  assert.equal(await git("ls-tree", "-r", "--name-only", deletion.commit, "--", `info/${folder}`), `info/${folder}/subregion.json`);
});
