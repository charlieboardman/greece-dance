import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import session from "express-session";

const scrypt = promisify(scryptCallback);
export async function hashPassword(password) {
  if (password.length === 0) throw new Error("Enter a nonempty password.");
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 1024 || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/u.test(encoded || "")) return false;
  const [, salt, hash] = encoded.split(":");
  return timingSafeEqual(await scrypt(password, salt, 64), Buffer.from(hash, "hex"));
}

// One process, bounded sessions, no persistent content database. Restarting logs editors out.
export class SessionStore extends session.Store {
  constructor() { super(); this.sessions = new Map(); }
  prune() {
    for (const [key, entry] of this.sessions) if (entry.expires <= Date.now()) this.sessions.delete(key);
  }
  get(id, callback) {
    this.prune(); callback(null, this.sessions.get(id)?.value || null);
  }
  set(id, value, callback = () => {}) {
    this.prune();
    if (this.sessions.size >= 500 && !this.sessions.has(id)) return callback(new Error("Too many sessions."));
    this.sessions.set(id, { value, expires: new Date(value.cookie.expires).getTime() }); callback();
  }
  destroy(id, callback = () => {}) { this.sessions.delete(id); callback(); }
  touch(id, value, callback = () => {}) { this.set(id, value, callback); }
}
