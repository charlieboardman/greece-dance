import session from "express-session";
export { hashPassword, verifyPassword } from "./password.js";

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
