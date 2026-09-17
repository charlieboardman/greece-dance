import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GitEditor, runGit } from "../server/git.js";
import { PublishedArchive } from "../server/publisher.js";
import { jsonText } from "../lib/archive.js";
import { writeJSON, acquireLock } from "../server/state.js";
import { spawn } from "node:child_process";
import { once } from "node:events";

const names = { en: "Region", el: "Περιοχή" };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dance-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git"), clone = path.join(root, "client");
  await runGit(["init", "--bare", "--initial-branch=main", remote]);
  await runGit(["--git-dir", remote, "config", "uploadpack.allowFilter", "true"]);
  await runGit(["--git-dir", remote, "config", "uploadpack.allowAnySHA1InWant", "true"]);
  await runGit(["clone", remote, clone]);
  const git = async (...args) => (await runGit(args, { cwd: clone })).output.toString("utf8").trim();
  await git("config", "user.email", "test@example.test"); await git("config", "user.name", "Client");
  await mkdir(path.join(clone, "info/regions/region"), { recursive: true });
  await writeFile(path.join(clone, "info/regions/region/region.json"), jsonText({ names, color: "#336699" }));
  await writeFile(path.join(clone, "app.js"), "original code\n");
  await git("add", "."); await git("commit", "-m", "Initial archive"); await git("push", "origin", "main");
  const publisher = new PublishedArchive(path.join(root, "published"));
  const options = { directory: path.join(root, "state/repository.git"), remote: `file://${remote}`, publisher };
  const editor = new GitEditor(options);
  await editor.publish();
  return { root, editor, clone, git, publisher, options, remote };
}
const update = (base, en = "Renamed") => ({ base, change: { action: "update", path: "regions/region", metadata: { names: { ...names, en }, color: "#336699" } } });
async function proposal(editor, request) { return { ...request, ...await editor.preview(request), submissionId: randomUUID() }; }

test("save pushes only content directly to main and publishes the GitHub round trip", async t => {
  const { editor, git, publisher } = await fixture(t);
  const { revision } = await editor.snapshot();
  const request = await proposal(editor, update(revision));
  const result = await editor.submit(request);
  await git("fetch", "origin");
  assert.equal(await git("rev-parse", "origin/main"), result.commit);
  assert.equal(await git("diff", "--name-only", revision, result.commit), "info/regions/region/region.json");
  assert.equal(await git("ls-remote", "origin", "refs/heads/editor/*"), "");
  assert.equal((await publisher.snapshot()).archive.regions[0].name, "Renamed");
  assert.equal((await editor.submit(request)).commit, result.commit);
  assert.equal((await editor.status(request.submissionId)).operation.state, "completed");
  await assert.rejects(editor.submit({ ...request, change: { ...request.change, metadata: { ...request.change.metadata, color: "#ffffff" } } }), /different edit/u);
});

test("publication failure recovers after restart without a duplicate commit", async t => {
  const { editor, git, publisher, options } = await fixture(t);
  const request = await proposal(editor, update((await editor.snapshot()).revision));
  const publish = publisher.publish.bind(publisher);
  publisher.publish = async () => { throw new Error("Offline"); };
  await assert.rejects(editor.submit(request), /Saved to GitHub/u);
  await git("fetch", "origin");
  const commit = await git("rev-parse", "origin/main");
  assert.equal((await publisher.snapshot()).archive.regions[0].name, "Region");
  publisher.publish = publish;
  const restarted = new GitEditor(options);
  assert.equal((await restarted.submit(request)).commit, commit);
  assert.equal((await publisher.snapshot()).archive.regions[0].name, "Renamed");
  await git("fetch", "origin");
  assert.equal(await git("rev-list", "--count", "origin/main"), "2");
});

test("lost push acknowledgement is recovered using the commit submission marker", async t => {
  const { editor, git } = await fixture(t);
  const request = await proposal(editor, update((await editor.snapshot()).revision));
  const original = editor.git.bind(editor);
  let lost = false;
  editor.git = async (args, options) => {
    const result = await original(args, options);
    if (args[0] === "push" && !lost) { lost = true; throw new Error("Connection lost after accepting push"); }
    return result;
  };
  const result = await editor.submit(request);
  assert.equal(result.state, "completed");
  await git("fetch", "origin");
  assert.equal(await git("rev-list", "--count", "origin/main"), "2");
});

