import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContentError } from "../lib/archive.js";

export async function readJSON(filename) {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function syncDirectory(directory) {
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}

export async function writeJSON(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, filename);
    await syncDirectory(path.dirname(filename));
  } finally { await rm(temporary, { force: true }); }
}

// Kernel flock is shared by the API and CLI containers. Closing the pipe (also
// on a parent crash) exits the holder and releases the lock; no stale PID files.
export async function acquireLock(filename) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const child = spawn("flock", ["-n", "-E", "75", filename, process.execPath, "-e",
    'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); process.stdout.write("locked\\n");'],
  { stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => {});
  const ended = new Promise(resolve => child.once("close", resolve));
  await new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("Could not start content lock.")));
    child.stdout.once("data", resolve);
    child.once("close", code => reject(new ContentError(code === 75
      ? "A change is processing. Please wait; your draft has been kept."
      : "Could not acquire content lock.", code === 75 ? 423 : 503)));
  });
  return async () => { child.stdin.end(); await ended; };
}

export async function withLock(filename, task) {
  const release = await acquireLock(filename);
  try { return await task(); } finally { await release(); }
}
