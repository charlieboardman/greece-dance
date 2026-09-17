// Opt-in integration check: a real rootless Podman Compose project, temporary
// credentials/state, local HTTP only, no GitHub or production services.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { hashPassword, verifyPassword } from "../server/password.js";
import { readArchiveFiles } from "../lib/archive.js";
import { runGit } from "../server/git.js";

const image = process.argv[2];
if (!image) throw new Error("Usage: node deploy/check-container.mjs IMAGE_ID_OR_TAG");
const root = await mkdtemp(path.join(os.tmpdir(), "dance-compose-"));
const config = path.join(root, "config"), state = path.join(root, "state");
const content = path.join(root, "content");
await mkdir(config); await mkdir(state); await mkdir(content);
const archiveFiles = await readArchiveFiles(new URL("../info", import.meta.url));
const remote = path.join(state, "fixture-remote.git"), source = path.join(root, "fixture-source");
await runGit(["init", "--bare", "--initial-branch=main", remote]);
await runGit(["--git-dir", remote, "config", "uploadpack.allowFilter", "true"]);
await runGit(["--git-dir", remote, "config", "uploadpack.allowAnySHA1InWant", "true"]);
await runGit(["clone", remote, source]);
const git = async (...args) => (await runGit(args, { cwd: source })).output.toString("utf8").trim();
await git("config", "user.name", "Compose fixture"); await git("config", "user.email", "test@example.test");
for (const [name, text] of archiveFiles) {
  const filename = path.join(source, "info", name);
  await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, text);
}
await git("add", "."); await git("commit", "-m", "Initial content"); await git("push", "origin", "main");
const firstRevision = await git("rev-parse", "HEAD");
const password = randomBytes(16).toString("hex");
const secret = randomBytes(32).toString("hex");
const hash = await hashPassword(password);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
await writeFile(path.join(config, "github-app.pem"), privateKey, { mode: 0o600 });
await writeFile(path.join(config, "app.env"), `NODE_ENV=production
HOST=127.0.0.1
PORT=8000
APP_ORIGIN=https://editor.test
EDITOR_ENABLED=true
EDITOR_STATE_DIR=/var/lib/greece-dance-editor
EDITOR_PASSWORD_HASH=${hash}
SESSION_SECRET=${secret}
GITHUB_REPOSITORY=example/test
GITHUB_APP_ID=1
GITHUB_INSTALLATION_ID=1
GITHUB_PRIVATE_KEY_FILE=/etc/greece-dance/github-app.pem
CONTENT_BRANCH=main
CONTENT_REMOTE=/var/lib/greece-dance-editor/fixture-remote.git
`, { mode: 0o600 });
// Rootless local testing maps the app UID back to this user's temporary files.
const override = path.join(root, "local.yaml");
await writeFile(override, "services:\n  app:\n    userns_mode: keep-id\n");
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const project = `dance-check-${process.pid}`;
const env = { ...process.env, PODMAN_COMPOSE_PROVIDER: "/usr/bin/podman-compose",
  GREECE_DANCE_IMAGE: image, GREECE_DANCE_UID: String(process.getuid()), GREECE_DANCE_GID: String(process.getgid()),
  GREECE_DANCE_CONFIG_DIR: config, GREECE_DANCE_STATE_DIR: state, GREECE_DANCE_CONTENT_DIR: content, GREECE_DANCE_PORT: String(port) };
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("podman", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    child.on("error", reject);
    child.on("close", code => {
      // A provider must never turn file-based secrets into command arguments/logs.
      if ([password, secret, hash, privateKey].some(s => stdout.includes(s) || stderr.includes(s))) {
        reject(new Error("Container tooling exposed a test secret; output suppressed.")); return;
      }
      if (code !== 0) reject(new Error(`Podman failed (${code}): ${stderr}`)); else resolve(stdout.trim());
    });
  });
}
const compose = ["compose", "-p", project, "-f", fileURLToPath(new URL("./compose.yaml", import.meta.url)), "-f", override];
try {
  // Exercise password setup with NODE unset: no host Node/npm dependencies.
  const helperConfig = path.join(root, "helper-config");
  await mkdir(helperConfig);
  await writeFile(path.join(helperConfig, "app.env"), await readFile(path.join(config, "app.env")));
  await writeFile(path.join(helperConfig, "github-app.pem"), privateKey, { mode: 0o600 });
  const passwordFile = path.join(root, "password");
  await writeFile(passwordFile, password, { mode: 0o600 });
  await new Promise((resolve, reject) => {
    const child = spawn("bash", [fileURLToPath(new URL("../setup.sh", import.meta.url)),
      "--skip-install", "--hostname", "165.227.25.230", "--password-file", passwordFile, "--disable-editor"],
      { env: { ...process.env, NODE: "", GREECE_DANCE_ETC: helperConfig, GREECE_DANCE_NGINX: path.join(root, "absent-nginx") },
        stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { output += c; });
    child.on("error", reject);
    child.on("close", code => {
      if ([password, secret, hash, privateKey].some(s => output.includes(s))) reject(new Error("Setup exposed a test secret; output suppressed."));
      else if (code !== 0) reject(new Error(`Container password setup failed: ${output}`));
      else resolve();
    });
  });
  const helperEnv = await readFile(path.join(helperConfig, "app.env"), "utf8");
  assert.ok(await verifyPassword(password, helperEnv.match(/^EDITOR_PASSWORD_HASH=(.+)$/mu)[1]));
  assert.match(helperEnv, /^APP_ORIGIN=https:\/\/165-227-25-230\.sslip\.io$/mu);
  await run([...compose, "up", "-d"]);
  const id = await run([...compose, "ps", "-q"]);
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { healthy = (await (await fetch(`${base}/api/health`)).json()).ok === true; } catch {}
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(healthy, "Container health check");
  assert.equal((await (await fetch(`${base}/api/archive`)).json()).revision, firstRevision, "Fresh startup initializes the empty mount from the local remote");
  const regionFile = [...archiveFiles.keys()].find(name => name.startsWith("regions/"));
  const region = JSON.parse(archiveFiles.get(regionFile)); region.names.en = "Compose content update";
  await writeFile(path.join(source, "info", regionFile), JSON.stringify(region));
  await git("add", "."); await git("commit", "-m", "Update content only"); await git("push", "origin", "main");
  const secondRevision = await git("rev-parse", "HEAD");
  await run([...compose, "run", "--rm", "--no-deps", "app", "node", "--env-file=/etc/greece-dance/app.env", "server/update-info.js"]);
  const updatedResponse = await fetch(`${base}/api/archive`);
  const updatedArchive = await updatedResponse.json();
  if (updatedArchive.revision !== secondRevision) {
    console.error(await run(["exec", id, "node", "--input-type=module", "-e", `
      import { stat, readlink, readdir } from 'node:fs/promises';
      const root = '/var/lib/greece-dance-content';
      console.log('runtime uid', process.getuid());
      for (const name of ['', '/current', '/versions']) {
        try { const s = await stat(root + name); console.log(name, s.uid, s.gid, s.mode.toString(8)); }
        catch(e) { console.log(name, e.code); }
      }
      try { console.log('current target', await readlink(root + '/current')); console.log(await readdir(root + '/current')); }
      catch(e) { console.log('read error', e.code); }
    `]));
  }
  assert.equal(updatedArchive.revision, secondRevision, `CLI refreshes live content without a restart: HTTP ${updatedResponse.status} ${JSON.stringify(updatedArchive.error || "")}`);
  assert.equal(await run([...compose, "ps", "-q"]), id, "Content publication retains the same running container");
  assert.equal((await fetch(base)).status, 200);
  const range = await fetch(`${base}/assets/basemaps/srtm-relief/greece-srtm-relief.pmtiles`, { headers: { Range: "bytes=0-126" } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 127);
  const response = await fetch(`${base}/api/editor/login`, { method: "POST",
    headers: { Origin: "https://editor.test", "X-Forwarded-Proto": "https", "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /; Secure/u);
  await run(["exec", id, "node", "--input-type=module", "-e", `
    import { writeFileSync } from 'node:fs';
    writeFileSync('/var/lib/greece-dance-editor/persistence-check', 'retained');
    try { writeFileSync('/app/index.html', 'bad'); process.exit(1); }
    catch (e) { if (!['EROFS','EACCES'].includes(e.code)) throw e; }
  `]);
  const inspected = JSON.parse(await run(["inspect", id]))[0];
  assert.equal(inspected.Config.Env.some(value => value.startsWith("SESSION_SECRET=")), false);
  assert.match(await run(["exec", id, "node", "--version"]), /^v24\./u);
  await run([...compose, "down"]);
  await run([...compose, "up", "-d"]);
  const restarted = await run([...compose, "ps", "-q"]);
  assert.equal(await run(["exec", restarted, "cat", "/var/lib/greece-dance-editor/persistence-check"]), "retained");
  assert.equal((await (await fetch(`${base}/api/archive`)).json()).revision, secondRevision);
  console.log("Compose check passed: Node 24, live content without restart, persistent content/state, read-only app, HTTPS editor cookie, and file-based credentials.");
} finally {
  try { await run([...compose, "down"]); } finally { await rm(root, { recursive: true, force: true }); }
}
