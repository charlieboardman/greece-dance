import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const setup = fileURLToPath(new URL("../setup.sh", import.meta.url));
const pem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" }
}).privateKey;

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [setup, ...args], {
      env: { ...process.env, ...extraEnv, NODE: process.execPath },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dance-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const etc = path.join(root, "etc");
  const nginx = path.join(root, "nginx.conf");
  await mkdir(etc);
  await writeFile(path.join(etc, "app.env"), await readFile(new URL("../deploy/app.env.example", import.meta.url)));
  await writeFile(nginx, await readFile(new URL("../deploy/nginx.conf", import.meta.url)));
  const key = path.join(root, "app.pem");
  const password = path.join(root, "password");
  await writeFile(key, pem);
  await writeFile(password, "correct horse battery");
  await chmod(password, 0o600);
  const env = { GREECE_DANCE_ETC: etc, GREECE_DANCE_NGINX: nginx };
  const args = ["--skip-install", "--app-id", "42", "--installation-id", "99", "--pem", key, "--password-file", password];
  return { root, etc, nginx, key, password, env, args };
}

test("setup.sh stores the GitHub App key and editor secrets without printing the password", async (t) => {
  const { etc, nginx, env, args } = await fixture(t);
  const result = await run([...args, "--hostname", "dances.example.org"], env);
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /correct horse battery/u);
  const config = await readFile(path.join(etc, "app.env"), "utf8");
  assert.match(config, /^GITHUB_APP_ID=42$/mu);
  assert.match(config, /^GITHUB_INSTALLATION_ID=99$/mu);
  assert.match(config, new RegExp(`^GITHUB_PRIVATE_KEY_FILE=${path.join(etc, "github-app.pem")}$`, "mu"));
  assert.match(config, /^EDITOR_PASSWORD_HASH=scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/mu);
  assert.match(config, /^SESSION_SECRET=[a-f0-9]{64}$/mu);
  assert.match(config, /^APP_ORIGIN=https:\/\/dances\.example\.org$/mu);
  assert.match(config, /^EDITOR_ENABLED=false$/mu);
  assert.match(await readFile(path.join(etc, "github-app.pem"), "utf8"), /BEGIN RSA PRIVATE KEY/u);
  assert.match(await readFile(nginx, "utf8"), /server_name dances\.example\.org;/u);
});

test("setup.sh can enable the editor and refuses to clobber an existing key", async (t) => {
  const { etc, env, args, key } = await fixture(t);
  let result = await run([...args, "--enable-editor"], env);
  assert.equal(result.code, 0, result.output);
  assert.match(await readFile(path.join(etc, "app.env"), "utf8"), /^EDITOR_ENABLED=true$/mu);
  await writeFile(key, `${pem}\n`);
  result = await run(args, env);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /already exists/u);
  result = await run([...args, "--force", "--disable-editor"], env);
  assert.equal(result.code, 0, result.output);
  assert.match(await readFile(path.join(etc, "app.env"), "utf8"), /^EDITOR_ENABLED=false$/mu);
});

test("setup.sh can enable the editor later without asking for the key again", async (t) => {
  const { etc, env, args } = await fixture(t);
  let result = await run(args, env);
  assert.equal(result.code, 0, result.output);
  result = await run(["--skip-install", "--enable-editor"], env);
  assert.equal(result.code, 0, result.output);
  assert.match(await readFile(path.join(etc, "app.env"), "utf8"), /^EDITOR_ENABLED=true$/mu);
});

test("setup.sh rejects a file that is not a private key", async (t) => {
  const { env, args, key } = await fixture(t);
  await writeFile(key, "not a key\n");
  const result = await run(args, env);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /private key/u);
});

test("setup accepts a droplet IPv4 and keeps GitHub App configuration", async (t) => {
  const { etc, nginx, env, args } = await fixture(t);
  const result = await run([...args, "--hostname", "165.227.25.230"], env);
  assert.equal(result.code, 0, result.output);
  assert.match(await readFile(path.join(etc, "app.env"), "utf8"), /^APP_ORIGIN=https:\/\/165-227-25-230\.sslip\.io$/mu);
  assert.match(await readFile(nginx, "utf8"), /server_name 165-227-25-230\.sslip\.io;/u);
  assert.match(await readFile(path.join(etc, "app.env"), "utf8"), /^GITHUB_APP_ID=42$/mu);
});

test("setup rejects invalid IPv4 addresses", async (t) => {
  const { env, args } = await fixture(t);
  const result = await run([...args, "--hostname", "999.227.25.230"], env);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Invalid IPv4/u);
});
