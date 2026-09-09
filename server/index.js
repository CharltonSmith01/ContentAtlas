import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  UPLOAD_DIR,
  listProjects,
  getProject,
  saveProject,
  deleteProject,
  imageFilesIn,
  deleteUnreferencedImages,
} from "./db.js";

const PORT = Number(process.env.PORT || 3001);
const DIST_DIR = path.join(process.cwd(), "dist");
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * Password required for any destructive operation. Lives here rather than in the
 * client so it is never shipped in the JS bundle and cannot be skipped by
 * calling the API directly.
 */
const DELETE_PASSWORD = process.env.DELETE_PASSWORD || "TenDelete";

function passwordOk(req) {
  const supplied = req.get("x-delete-password") ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(DELETE_PASSWORD);
  // Constant-time compare, and equal-length buffers so timingSafeEqual won't throw.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Ids of every page, screen and hotspot in a project document. */
function collectIds(data) {
  const ids = { pages: new Set(), screens: new Set(), hotspots: new Set() };
  for (const page of data?.pages ?? []) {
    ids.pages.add(page.id);
    for (const screen of page.screens ?? []) {
      ids.screens.add(screen.id);
      for (const hotspot of screen.hotspots ?? []) ids.hotspots.add(hotspot.id);
    }
  }
  return ids;
}

/**
 * True if `after` drops any page, screen or hotspot that `before` had.
 * Pages, screens and hotspots are deleted by PUTting a smaller project rather
 * than via their own endpoints, so this is what makes those deletions
 * password-gated too.
 */
function removesContent(before, after) {
  const a = collectIds(before);
  const b = collectIds(after);
  for (const kind of ["pages", "screens", "hotspots"]) {
    for (const id of a[kind]) if (!b[kind].has(id)) return true;
  }
  return false;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));

/* ---------- images ---------- */

// Content-hashed filenames, so these are immutable and safe to cache hard.
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    immutable: true,
    maxAge: "1y",
    fallthrough: false,
    index: false,
    dotfiles: "deny",
  })
);

// The client posts the already-resized image as a raw binary body.
app.post(
  "/api/images",
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "25mb" }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "expected a raw image body" });
    }
    const ext = MIME_EXT[req.get("content-type")?.split(";")[0]];
    if (!ext) return res.status(415).json({ error: "unsupported image type" });

    const hash = crypto.createHash("sha256").update(req.body).digest("hex").slice(0, 32);
    const filename = `${hash}.${ext}`;
    const dest = path.join(UPLOAD_DIR, filename);
    // Identical bytes -> same file. Re-uploading a screen costs nothing.
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, req.body);

    res.status(201).json({ url: `/uploads/${filename}` });
  }
);

/* ---------- projects ---------- */

app.get("/api/projects", (_req, res) => {
  res.json(listProjects());
});

app.get("/api/projects/:id", (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: "bad id" });
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "not found" });
  res.json(project);
});

app.put("/api/projects/:id", (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });

  const { data, rev } = req.body ?? {};
  if (!data || typeof data !== "object" || !Array.isArray(data.pages)) {
    return res.status(400).json({ error: "data must be a project object with a pages array" });
  }
  if (data.id !== id) {
    return res.status(400).json({ error: "data.id must match the url id" });
  }
  if (rev != null && !Number.isInteger(rev)) {
    return res.status(400).json({ error: "rev must be an integer" });
  }

  const before = getProject(id);
  const destructive = before ? removesContent(before.data, data) : false;
  if (destructive && !passwordOk(req)) {
    return res.status(403).json({ error: "Incorrect admin password." });
  }

  const result = saveProject(id, data, rev ?? 0);
  if (!result.ok) {
    // Someone else wrote this project since the client last read it.
    return res.status(409).json({
      error: "conflict",
      currentRev: result.currentRev,
      current: getProject(id),
    });
  }

  // Free any screenshot this write orphaned.
  let removedImages = [];
  if (destructive) {
    removedImages = deleteUnreferencedImages(imageFilesIn(before.data));
    if (removedImages.length) {
      console.log(`[copy-atlas] removed ${removedImages.length} orphaned image(s) from disk`);
    }
  }
  res.json({ id, rev: result.rev, removedImages });
});

app.delete("/api/projects/:id", (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "bad id" });
  if (!passwordOk(req)) return res.status(403).json({ error: "Incorrect admin password." });

  const before = getProject(id);
  if (!before) return res.status(404).json({ error: "not found" });

  deleteProject(id);
  const removedImages = deleteUnreferencedImages(imageFilesIn(before.data));
  if (removedImages.length) {
    console.log(`[copy-atlas] removed ${removedImages.length} orphaned image(s) from disk`);
  }
  res.json({ id, removedImages });
});

/* ---------- static frontend (production) ---------- */

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { index: false }));
  // SPA fallback. Registered as plain middleware to sidestep Express 5 wildcard
  // route syntax; anything not matched above gets the app shell.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "payload too large" });
  }
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

app.listen(PORT, () => {
  console.log(`[copy-atlas] api on http://localhost:${PORT}`);
  console.log(`[copy-atlas] uploads -> ${UPLOAD_DIR}`);
  if (!fs.existsSync(DIST_DIR)) {
    console.log(`[copy-atlas] no dist/ yet — run 'npm run dev' for the Vite dev server`);
  }
});
