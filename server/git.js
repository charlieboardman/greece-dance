import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ContentError, parseArchiveFiles } from "../lib/archive.js";
import { changeFiles, checkConflict, digest, fileChanges } from "../lib/changes.js";
import { acquireLock, withLock, readJSON, writeJSON } from "./state.js";

export function runGit(args, { cwd, env = {}, input = "", okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = []; let length = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (data) => { length += data.length; if (length > 24 * 1024 * 1024) child.kill("SIGKILL"); else chunks.push(data); });
    // Git errors may contain credentials or local paths; never pass stderr to API responses.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!okCodes.includes(code)) reject(new ContentError(`Git ${args[0] === "--git-dir" ? args[2] : args[0]} failed (exit ${code}). Check repository access and retry.`, 502));
      else resolve({ output: Buffer.concat(chunks), code });
    });
    child.stdin.end(input);
  });
}

export class GitEditor {
  constructor({ directory, remote, branch = "main", credentials = async () => ({}), publisher = null }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(branch) || branch.includes("..") || branch.endsWith("/")) throw new Error("Invalid canonical branch.");
    this.directory = directory; this.remote = remote; this.branch = branch;
    this.credentials = credentials; this.publisher = publisher; this.queue = Promise.resolve();
    this.state = path.dirname(directory);
    this.lockfile = path.join(this.state, "content.lock");
  }
  exclusive(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  async git(args, options = {}) {
    return runGit(["--git-dir", this.directory, ...args], { ...options, env: { ...this.auth, ...options.env } });
  }
  async text(args, options) { return (await this.git(args, options)).output.toString("utf8").trim(); }
  async fetch() {
    await mkdir(this.directory, { recursive: true });
    await runGit(["init", "--bare", this.directory]);
    this.auth = await this.credentials();
    // Also upgrades existing workspaces. Existing objects are retained; future
    // fetches omit blobs until info/ needs them. Lazy fetches inherit auth too.
    await this.git(["config", "remote.origin.url", this.remote]);
    await this.git(["config", "remote.origin.promisor", "true"]);
    await this.git(["config", "remote.origin.partialclonefilter", "blob:none"]);
    await this.git(["fetch", "--filter=blob:none", "--no-tags", "origin", `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`]);
    return this.text(["rev-parse", `refs/remotes/origin/${this.branch}`]);
  }
  async files(revision) {
    if (!/^[a-f0-9]{40}$/u.test(revision)) throw new ContentError("Invalid archive revision.");
    const tree = (await this.git(["ls-tree", "-rz", revision, "--", "info/"])).output.toString("utf8");
    const entries = tree.split("\0").filter(Boolean).map((line) => {
      const match = /^(\d+) blob ([a-f0-9]+)\tinfo\/(.+)$/u.exec(line);
      if (!match || match[1] !== "100644") throw new ContentError("info/ may contain only ordinary text files.");
      return { oid: match[2], name: match[3] };
    });
    // Fetch missing current info blobs in one request, instead of allowing
    // cat-file to make a separate network round trip for every missing file.
    const objects = await this.text(["rev-list", "--objects", "--missing=print", "--no-object-names", "--no-walk", revision]);
    const missing = new Set(objects.split("\n").filter(line => line.startsWith("?")).map(line => line.slice(1)));
    const wanted = [...new Set(entries.map(entry => entry.oid))].filter(oid => missing.has(oid));
    if (wanted.length) await this.git(["fetch", "--no-tags", "--no-write-fetch-head", "--filter=blob:none", "origin", "--stdin"], { input: wanted.join("\n") + "\n" });
    const data = (await this.git(["cat-file", "--batch"], { input: entries.map((e) => e.oid).join("\n") + (entries.length ? "\n" : "") })).output;
    let offset = 0;
    const files = new Map();
    for (const entry of entries) {
      const newline = data.indexOf(10, offset);
      const header = data.subarray(offset, newline).toString("utf8");
      const size = Number(header.split(" ")[2]);
      if (!Number.isInteger(size) || size < 0 || size > 128 * 1024) throw new ContentError("Invalid archive blob.");
      offset = newline + 1;
      files.set(entry.name, data.subarray(offset, offset + size).toString("utf8"));
      offset += size + 1;
    }
    parseArchiveFiles(files);
    return files;
  }
  snapshot() {
    return this.exclusive(() => withLock(this.lockfile, async () => {
      const revision = await this.fetch();
      return { revision, records: parseArchiveFiles(await this.files(revision)).records };
    }));
  }
  async prepare(request) {
    if (!request || !/^[a-f0-9]{40}$/u.test(request.base) || !request.change) throw new ContentError("Reload the archive before editing.");
    const latest = await this.fetch();
    const ancestry = await this.git(["merge-base", "--is-ancestor", request.base, latest], { okCodes: [0, 1, 128] });
    if (ancestry.code !== 0) throw new ContentError("The archive history changed. Reload before submitting.", 409);
    const baseFiles = await this.files(request.base);
    // Validate intent against the version actually shown in the form first.
    changeFiles(baseFiles, request.change);
    const latestFiles = latest === request.base ? baseFiles : await this.files(latest);
    checkConflict(baseFiles, latestFiles, request.change);
    const after = changeFiles(latestFiles, request.change);
    const changes = fileChanges(latestFiles, after);
    if (!changes.length) throw new ContentError("There are no changes to submit.");
    return { latest, changes, previewHash: digest(JSON.stringify(changes)) };
  }
  preview(request) {
    return this.exclusive(() => withLock(this.lockfile, async () => {
      const { changes, previewHash } = await this.prepare(request);
      return { changes, previewHash };
    }));
  }
  async commit(prepared, message) {
    const temporary = await mkdtemp(path.join(tmpdir(), "dance-index-"));
    const env = { GIT_INDEX_FILE: path.join(temporary, "index"), GIT_AUTHOR_NAME: "Dance archive editor",
      GIT_AUTHOR_EMAIL: "editor@greece-dance.invalid", GIT_COMMITTER_NAME: "Dance archive editor", GIT_COMMITTER_EMAIL: "editor@greece-dance.invalid" };
    try {
      await this.git(["read-tree", prepared.latest], { env });
      for (const change of prepared.changes) {
        if (change.after === null) await this.git(["update-index", "-z", "--index-info"], {
          env, input: `0 ${"0".repeat(40)}\t${change.path}\0`
        });
        else {
          const oid = await this.text(["hash-object", "-w", "--stdin"], { input: change.after });
          await this.git(["update-index", "--add", "--cacheinfo", "100644", oid, change.path], { env });
        }
      }
      const tree = await this.text(["write-tree"], { env });
      return await this.text(["commit-tree", tree, "-p", prepared.latest], { env, input: message });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  operationPath(id) {
    if (!/^[a-f0-9-]{36}$/u.test(id || "")) throw new ContentError("Invalid submission ID.");
    return path.join(this.state, "operations", `${id}.json`);
  }
  async record(operation) {
    operation.updatedAt = new Date().toISOString();
    await writeJSON(this.operationPath(operation.submissionId), operation);
    await writeJSON(path.join(this.state, "active.json"), { submissionId: operation.submissionId });
  }
  publicOperation(operation) {
    if (!operation) return null;
    const { submissionId, state, stage, commit, revision, error, updatedAt } = operation;
    return { submissionId, state, stage, commit, revision, error, updatedAt };
  }
  async status(id) {
    let release;
    let busy = false;
    try { release = await acquireLock(this.lockfile); }
    catch (error) { if (error.status !== 423) throw error; busy = true; }
    try {
      const active = await readJSON(path.join(this.state, "active.json"));
      const operation = id || active?.submissionId;
      const activeOperation = active && await readJSON(this.operationPath(active.submissionId));
      return { busy: busy || activeOperation?.state === "processing", operation: this.publicOperation(operation ? await readJSON(this.operationPath(operation)) : null) };
    } finally { if (release) await release(); }
  }
  async recover() {
    const active = await readJSON(path.join(this.state, "active.json"));
    if (!active || (await readJSON(this.operationPath(active.submissionId)))?.state !== "processing") return;
    return withLock(this.lockfile, async () => {
      const active = await readJSON(path.join(this.state, "active.json"));
      const operation = active && await readJSON(this.operationPath(active.submissionId));
      if (operation?.state === "processing") return this.submitLocked(operation.request);
    });
  }
  publish() {
    return withLock(this.lockfile, () => this.publisher.publish(this));
  }
  submit(request) {
    // Do not queue competing submissions: the caller keeps its draft and waits.
    return withLock(this.lockfile, async () => {
      const active = await readJSON(path.join(this.state, "active.json"));
      const operation = active && await readJSON(this.operationPath(active.submissionId));
      if (operation?.state === "processing" && operation.submissionId !== request?.submissionId) {
        throw new ContentError("An interrupted save is recovering. Please wait; your draft has been kept.", 423);
      }
      return this.submitLocked(request);
    });
  }
  async submitLocked(request) {
    if (!request || !/^[a-f0-9-]{36}$/u.test(request.submissionId || "") || !/^[a-f0-9]{64}$/u.test(request.previewHash || "")) {
      throw new ContentError("Preview this change before submitting.");
    }
    const fingerprint = digest(JSON.stringify({ base: request.base, change: request.change, previewHash: request.previewHash }));
    const marker = `Editor request: ${fingerprint}`;
    const submissionMarker = `Editor submission: ${request.submissionId}`;
    let operation = await readJSON(this.operationPath(request.submissionId));
    if (operation && operation.fingerprint !== fingerprint) throw new ContentError("This submission ID was already used for a different edit. Preview again.", 409);
    if (operation?.state === "completed") return this.publicOperation(operation);
    operation = { ...operation, submissionId: request.submissionId, fingerprint, request, state: "processing", stage: "checking", error: null };
    await this.record(operation);
    try {
      let commit;
      // Normal non-force pushes act as compare-and-swap on main. Revalidate
      // against the originally loaded version after every competing push.
      for (let attempt = 0; attempt < 3; attempt++) {
        const latest = await this.fetch();
        const existing = await this.text(["log", latest, "--format=%H", "--fixed-strings", `--grep=${submissionMarker}`]);
        if (existing) {
          commit = existing.split("\n").find(Boolean);
          const message = (await this.text(["log", "-1", "--format=%B", commit])).split("\n");
          if (!message.includes(marker) || !message.includes(submissionMarker)) throw new ContentError("This submission ID was already used for a different edit.", 409);
          break;
        }
        if (operation.commit) throw new ContentError("The saved commit was removed from the canonical history. Review the archive before saving again.", 409);
        const prepared = await this.prepare(request);
        if (prepared.previewHash !== request.previewHash) throw new ContentError("The proposed changes differ from your preview. Preview again.", 409);
        commit = await this.commit(prepared, `${request.change.action}: ${request.change.path}\n\n${submissionMarker}\n${marker}\n`);
        operation.stage = "pushing";
        await this.record(operation);
        try { await this.git(["push", "origin", `${commit}:refs/heads/${this.branch}`]); break; }
        catch (error) { if (attempt === 2) throw error; commit = null; }
      }
      operation.commit = commit;
      operation.stage = "publishing";
      await this.record(operation);
      if (!this.publisher) throw new Error("Content publication is not configured.");
      const published = await this.publisher.publish(this, { requiredCommit: commit });
      operation.revision = published.revision;
      operation.state = "completed"; operation.stage = "published";
      await this.record(operation);
      return this.publicOperation(operation);
    } catch (error) {
      operation.state = "failed";
      operation.error = operation.commit
        ? "Saved to GitHub, but publication is pending. Retry this same save to finish publishing."
        : error instanceof ContentError ? error.message : "Save confirmation failed. Retry this same save to check GitHub and recover it.";
      await this.record(operation);
      throw new ContentError(operation.error, operation.commit ? 502 : error.status || 502);
    }
  }
}
