import { mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadContent } from "../lib/content.js";
import { syncDirectory } from "./state.js";

// Mount this entire directory, not its current symlink. All generations contain
// ordinary JSON/Markdown and remain immutable once published.
export class PublishedContent {
  constructor(directory) { this.directory = directory; this.cached = null; }

  async snapshot() {
    const target = await readlink(path.join(this.directory, "current"));
    if (!/^versions\/[a-f0-9-]+$/u.test(target)) throw new Error("Invalid published content pointer.");
    if (this.cached?.target === target) return this.cached;
    const folder = path.join(this.directory, target);
    const revision = (await readFile(path.join(folder, "revision"), "utf8")).trim();
    if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("Invalid published revision.");
    const content = await loadContent(path.join(folder, "info"));
    this.cached = { target, revision, content };
    return this.cached;
  }

  // Caller holds the shared content lock across fetch, validation and switch.
  async publish(source, { requiredCommit } = {}) {
    const revision = await source.fetch();
    if (requiredCommit) {
      const accepted = await source.git(["merge-base", "--is-ancestor", requiredCommit, revision], { okCodes: [0, 1] });
      if (accepted.code !== 0) throw new Error("The saved commit is no longer on the canonical branch.");
    }
    const files = await source.files(revision);
    try { if ((await this.snapshot()).revision === revision) return { revision }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(path.join(this.directory, "versions"), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(this.directory, ".staging-"));
    const pointer = path.join(this.directory, `.current-${randomUUID()}`);
    try {
      const directories = new Set([staging]);
      // Extract only the validated info/ tree of the fetched commit. Never copy
      // an operator's working tree (which may include uncommitted edits).
      for (const [name, text] of files) {
        const filename = path.join(staging, "info", name);
        await mkdir(path.dirname(filename), { recursive: true });
        for (let folder = path.dirname(filename); folder !== staging; folder = path.dirname(folder)) directories.add(folder);
        await writeFile(filename, text, { mode: 0o600, flush: true });
      }
      await loadContent(path.join(staging, "info"));
      await writeFile(path.join(staging, "revision"), revision + "\n", { mode: 0o600, flush: true });
      for (const folder of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(folder);
      const target = `versions/${revision}-${randomUUID()}`;
      await rename(staging, path.join(this.directory, target));
      await syncDirectory(path.join(this.directory, "versions"));
      await symlink(target, pointer);
      await rename(pointer, path.join(this.directory, "current"));
      await syncDirectory(this.directory);
      await this.snapshot();
      return { revision };
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(pointer, { force: true });
    }
  }
}