test("stale forms reject overlapping edits and changed parent metadata", async t => {
  const { editor, clone, git } = await fixture(t);
  const { revision } = await editor.snapshot();
  await writeFile(path.join(clone, "info/regions/region/region.json"), jsonText({ names, color: "#ffffff" }));
  await git("add", "."); await git("commit", "-m", "Change region"); await git("push", "origin", "main");
  await assert.rejects(editor.preview(update(revision)), error => error.status === 409);
  await assert.rejects(editor.preview({ base: revision, change: { action: "create", path: "villages/village", metadata: { names, region: "region", subregion: null, latitude: 40, longitude: 22 }, info: { en: "notes", el: "" } } }), /region\/subregion changed/u);
});

for (const overlap of [false, true]) test(`competing main push is revalidated (overlap=${overlap})`, async t => {
  const { editor, clone, git } = await fixture(t);
  const request = await proposal(editor, update((await editor.snapshot()).revision));
  const original = editor.git.bind(editor);
  let raced = false;
  editor.git = async (args, options) => {
    if (args[0] === "push" && !raced) {
      raced = true;
      const filename = overlap ? "info/regions/region/region.json" : "app.js";
      await writeFile(path.join(clone, filename), overlap ? jsonText({ names, color: "#abcdef" }) : "new engine\n");
      await git("add", "."); await git("commit", "-m", "Laptop race"); await git("push", "origin", "main");
    }
    return original(args, options);
  };
  if (overlap) await assert.rejects(editor.submit(request), error => error.status === 409);
  else {
    const result = await editor.submit(request);
    await git("fetch", "origin");
    assert.equal(await git("show", `${result.commit}:app.js`), "new engine");
  }
});

test("global lock reports busy and rejects simultaneous submissions/publication across instances", async t => {
  const { editor, publisher, options } = await fixture(t);
  const request = await proposal(editor, update((await editor.snapshot()).revision));
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const publish = publisher.publish.bind(publisher);
  publisher.publish = async (...args) => { entered(); await gate; return publish(...args); };
  const running = editor.submit(request);
  await reached;
  const other = new GitEditor(options);
  try {
    assert.equal((await other.status()).busy, true);
    await assert.rejects(other.submit({ ...request, submissionId: randomUUID() }), error => error.status === 423);
    await assert.rejects(other.publish(), error => error.status === 423);
  } finally { release(); await running; }
  assert.equal((await other.status()).busy, false);
});

test("interrupted durable operation resumes publication on recovery", async t => {
  const { editor, options, publisher } = await fixture(t);
  const request = await proposal(editor, update((await editor.snapshot()).revision));
  const result = await editor.submit(request);
  const filename = editor.operationPath(request.submissionId);
  const operation = JSON.parse(await readFile(filename, "utf8"));
  operation.state = "processing"; operation.stage = "publishing";
  await writeJSON(filename, operation);
  const restarted = new GitEditor(options);
  assert.equal((await restarted.status()).busy, true);
  await restarted.recover();
  assert.equal((await restarted.status()).operation.commit, result.commit);
  assert.equal((await publisher.snapshot()).revision, result.revision);
});

test("partial clone downloads info blobs without engine blobs", async t => {
  const { editor, git } = await fixture(t);
  const engine = await git("rev-parse", "HEAD:app.js");
  const missing = await editor.text(["rev-list", "--objects", "--missing=print", "refs/remotes/origin/main"]);
  assert.match(missing, new RegExp(`\\?${engine}`, "u"));
  assert.equal((await editor.snapshot()).records.length, 1);
});

test("publication ignores dirty operator files, includes deletions, and rejects invalid fetched archives", async t => {
  const { editor, clone, git, publisher } = await fixture(t);
  const initial = await publisher.snapshot();
  await writeFile(path.join(clone, "info/regions/region/region.json"), "uncommitted invalid draft");
  await editor.publish();
  assert.equal((await publisher.snapshot()).revision, initial.revision);
  assert.equal((await publisher.snapshot()).target, initial.target, "Repeated publication is a no-op");
  await git("add", "."); await git("commit", "-m", "Invalid remote content"); await git("push", "origin", "main");
  await assert.rejects(editor.publish());
  assert.equal((await publisher.snapshot()).revision, initial.revision);
  await writeFile(path.join(clone, "info/regions/region/region.json"), jsonText({ names, color: "#336699" }));
  await mkdir(path.join(clone, "info/villages/village"), { recursive: true });
  await writeFile(path.join(clone, "info/villages/village/village.json"), jsonText({ names, region: "region", subregion: null, latitude: 40, longitude: 22 }));
  await writeFile(path.join(clone, "info/villages/village/info.en.md"), "Notes\n");
  await git("add", "."); await git("commit", "-m", "Repair and add village"); await git("push", "origin", "main");
  await editor.publish();
  const before = await publisher.snapshot();
  assert.equal(before.archive.regions[0].villages.length, 1);
  const snapshot = await editor.snapshot();
  const request = await proposal(editor, { base: snapshot.revision, change: { action: "delete", path: "villages/village" } });
  await editor.submit(request);
  assert.equal((await publisher.snapshot()).archive.regions[0].villages.length, 0);
  assert.equal(before.archive.regions[0].villages.length, 1, "Existing readers retain a complete old snapshot");
});

