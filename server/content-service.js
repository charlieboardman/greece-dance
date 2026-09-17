import path from "node:path";
import { readFile } from "node:fs/promises";
import { GitEditor } from "./git.js";
import { githubIntegration } from "./github.js";
import { PublishedArchive } from "./publisher.js";

export async function contentService(env = process.env) {
  const state = path.resolve(env.EDITOR_STATE_DIR || ".state");
  let integration;
  if (env.CONTENT_REMOTE) integration = { remote: env.CONTENT_REMOTE };
  else if (env.GITHUB_PRIVATE_KEY_FILE) integration = githubIntegration({ appId: env.GITHUB_APP_ID,
    installationId: env.GITHUB_INSTALLATION_ID, repository: env.GITHUB_REPOSITORY || "",
    privateKey: await readFile(env.GITHUB_PRIVATE_KEY_FILE, "utf8") });
  else {
    const repository = env.GITHUB_REPOSITORY || "charlieboardman/greece-dance";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("Invalid content repository.");
    integration = { remote: `https://github.com/${repository}.git` };
  }
  const publisher = new PublishedArchive(path.resolve(env.LIVE_INFO_DIR || path.join(state, "published")));
  const editor = new GitEditor({ ...integration, directory: path.join(state, "repository.git"),
    branch: env.CONTENT_BRANCH || "main", publisher });
  return { editor, publisher };
}
