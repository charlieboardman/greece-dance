import express from "express";
import session from "express-session";
import { rateLimit } from "express-rate-limit";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadArchive, ContentError } from "../lib/archive.js";
import { SessionStore, verifyPassword } from "./auth.js";

export async function createApp({ root = fileURLToPath(new URL("../", import.meta.url)), editor = null,
  passwordHash = "", sessionSecret = "", origin = "http://localhost:8000", production = false,
  revision = "development", loginLimit = 10 } = {}) {
  const archive = await loadArchive(path.join(root, "info"));
  const app = express();
  app.disable("x-powered-by");
  if (production) app.set("trust proxy", "loopback");
  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" }); next();
  });
  app.get("/api/health", (_req, res) => res.set("Cache-Control", "no-store").json({ ok: true, revision }));
  app.get("/api/archive", async (_req, res) => {
    const current = production ? archive : await loadArchive(path.join(root, "info"));
    res.set("Cache-Control", "no-store").json({ regions: current.regions, revision });
  });
  const router = express.Router();
  app.use("/api/editor", router);
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use((_req, _res, next) => {
    if (!editor) throw new ContentError("The editor is not configured on this server.", 503);
    next();
  });
  if (editor) {
    if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/u.test(passwordHash) || sessionSecret.length < 32) {
      throw new Error("Configure a password hash and a session secret of at least 32 characters.");
    }
    if (production && !origin.startsWith("https://")) throw new Error("Production APP_ORIGIN must use HTTPS.");
    router.use(express.json({ limit: "384kb", strict: true }));
    router.use(session({ name: "dance_session", secret: sessionSecret, store: new SessionStore(),
      resave: false, saveUninitialized: false,
      cookie: { httpOnly: true, secure: production, sameSite: "strict", maxAge: 8 * 60 * 60 * 1000, path: "/api/editor" } }));
    router.use((req, _res, next) => {
      if (!["GET", "HEAD"].includes(req.method) && (req.get("Origin") !== origin || !req.is("application/json"))) {
        throw new ContentError("This request must come from the editor on this site.", 403);
      }
      next();
    });
    router.post("/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: loginLimit, standardHeaders: "draft-8", legacyHeaders: false,
      message: { error: "Too many login attempts. Try again in 15 minutes." } }), async (req, res, next) => {
      if (!await verifyPassword(req.body?.password, passwordHash)) throw new ContentError("Incorrect password.", 401);
      req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.authenticated = true;
        req.session.csrf = randomBytes(32).toString("hex");
        req.session.save((saveError) => saveError ? next(saveError) : res.json({ csrf: req.session.csrf }));
      });
    });
    router.use((req, _res, next) => {
      if (!req.session.authenticated) throw new ContentError("Log in to edit the archive.", 401);
      if (!["GET", "HEAD"].includes(req.method)) {
        const supplied = Buffer.from(req.get("X-CSRF-Token") || "");
        const expected = Buffer.from(req.session.csrf);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ContentError("Your editor session changed. Log in again.", 403);
      }
      next();
    });
    router.get("/session", (req, res) => res.json({ csrf: req.session.csrf }));
    router.post("/logout", (req, res, next) => req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("dance_session", { path: "/api/editor" }).json({ ok: true });
    }));
    router.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false,
      message: { error: "Too many editor requests. Try again in a minute." } }));
    router.get("/archive", async (_req, res) => res.json(await editor.snapshot()));
    router.post("/preview", async (req, res) => res.json(await editor.preview(req.body)));
    router.post("/submit", async (req, res) => res.json(await editor.submit(req.body)));
  }
  app.use("/editor", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" }); next();
  }, express.static(path.join(root, "editor"), { dotfiles: "deny" }));
  for (const directory of ["assets", "vendor"]) {
    app.use(`/${directory}`, express.static(path.join(root, directory), { dotfiles: "deny", index: false, maxAge: "1h" }));
  }
  for (const filename of ["index.html", "app.js", "styles.css", "region-presentation.js", "map-styles.js"]) {
    app.get(filename === "index.html" ? ["/", "/index.html"] : `/${filename}`, (_req, res) => res.sendFile(path.join(root, filename)));
  }
  app.use((_req, res) => res.status(404).json({ error: "Not found." }));
  app.use((error, _req, res, _next) => {
    const known = error instanceof ContentError;
    const status = known ? error.status : error.type === "entity.too.large" ? 413 : error instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error("Request failed:", error.message);
    res.status(status).json({ error: known ? error.message : status === 413 ? "The submission is too large." : status === 400 ? "Invalid JSON request." : "The request failed. Check server logs.",
      ...(error.branch ? { branch: error.branch } : {}) });
  });
  return app;
}
