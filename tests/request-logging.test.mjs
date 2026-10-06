import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, stat, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../deploy/disable-request-logs.py", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dance-logs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "nginx"), '#!/bin/sh\n[ "$1" = "-t" ]\nexit "${FAIL_NGINX:-0}"\n');
  await chmod(path.join(bin, "nginx"), 0o755);
  const site = path.join(root, "site");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  return { site, run: extra => exec("python3", [script, site], { env: { ...env, ...extra } }) };
}

test("existing HTTPS and redirect sites disable all explicit log destinations without changing TLS or routing", async t => {
  const { site, run } = await fixture(t);
  const routing = 'location / { proxy_pass http://127.0.0.1:8000; set $example "quoted { # ; }"; }';
  await writeFile(site, `# server { is a comment
server {
  listen 443 ssl; # managed by Certbot
  server_name dances.example.org;
  ssl_certificate /etc/letsencrypt/live/dances.example.org/fullchain.pem;
  access_log /var/log/nginx/access.log combined;
  error_log /var/log/nginx/error.log;
  error_log syslog:server=unix:/dev/log;
  location /api/ {
    access_log
      /var/log/nginx/api.log combined;
    error_log stderr;
    proxy_pass http://127.0.0.1:8000;
  }
  ${routing}
}
server { listen 80; return 301 https://$host$request_uri; }
`, { mode: 0o640 });
  const before = await stat(site);
  await run();
  const result = await readFile(site, "utf8");
  assert.doesNotMatch(result, /\/var\/log|syslog:|error_log stderr/u);
  assert.equal((result.match(/access_log off;/gu) || []).length, 3);
  assert.equal((result.match(/error_log \/dev\/null;/gu) || []).length, 3);
  assert.match(result, /listen 443 ssl; # managed by Certbot/u);
  assert.match(result, /ssl_certificate \/etc\/letsencrypt\/live\/dances.example.org\/fullchain.pem;/u);
  assert.ok(result.includes(routing));
  assert.match(result, /return 301 https:\/\/\$host\$request_uri;/u);
  const after = await stat(site);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
  await run();
  assert.equal(await readFile(site, "utf8"), result);
});

test("failed Nginx validation restores the original site", async t => {
  const { site, run } = await fixture(t);
  const original = "server { listen 443 ssl; access_log /var/log/nginx/access.log; }\n";
  await writeFile(site, original);
  await assert.rejects(run({ FAIL_NGINX: "1" }));
  assert.equal(await readFile(site, "utf8"), original);
});

test("malformed configuration remains untouched", async t => {
  const { site, run } = await fixture(t);
  const original = "server { listen 80; # missing closing brace\n";
  await writeFile(site, original);
  await assert.rejects(run());
  assert.equal(await readFile(site, "utf8"), original);
});
