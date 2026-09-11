import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, chmod, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { runGit } from "../server/git.js";

function run(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
  });
}

test("deployment skips unchanged commits, retains live content on failure, and can roll back", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dance-deployment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clone = path.join(root, "source"); const remote = path.join(root, "remote.git"); const deploy = path.join(root, "deployment");
  await runGit(["init", "--bare", "--initial-branch=main", remote]);
  await runGit(["clone", remote, clone]);
  const git = async (...args) => (await runGit(args, { cwd: clone })).output.toString("utf8").trim();
  await git("config", "user.name", "Deployment test"); await git("config", "user.email", "test@example.test");
  await mkdir(path.join(clone, "scripts"));
  const pkg = { name: "deployment-fixture", version: "1.0.0", private: true, scripts: {
    validate: "node scripts/validate.js", test: "node scripts/test.js", smoke: "node scripts/test.js"
  } };
  await writeFile(path.join(clone, "package.json"), JSON.stringify(pkg));
  await writeFile(path.join(clone, "package-lock.json"), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { "": { name: pkg.name, version: pkg.version } } }));
  await writeFile(path.join(clone, "scripts/validate.js"), 'if (require("fs").existsSync("invalid")) process.exit(1);\n');
  await writeFile(path.join(clone, "scripts/test.js"), 'console.log("fixture checks passed");\n');
  async function publish() { await git("add", "-A"); await git("commit", "-m", "Update fixture"); await git("push", "origin", "main"); return git("rev-parse", "HEAD"); }
  const first = await publish();
  await mkdir(deploy);
  const hook = path.join(root, "restart");
  await writeFile(hook, '#!/usr/bin/env bash\nset -eu\nif [[ -f "$DEPLOY_ROOT/current/fail-start" ]]; then exit 1; fi\nif [[ -f "$DEPLOY_ROOT/current/wrong-health" ]]; then echo wrong > "$DEPLOY_ROOT/running-sha"; else cat "$DEPLOY_ROOT/current/.release-sha" > "$DEPLOY_ROOT/running-sha"; fi\necho restart >> "$DEPLOY_ROOT/restarts"\n');
  await chmod(hook, 0o755);
  const health = createServer(async (_req, res) => {
    let revision = ""; try { revision = (await readFile(path.join(deploy, "running-sha"), "utf8")).trim(); } catch {}
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, revision }));
  });
  health.listen(0, "127.0.0.1"); await once(health, "listening");
  t.after(() => new Promise((resolve) => { health.closeAllConnections(); health.close(resolve); }));
  const env = { ...process.env, DEPLOY_CONFIG: path.join(root, "absent.env"), DEPLOY_ROOT: deploy,
    DEPLOY_REPOSITORY: remote, DEPLOY_RESTART_HOOK: hook, DEPLOY_HEALTH_ATTEMPTS: "1",
    DEPLOY_HEALTH_URL: `http://127.0.0.1:${health.address().port}/api/health` };
  const update = fileURLToPath(new URL("../deploy/update.sh", import.meta.url));
  const rollback = fileURLToPath(new URL("../deploy/rollback.sh", import.meta.url));
  let result = await run(update, env); assert.equal(result.code, 0, result.output);
  assert.equal(await readlink(path.join(deploy, "current")), path.join(deploy, "releases", first));
  assert.equal((await stat(path.join(deploy, "releases", first))).mode & 0o777, 0o755, "The separate runtime account can traverse the release directory.");
  result = await run(update, env); assert.equal(result.code, 0, result.output); assert.match(result.output, /Already deployed/u);
  assert.equal((await readFile(path.join(deploy, "restarts"), "utf8")).trim(), "restart");
  await writeFile(path.join(clone, "invalid"), "bad content"); await publish();
  result = await run(update, env); assert.notEqual(result.code, 0, result.output);
  assert.equal((await readFile(path.join(deploy, "running-sha"), "utf8")).trim(), first);
  await rm(path.join(clone, "invalid")); await writeFile(path.join(clone, "fail-start"), "bad startup"); await publish();
  result = await run(update, env); assert.notEqual(result.code, 0, result.output); assert.match(result.output, /restoring the previous release/u);
  assert.equal(await readlink(path.join(deploy, "current")), path.join(deploy, "releases", first));
  await rm(path.join(clone, "fail-start")); await writeFile(path.join(clone, "wrong-health"), "wrong revision"); await publish();
  result = await run(update, env); assert.notEqual(result.code, 0, result.output);
  assert.equal((await readFile(path.join(deploy, "running-sha"), "utf8")).trim(), first);
  await rm(path.join(clone, "wrong-health")); await writeFile(path.join(clone, "notes"), "valid update"); const second = await publish();
  result = await run(update, env); assert.equal(result.code, 0, result.output);
  assert.equal((await readFile(path.join(deploy, "running-sha"), "utf8")).trim(), second);
  assert.equal(await readlink(path.join(deploy, "previous")), path.join(deploy, "releases", first));
  result = await run(rollback, env); assert.equal(result.code, 0, result.output);
  assert.equal((await readFile(path.join(deploy, "running-sha"), "utf8")).trim(), first);
});
