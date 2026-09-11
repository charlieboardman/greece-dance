import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const launch = fileURLToPath(new URL("../deploy/launch.sh", import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dance-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const config = path.join(root, "app.env");
  await writeFile(config, "EDITOR_ENABLED=true\nSESSION_SECRET=preserved\n", { mode: 0o640 });
  const site = path.join(root, "nginx.conf");
  await writeFile(site, "server {}\n");
  // All service, network and certificate actions are local hooks.
  for (const command of ["systemctl", "nginx", "certbot", "curl"]) {
    const script = path.join(bin, command);
    await writeFile(script, `#!/usr/bin/env bash
set -eu
printf '%s %s\\n' '${command}' "$*" >> "$TEST_LOG"
if [[ '${command}' == certbot ]]; then
  grep -q '^EDITOR_ENABLED=false$' "$GREECE_DANCE_ETC/app.env"
  [[ "\u0024{FAIL_CERT:-}" != 1 ]]
fi
if [[ '${command}' == systemctl && "$*" == 'start greece-dance-update.service' && "\u0024{FAIL_DEPLOY:-}" == 1 ]]; then exit 1; fi
if [[ '${command}' == curl ]]; then
  if [[ "\u0024{FAIL_HTTPS:-}" == 1 && "$*" == *https://* ]]; then exit 1; fi
  echo '{"ok":true}'
fi
`);
    await chmod(script, 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    GREECE_DANCE_ETC: root, GREECE_DANCE_NGINX: site,
    GREECE_DANCE_NGINX_ENABLED: path.join(root, "enabled"), TEST_LOG: path.join(root, "log") };
  async function run(extra = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [launch, "165-227-25-230.sslip.io"], { env: { ...env, ...extra } });
      let output = "";
      child.stdout.on("data", c => { output += c; });
      child.stderr.on("data", c => { output += c; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, output }));
    });
  }
  return { config, env, run };
}

test("launch provisions HTTPS before enabling the editor and is rerunnable", async t => {
  const { config, env, run } = await fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = await run();
    assert.equal(result.code, 0, result.output);
    assert.match(await readFile(config, "utf8"), /^EDITOR_ENABLED=true$/mu);
    assert.match(await readFile(config, "utf8"), /^SESSION_SECRET=preserved$/mu);
  }
  const log = await readFile(env.TEST_LOG, "utf8");
  assert.ok(log.indexOf("certbot --nginx") < log.indexOf("enable --now greece-dance-update.timer"));
  assert.match(log, /enable --now certbot.timer/u);
});

for (const failure of ["FAIL_CERT", "FAIL_DEPLOY", "FAIL_HTTPS"]) {
  test(`launch can recover from ${failure} without enabling editor prematurely`, async t => {
    const { config, env, run } = await fixture(t);
    const failed = await run({ [failure]: "1" });
    assert.notEqual(failed.code, 0);
    assert.match(await readFile(config, "utf8"), /^EDITOR_ENABLED=false$/mu);
    assert.doesNotMatch(await readFile(env.TEST_LOG, "utf8"), /enable --now greece-dance-update.timer/u);
    const retried = await run();
    assert.equal(retried.code, 0, retried.output);
  });
}
