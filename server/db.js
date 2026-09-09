import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "copy-atlas.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS projects (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    rev        INTEGER NOT NULL DEFAULT 1,
    data       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS projects_updated_at ON projects (updated_at DESC);
`);

const stmt = {
  list: db.prepare(
    `SELECT id, name, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC`
  ),
  get: db.prepare(`SELECT id, rev, data FROM projects WHERE id = ?`),
  getRev: db.prepare(`SELECT rev FROM projects WHERE id = ?`),
  insert: db.prepare(
    `INSERT INTO projects (id, name, rev, data, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?)`
  ),
  update: db.prepare(
    `UPDATE projects SET name = ?, rev = ?, data = ?, updated_at = ?
     WHERE id = ? AND rev = ?`
  ),
  del: db.prepare(`DELETE FROM projects WHERE id = ?`),
  allImageRefs: db.prepare(`SELECT data FROM projects`),
};

export function listProjects() {
  return stmt.list.all();
}

/** @returns {{id:string, rev:number, data:object} | null} */
export function getProject(id) {
  const row = stmt.get.get(id);
  if (!row) return null;
  return { id: row.id, rev: row.rev, data: JSON.parse(row.data) };
}

/**
 * Optimistic-concurrency write.
 * `expectedRev` of 0 (or null) means "this is a create".
 * @returns {{ok:true, rev:number} | {ok:false, conflict:true, currentRev:number}}
 */
export function saveProject(id, data, expectedRev) {
  const now = Date.now();
  const name = typeof data.name === "string" ? data.name : "Untitled";
  const json = JSON.stringify(data);
  const existing = stmt.getRev.get(id);

  if (!existing) {
    stmt.insert.run(id, name, json, data.createdAt ?? now, now);
    return { ok: true, rev: 1 };
  }

  // A create against an id that already exists, or a stale rev, is a conflict.
  if (!expectedRev || existing.rev !== expectedRev) {
    return { ok: false, conflict: true, currentRev: existing.rev };
  }

  const nextRev = existing.rev + 1;
  const res = stmt.update.run(name, nextRev, json, now, id, expectedRev);
  if (res.changes === 0) {
    // Lost a race between the read above and this write.
    return { ok: false, conflict: true, currentRev: stmt.getRev.get(id)?.rev ?? 0 };
  }
  return { ok: true, rev: nextRev };
}

export function deleteProject(id) {
  return stmt.del.run(id).changes > 0;
}

const UPLOAD_REF_RE = /\/uploads\/([A-Za-z0-9._-]+)/g;

/**
 * Every /uploads/<file> still referenced by any project.
 * Upload filenames are content hashes, so two projects can legitimately point at
 * the same file — never delete one without checking this first.
 */
export function referencedImageFiles() {
  const refs = new Set();
  for (const row of stmt.allImageRefs.all()) {
    for (const m of row.data.matchAll(UPLOAD_REF_RE)) refs.add(m[1]);
  }
  return refs;
}

/** The /uploads/<file> names appearing anywhere in one project document. */
export function imageFilesIn(data) {
  const files = new Set();
  for (const m of JSON.stringify(data).matchAll(UPLOAD_REF_RE)) files.add(m[1]);
  return files;
}

/**
 * Delete each candidate file that no project references any more.
 * Call with the images a project held *before* a destructive write; anything
 * still in use (including by a different project) is left alone.
 * @returns {string[]} files actually removed from disk
 */
export function deleteUnreferencedImages(candidates) {
  if (!candidates?.size && !candidates?.length) return [];
  const referenced = referencedImageFiles();
  const removed = [];
  for (const name of candidates) {
    if (referenced.has(name)) continue;
    // Defend against a crafted name escaping the upload dir.
    const full = path.join(UPLOAD_DIR, path.basename(name));
    if (path.dirname(full) !== UPLOAD_DIR) continue;
    try {
      fs.unlinkSync(full);
      removed.push(name);
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`[copy-atlas] could not unlink ${name}:`, err.message);
    }
  }
  return removed;
}

export default db;