test("CLI and editor share publication code and update the same live snapshot", async t => {
  const { root, clone, git, publisher, options } = await fixture(t);
  await writeFile(path.join(clone, "info/regions/region/region.json"), jsonText({ names: { ...names, en: "From laptop" }, color: "#336699" }));
  await git("add", "."); await git("commit", "-m", "Laptop content"); await git("push", "origin", "main");
  await writeFile(path.join(clone, "info/regions/region/region.json"), "do not publish this dirty file");
  const child = spawn(process.execPath, [new URL("../server/update-info.js", import.meta.url).pathname], {
    env: { ...process.env, CONTENT_REMOTE: options.remote, EDITOR_STATE_DIR: path.join(root, "state"), LIVE_INFO_DIR: publisher.directory },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, output);
  assert.equal((await publisher.snapshot()).archive.regions[0].name, "From laptop");
  assert.equal(await readFile(path.join(clone, "info/regions/region/region.json"), "utf8"), "do not publish this dirty file");
});

test("kernel lock is released when its owning application dies", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dance-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "content.lock");
  const script = `import { acquireLock } from ${JSON.stringify(new URL("../server/state.js", import.meta.url).href)}; await acquireLock(process.argv[1]); console.log("ready");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, lock], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  await assert.rejects(acquireLock(lock), error => error.status === 423);
  child.kill("SIGKILL"); await once(child, "close");
  let release;
  for (let attempt = 0; attempt < 40 && !release; attempt++) {
    try { release = await acquireLock(lock); } catch (error) { if (error.status !== 423) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.ok(release, "A crashed application must not leave a stale lock");
  await release();
});

test("malformed requests, preview tampering, and unpublished code files never reach main", async t => {
  const { editor, git } = await fixture(t);
  const { revision } = await editor.snapshot();
  await assert.rejects(editor.preview({ base: revision, change: { action: "create", path: "../app.js" } }));
  const request = await proposal(editor, update(revision));
  await assert.rejects(editor.submit({ ...request, previewHash: "0".repeat(64) }), /preview/u);
  assert.equal(await git("ls-remote", "origin", "refs/heads/main"), `${revision}\trefs/heads/main`);
  request.submissionId = randomUUID();
  const result = await editor.submit(request);
  await git("fetch", "origin");
  assert.equal(await git("show", `${result.commit}:app.js`), "original code");
});

test("village moves preserve exact unchanged Markdown bytes", async t => {
  const { editor, clone, git } = await fixture(t);
  for (const folder of ["regions/second", "subregions/area", "villages/stable"]) await mkdir(path.join(clone, "info", folder), { recursive: true });
  const metadata = { names, region: "region", subregion: null, latitude: 40, longitude: 22 };
  await writeFile(path.join(clone, "info/regions/second/region.json"), jsonText({ names, color: "#123456" }));
  await writeFile(path.join(clone, "info/subregions/area/subregion.json"), jsonText({ names, region: "second" }));
  await writeFile(path.join(clone, "info/villages/stable/village.json"), jsonText(metadata));
  await writeFile(path.join(clone, "info/villages/stable/info.en.md"), "\nNotes\n\n");
  await git("add", "."); await git("commit", "-m", "Village and destination"); await git("push", "origin", "main");
  const { revision } = await editor.snapshot();
  const request = await proposal(editor, { base: revision, change: { action: "update", path: "villages/stable", metadata: { ...metadata, region: "second", subregion: "area" }, info: { en: "Notes", el: "" } } });
  const result = await editor.submit(request);
  await git("fetch", "origin");
  assert.equal(await git("diff", "--name-only", revision, result.commit), "info/villages/stable/village.json");
  const live = await editor.publisher.snapshot();
  assert.equal(await readFile(path.join(editor.publisher.directory, live.target, "info/villages/stable/info.en.md"), "utf8"), "\nNotes\n\n");
});
