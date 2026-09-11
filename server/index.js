import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { GitEditor } from "./git.js";
import { githubIntegration } from "./github.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const production = process.env.NODE_ENV === "production";
let editor = null;
if (process.env.EDITOR_ENABLED === "true") {
  const integration = githubIntegration({ appId: process.env.GITHUB_APP_ID,
    installationId: process.env.GITHUB_INSTALLATION_ID, repository: process.env.GITHUB_REPOSITORY || "",
    privateKey: await readFile(process.env.GITHUB_PRIVATE_KEY_FILE, "utf8") });
  editor = new GitEditor({ ...integration, directory: path.resolve(process.env.EDITOR_STATE_DIR || ".state", "repository.git"),
    branch: process.env.CONTENT_BRANCH || "main" });
}
let revision = "development";
try { revision = (await readFile(path.join(root, ".release-sha"), "utf8")).trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
const app = await createApp({ root, editor, production, revision,
  passwordHash: process.env.EDITOR_PASSWORD_HASH, sessionSecret: process.env.SESSION_SECRET,
  origin: process.env.APP_ORIGIN || "http://localhost:8000" });
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";
const server = app.listen(port, host, () => console.log(`Dance archive listening on http://${host}:${port} (${revision})`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
});
