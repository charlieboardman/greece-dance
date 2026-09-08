import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ContentError, parseArchiveFiles } from "../lib/archive.js";
import { changeFiles, checkConflict, digest, fileChanges } from "../lib/changes.js";

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
  constructor({ directory, remote, branch = "main", credentials = async () => ({}), pullRequests }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(branch) || branch.includes("..") || branch.endsWith("/")) throw new Error("Invalid canonical branch.");
    this.directory = directory; this.remote = remote; this.branch = branch;
    this.credentials = credentials; this.pullRequests = pullRequests; this.queue = Promise.resolve();
  }
  exclusive(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  async git(args, options = {}) {
    return runGit(["--git-dir", this.directory, ...args], options);
  }
  async text(args, options) { return (await this.git(args, options)).output.toString("utf8").trim(); }
  async fetch() {
    await mkdir(this.directory, { recursive: true });
    await runGit(["init", "--bare", this.directory]);
    this.auth = await this.credentials();
    await this.git(["fetch", "--no-tags", this.remote, `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`], { env: this.auth });
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
    return this.exclusive(async () => {
      const revision = await this.fetch();
      return { revision, records: parseArchiveFiles(await this.files(revision)).records };
    });
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
    return this.exclusive(async () => {
      const { changes, previewHash } = await this.prepare(request);
      return { changes, previewHash };
    });
  }
  submit(request) {
    return this.exclusive(async () => {
      if (!request || !/^[a-f0-9-]{36}$/u.test(request.submissionId || "") || !/^[a-f0-9]{64}$/u.test(request.previewHash || "")) {
        throw new ContentError("Preview this change before submitting.");
      }
      const branch = `editor/${request.submissionId}`;
      const fingerprint = digest(JSON.stringify({ base: request.base, change: request.change, previewHash: request.previewHash }));
      const marker = `Editor request: ${fingerprint}`;
      await this.fetch();
      const remoteRef = await this.text(["ls-remote", this.remote, `refs/heads/${branch}`], { env: this.auth });
      let commit;
      if (remoteRef) {
        await this.git(["fetch", "--no-tags", this.remote, `refs/heads/${branch}`], { env: this.auth });
        commit = remoteRef.split(/\s/u)[0];
        if (!(await this.text(["log", "-1", "--format=%B", commit])).split("\n").includes(marker)) {
          throw new ContentError("This submission ID was already used for a different edit. Preview again.", 409);
        }
      } else {
        const prepared = await this.prepare(request);
        if (prepared.previewHash !== request.previewHash) throw new ContentError("The proposed changes differ from your preview. Preview again.", 409);
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
          commit = await this.text(["commit-tree", tree, "-p", prepared.latest], {
            env, input: `${request.change.action}: ${request.change.path}\n\n${marker}\n`
          });
          // Only a new proposal branch is pushed. main and the deployed checkout are untouched.
          await this.git(["push", this.remote, `${commit}:refs/heads/${branch}`], { env: this.auth });
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
      try {
        const pullRequest = await this.pullRequests.ensure({ branch, base: this.branch,
          title: `${request.change.action}: ${request.change.path}`,
          body: `Proposed through the password-protected archive editor.\n\nChanges are limited to archive content in \`info/\`. Merge after reviewing to include them in the next deployment.` });
        return { ...pullRequest, branch, commit };
      } catch {
        const error = new ContentError("The proposal branch was pushed, but the pull request could not be opened. Retry this same submission to recover it.", 502);
        error.branch = branch;
        throw error;
      }
    });
  }
}
