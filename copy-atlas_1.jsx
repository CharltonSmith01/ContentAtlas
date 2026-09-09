import { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, Upload, X, ChevronRight, ChevronDown, Trash2, Layers, FileText,
  PenLine, Loader2, CheckCircle2, AlertCircle, Folder, Lock, History
} from "lucide-react";

/* ---------- constants ---------- */

const STATUS = {
  needs_copy: {
    label: "Needs Copy", dot: "bg-amber-500",
    badge: "bg-amber-50 text-amber-700 border-amber-300",
    box: "border-amber-400",
    header: "bg-amber-400", headerText: "text-slate-900",
    border: "border-amber-400", check: "bg-amber-500",
  },
  drafted: {
    label: "Drafted", dot: "bg-sky-500",
    badge: "bg-sky-50 text-sky-700 border-sky-300",
    box: "border-sky-400",
    header: "bg-blue-600", headerText: "text-white",
    border: "border-blue-600", check: "bg-blue-600",
  },
  approved: {
    label: "Approved", dot: "bg-emerald-500",
    badge: "bg-emerald-50 text-emerald-700 border-emerald-300",
    box: "border-emerald-400",
    header: "bg-emerald-700", headerText: "text-white",
    border: "border-emerald-700", check: "bg-emerald-600",
  },
};
const STATUS_ORDER = ["needs_copy", "drafted", "approved"];
const STAGE_TITLES = {
  needs_copy: "Design requirements",
  drafted: "Content copy",
  approved: "Sign-off",
};
const STAGE_WAITING_LABEL = {
  needs_copy: "Waiting on Design",
  drafted: "Waiting on Content",
  approved: "Waiting on Approver",
};

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/* ---------- hotspot helpers (stage lock / derived status / history) ---------- */

function stageEntries(h, stage) {
  return (h.history || []).filter((e) => e.stage === stage).sort((a, b) => b.timestamp - a.timestamp);
}
function hasStage(h, stage) { return stageEntries(h, stage).length > 0; }
function latestStageEntry(h, stage) { return stageEntries(h, stage)[0]; }
function deriveStatus(h) {
  if (hasStage(h, "approved")) return "approved";
  if (hasStage(h, "drafted")) return "drafted";
  return "needs_copy";
}

/* ---------- migration: legacy shapes -> current shape ---------- */

function normalizeHotspot(h) {
  if (h.history) return h;
  const history = [];
  if (h.status === "drafted" || h.status === "approved") {
    history.push({ id: uid(), stage: "needs_copy", name: "Unknown", timestamp: h.updatedAt || Date.now(), action: "submitted" });
    history.push({ id: uid(), stage: "drafted", name: "Unknown", timestamp: h.updatedAt || Date.now(), action: "submitted" });
  }
  if (h.status === "approved") {
    history.push({ id: uid(), stage: "approved", name: "Unknown", timestamp: h.updatedAt || Date.now(), action: "submitted" });
  }
  const { status, ...rest } = h;
  return { ...rest, history };
}

function normalizeProject(project) {
  let p = project;
  if (!p.pages) {
    p = {
      ...p,
      pages: p.screens?.length ? [{ id: uid(), name: "Screens", screens: p.screens }] : [{ id: uid(), name: "Page 1", screens: [] }],
      screens: undefined,
    };
  }
  return {
    ...p,
    stakeholders: p.stakeholders || { designer: "", projectManager: "", content: "" },
    pages: p.pages.map((pg) => ({
      ...pg,
      screens: pg.screens.map((s) => ({ ...s, hotspots: (s.hotspots || []).map(normalizeHotspot) })),
    })),
  };
}

/* ---------- image resize helper (keeps uploads small) ---------- */

/**
 * Downscale to `maxDim` and re-encode as JPEG. Resolves a Blob, not a data URL —
 * the bytes go to the server as a real upload and the project JSON only ever
 * holds the resulting `/uploads/...` path.
 */
function resizeImageFile(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => (blob ? resolve({ blob, width, height }) : reject(new Error("encode failed"))),
          "image/jpeg",
          quality
        );
      };
      img.onerror = () => reject(new Error("could not decode that image"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("could not read that file"));
    reader.readAsDataURL(file);
  });
}

/* ---------- api client ---------- */

class ConflictError extends Error {
  constructor(current) {
    super("This project was changed by someone else.");
    this.name = "ConflictError";
    this.current = current;
  }
}

/** The admin password was missing or wrong on a destructive request. */
class AuthError extends Error {
  constructor(message) {
    super(message || "Incorrect admin password.");
    this.name = "AuthError";
  }
}

async function request(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    throw new ConflictError(body.current ?? null);
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    throw new AuthError(body.error);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${options.method || "GET"} ${url} failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

/** Only sent on destructive requests; the server holds the real password. */
const authHeader = (password) => (password ? { "X-Delete-Password": password } : {});

const api = {
  listProjects: () => request("/api/projects"),
  getProject: (id) => request(`/api/projects/${id}`),
  saveProject: (project, rev, password) =>
    request(`/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeader(password) },
      body: JSON.stringify({ data: project, rev }),
    }),
  deleteProject: (id, password) =>
    request(`/api/projects/${id}`, { method: "DELETE", headers: authHeader(password) }),
  uploadImage: async (blob) => {
    const { url } = await request("/api/images", {
      method: "POST",
      headers: { "Content-Type": blob.type || "image/jpeg" },
      body: blob,
    });
    return url;
  },
};

/* ---------- project data helpers (work on the pages tree) ---------- */

function allScreens(project) {
  return project.pages.flatMap((pg) => pg.screens);
}
function allHotspotsOf(project) {
  return allScreens(project).flatMap((s) => s.hotspots);
}
function findPageForScreen(project, screenId) {
  return project.pages.find((pg) => pg.screens.some((s) => s.id === screenId));
}
function mapScreen(project, screenId, updater) {
  return {
    ...project,
    pages: project.pages.map((pg) => ({
      ...pg,
      screens: pg.screens.map((s) => (s.id === screenId ? updater(s) : s)),
    })),
  };
}

/* ---------- accessible confirm dialog ---------- */

/**
 * Deletion is gated behind the admin password. The password is verified by the
 * server, so a wrong entry keeps this dialog open with an error rather than
 * optimistically closing.
 */
function ConfirmDialog({ state, onCancel, onConfirm }) {
  const passwordRef = useRef(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!state) return;
    setPassword("");
    setError(null);
    setBusy(false);
    passwordRef.current?.focus();
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e) => { if (e.key === "Escape" && !busy) onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, onCancel, busy]);

  if (!state) return null;

  const submit = async () => {
    if (busy) return;
    if (!password.trim()) {
      setError("Enter the admin password to delete.");
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password);
    } catch (err) {
      // Wrong password (or the write failed) — stay open so the entry can be retried.
      setError(err?.message || "Could not delete.");
      setBusy(false);
      setPassword("");
      passwordRef.current?.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-desc" className="bg-white rounded-xl shadow-xl max-w-sm w-full p-5">
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-slate-900 mb-1.5">{state.title}</h2>
        <p id="confirm-dialog-desc" className="text-sm text-slate-500 mb-4 leading-relaxed">{state.message}</p>

        <label htmlFor="confirm-dialog-password" className="block text-xs font-medium text-slate-500 mb-1">
          Admin password
        </label>
        <input
          id="confirm-dialog-password"
          ref={passwordRef}
          type="password"
          value={password}
          autoComplete="off"
          disabled={busy}
          onChange={(e) => { setPassword(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          aria-invalid={!!error}
          aria-describedby={error ? "confirm-dialog-error" : undefined}
          className={`w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-1 disabled:bg-slate-50 ${
            error ? "border-red-300 focus:ring-red-400" : "border-slate-200 focus:ring-orange-400"
          }`}
        />
        {error && (
          <p id="confirm-dialog-error" role="alert" className="flex items-center gap-1 text-xs text-red-600 mt-1.5">
            <AlertCircle size={12} className="shrink-0" /> {error}
          </p>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button type="button" disabled={busy} onClick={onCancel} className="text-sm font-medium px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-300">Cancel</button>
          <button type="button" disabled={busy} onClick={submit} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-red-300">
            {busy && <Loader2 className="animate-spin" size={13} />}
            {busy ? "Deleting…" : state.confirmLabel || "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- main app ---------- */

export default function CopyAtlas() {
  const [booting, setBooting] = useState(true);
  const [index, setIndex] = useState([]);
  const [cache, setCache] = useState({});
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [currentProjectId, setCurrentProjectId] = useState(null);
  const [currentScreenId, setCurrentScreenId] = useState(null);
  const [selectedHotspotId, setSelectedHotspotId] = useState(null);
  const [drawMode, setDrawMode] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [newPageFor, setNewPageFor] = useState(null);
  const [newPageName, setNewPageName] = useState("");
  const [saveState, setSaveState] = useState("idle");
  const [saveError, setSaveError] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const pendingUploadPage = useRef(null);
  const fileInputRef = useRef(null);
  // Server revision per project id, for optimistic concurrency on write.
  const revs = useRef({});

  // Mirror of `cache` that is safe to read synchronously from queued writes;
  // reading `cache` there would capture a stale render closure.
  const cacheRef = useRef({});
  // Serializes writes so each one sends a revision the server still considers
  // current. Without this, two quick edits race and the loser 409s.
  const writeChain = useRef(Promise.resolve());

  const currentProject = currentProjectId ? cache[currentProjectId] : null;

  const putCache = useCallback((id, project) => {
    cacheRef.current = { ...cacheRef.current, [id]: project };
    setCache(cacheRef.current);
  }, []);

  const dropCache = useCallback((id) => {
    const next = { ...cacheRef.current };
    delete next[id];
    cacheRef.current = next;
    setCache(next);
  }, []);

  const refreshIndex = useCallback(async () => {
    const idx = await api.listProjects();
    setIndex(idx);
    return idx;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await refreshIndex();
      } catch (err) {
        setBootError(err.message);
      } finally {
        setBooting(false);
      }
    })();
  }, [refreshIndex]);

  /**
   * Write a project to the server, then reconcile local state.
   * On a 409 the server's copy wins: we adopt it and tell the user, rather than
   * silently clobbering whatever the other person just did.
   */
  /**
   * Write a project to the server, then reconcile local state.
   *
   * `build` may be a project object, or a function receiving the latest cached
   * project — use the function form (with `projectId`) for anything queued
   * behind another write, so it composes onto that write's result instead of
   * clobbering it.
   *
   * On a 409 the server's copy wins: we adopt it and say so, rather than
   * silently overwriting whatever the other person just did.
   */
  const persistProject = useCallback((build, projectId, password) => {
    // Resolve and apply optimistically *now*, synchronously: the UI must reflect
    // the edit on this render, not a microtask later. Only the network write is
    // queued. Because cacheRef is updated here, a later build() in the same tick
    // still composes onto this result.
    const project = typeof build === "function"
      ? build(cacheRef.current[projectId] ?? null)
      : build;
    if (!project) return Promise.resolve(false);

    const rollback = cacheRef.current[project.id];
    putCache(project.id, project);
    setSaveState("saving");
    setSaveError(null);

    const run = writeChain.current.then(async () => {
      try {
        const { rev } = await api.saveProject(project, revs.current[project.id] ?? 0, password);
        revs.current[project.id] = rev;
        setSaveState("saved");
        setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1200);
        setIndex((idx) =>
          idx.some((p) => p.id === project.id)
            ? idx.map((p) => (p.id === project.id ? { ...p, name: project.name, updatedAt: Date.now() } : p))
            : [{ id: project.id, name: project.name, updatedAt: Date.now() }, ...idx]
        );
        return true;
      } catch (err) {
        if (err instanceof AuthError) {
          // Undo the optimistic delete and let the confirm dialog report it,
          // rather than raising a page-level banner for a mistyped password.
          if (rollback) putCache(project.id, rollback);
          setSaveState("idle");
          throw err;
        }
        if (err instanceof ConflictError && err.current) {
          revs.current[project.id] = err.current.rev;
          putCache(project.id, normalizeProject(err.current.data));
          setSaveState("conflict");
          setSaveError("Someone else edited this project. Your view has been refreshed with their changes.");
        } else {
          // Roll back so the UI never shows an edit the server rejected.
          if (rollback) putCache(project.id, rollback);
          setSaveState("error");
          setSaveError(err.message);
        }
        return false;
      }
    });
    writeChain.current = run.then(
      () => {},
      () => {}
    );
    return run;
  }, [putCache]);

  const ensureLoaded = useCallback(async (id) => {
    if (cacheRef.current[id]) return cacheRef.current[id];
    try {
      const { data, rev } = await api.getProject(id);
      revs.current[id] = rev;
      const normalized = normalizeProject(data);
      putCache(id, normalized);
      return normalized;
    } catch {
      return null;
    }
  }, [putCache]);

  const askConfirm = (opts) => setConfirmState(opts);
  const closeConfirm = () => setConfirmState(null);
  // Let the error escape to the dialog: on a bad password it stays open.
  const runConfirm = async (password) => {
    await confirmState?.onConfirm?.(password);
    setConfirmState(null);
  };

  /* ---- project actions ---- */

  const toggleExpand = async (id, e) => {
    e?.stopPropagation();
    await ensureLoaded(id);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectProject = async (id) => {
    const p = await ensureLoaded(id);
    if (!p) return;
    setCurrentProjectId(id);
    setExpandedIds((prev) => new Set(prev).add(id));
    setSelectedHotspotId(null);
    setCurrentScreenId(allScreens(p)[0]?.id ?? null);
  };

  const createProject = async () => {
    const name = newProjectName.trim();
    if (!name) return;
    const project = { id: uid(), name, brief: "", stakeholders: { designer: "", projectManager: "", content: "" }, pages: [{ id: uid(), name: "Page 1", screens: [] }], createdAt: Date.now() };
    if (!(await persistProject(project))) return;
    setCurrentProjectId(project.id);
    setExpandedIds((prev) => new Set(prev).add(project.id));
    setCurrentScreenId(null);
    setNewProjectName("");
    setShowNewProject(false);
  };

  const deleteProject = (id, name, e) => {
    e.stopPropagation();
    askConfirm({
      title: `Delete “${name}”?`,
      message: "This removes the project and every page, screen, and copy requirement inside it. This can't be undone.",
      confirmLabel: "Delete project",
      onConfirm: async (password) => {
        // Throws on a wrong password; the dialog catches it and stays open.
        await api.deleteProject(id, password);
        delete revs.current[id];
        setIndex((idx) => idx.filter((p) => p.id !== id));
        setCache((c) => { const n = { ...c }; delete n[id]; return n; });
        if (currentProjectId === id) { setCurrentProjectId(null); setCurrentScreenId(null); }
      },
    });
  };

  const updateProjectMeta = async (patch) => {
    // persistProject keeps the sidebar index in sync, including renames.
    await persistProject({ ...currentProject, ...patch });
  };

  /* ---- page actions ---- */

  const addPage = async () => {
    const name = newPageName.trim();
    if (!name || !currentProject) return;
    const updated = { ...currentProject, pages: [...currentProject.pages, { id: uid(), name, screens: [] }] };
    await persistProject(updated);
    setNewPageName("");
    setNewPageFor(null);
  };

  const renamePage = async (pageId, name) => {
    const updated = { ...currentProject, pages: currentProject.pages.map((pg) => (pg.id === pageId ? { ...pg, name } : pg)) };
    await persistProject(updated);
  };

  const deletePage = (pageId, name, e) => {
    e.stopPropagation();
    askConfirm({
      title: `Delete page “${name}”?`,
      message: "This removes the page and every screen and copy requirement inside it. This can't be undone.",
      confirmLabel: "Delete page",
      onConfirm: async (password) => {
        const removedScreenIds = new Set(currentProject.pages.find((pg) => pg.id === pageId)?.screens.map((s) => s.id));
        const updated = { ...currentProject, pages: currentProject.pages.filter((pg) => pg.id !== pageId) };
        await persistProject(updated, currentProject.id, password);
        if (removedScreenIds.has(currentScreenId)) {
          setCurrentScreenId(allScreens(updated)[0]?.id ?? null);
          setSelectedHotspotId(null);
        }
      },
    });
  };

  /* ---- screen actions ---- */

  const triggerUpload = (pageId) => { pendingUploadPage.current = pageId; fileInputRef.current?.click(); };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const pageId = pendingUploadPage.current;
    if (!file || !currentProject || !pageId) return;

    let image, width, height;
    try {
      setSaveState("saving");
      setSaveError(null);
      const resized = await resizeImageFile(file);
      width = resized.width;
      height = resized.height;
      image = await api.uploadImage(resized.blob);
    } catch (err) {
      setSaveState("error");
      setSaveError(`Upload failed: ${err.message}`);
      return;
    }

    const page = currentProject.pages.find((pg) => pg.id === pageId);
    const screen = { id: uid(), name: `Screen ${page.screens.length + 1}`, image, width, height, hotspots: [] };
    const updated = { ...currentProject, pages: currentProject.pages.map((pg) => (pg.id === pageId ? { ...pg, screens: [...pg.screens, screen] } : pg)) };
    await persistProject(updated);
    setCurrentScreenId(screen.id);
  };

  const renameScreen = async (screenId, name) => {
    await persistProject(mapScreen(currentProject, screenId, (s) => ({ ...s, name })));
  };

  const deleteScreen = (screenId, name, e) => {
    e.stopPropagation();
    askConfirm({
      title: `Delete screen “${name}”?`,
      message: "This removes the screen and every copy requirement placed on it. This can't be undone.",
      confirmLabel: "Delete screen",
      onConfirm: async (password) => {
        const updated = { ...currentProject, pages: currentProject.pages.map((pg) => ({ ...pg, screens: pg.screens.filter((s) => s.id !== screenId) })) };
        await persistProject(updated, currentProject.id, password);
        if (currentScreenId === screenId) {
          setCurrentScreenId(allScreens(updated)[0]?.id ?? null);
          setSelectedHotspotId(null);
        }
      },
    });
  };

  /* ---- hotspot actions ---- */

  const currentScreen = currentProject ? allScreens(currentProject).find((s) => s.id === currentScreenId) || null : null;
  const selectedHotspot = currentScreen?.hotspots.find((h) => h.id === selectedHotspotId) || null;

  const addHotspot = async (rect) => {
    const hotspot = { id: uid(), x: rect.x, y: rect.y, w: rect.w, h: rect.h, label: "New requirement", tone: "", charLimit: "", intent: "", notes: "", finalCopy: "", history: [] };
    const updated = mapScreen(currentProject, currentScreen.id, (s) => ({ ...s, hotspots: [...s.hotspots, hotspot] }));
    await persistProject(updated);
    setSelectedHotspotId(hotspot.id);
    setDrawMode(false);
  };

  const updateHotspot = async (hotspotId, patch) => {
    const updated = mapScreen(currentProject, currentScreen.id, (s) => ({
      ...s,
      hotspots: s.hotspots.map((h) => (h.id === hotspotId ? { ...h, ...patch } : h)),
    }));
    await persistProject(updated);
  };

  /**
   * Apply a stage's field edits and its history entry in a single write.
   * These used to be two calls (onChange then onSubmit); the second was built
   * from pre-edit state, so it raced the first and dropped the history entry.
   */
  const submitStage = async (hotspotId, stage, name, patch = {}) => {
    const screenId = currentScreen.id;
    const projectId = currentProject.id;
    await persistProject((latest) => {
      const project = latest ?? currentProject;
      const screen = allScreens(project).find((s) => s.id === screenId);
      const existing = screen?.hotspots.find((h) => h.id === hotspotId);
      if (!existing) return null;
      const entry = {
        id: uid(),
        stage,
        name,
        timestamp: Date.now(),
        action: hasStage(existing, stage) ? "edited" : "submitted",
      };
      return mapScreen(project, screenId, (s) => ({
        ...s,
        hotspots: s.hotspots.map((h) =>
          h.id === hotspotId
            ? { ...h, ...patch, history: [...(h.history || []), entry] }
            : h
        ),
      }));
    }, projectId);
  };

  const deleteHotspot = (hotspot) => {
    askConfirm({
      title: `Delete “${hotspot.label}”?`,
      message: "This permanently removes this copy requirement and its full history. This can't be undone.",
      confirmLabel: "Delete hotspot",
      onConfirm: async (password) => {
        const updated = mapScreen(currentProject, currentScreen.id, (s) => ({ ...s, hotspots: s.hotspots.filter((h) => h.id !== hotspot.id) }));
        await persistProject(updated, currentProject.id, password);
        setSelectedHotspotId(null);
      },
    });
  };

  /* ---- stats ---- */

  const hotspots = currentProject ? allHotspotsOf(currentProject) : [];
  const stats = STATUS_ORDER.map((key) => ({ key, count: hotspots.filter((h) => deriveStatus(h) === key).length }));
  const total = hotspots.length;

  /* ---------- render ---------- */

  if (booting) {
    return (
      <div className="flex items-center justify-center h-full min-h-96 bg-slate-50">
        <Loader2 className="animate-spin text-slate-400" size={28} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-screen bg-slate-100 text-slate-800" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <ConfirmDialog state={confirmState} onCancel={closeConfirm} onConfirm={runConfirm} />

      <header className="flex items-center justify-between px-6 py-3 text-white shadow-md" style={{ background: "linear-gradient(90deg, #241a35, #2f2148)" }}>
        <div>
          <div className="text-xs tracking-widest text-orange-300 font-semibold">TEN · DESIGN → CONTENT HANDOFF</div>
          <div className="text-lg font-bold tracking-tight">Copy Atlas</div>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-300">
          {saveState === "saving" && <span className="flex items-center gap-1"><Loader2 className="animate-spin" size={12} /> Saving…</span>}
          {saveState === "saved" && <span className="flex items-center gap-1 text-emerald-300"><CheckCircle2 size={12} /> Saved</span>}
          {saveState === "error" && <span className="flex items-center gap-1 text-red-300" title={saveError || ""}><AlertCircle size={12} /> Not saved</span>}
          {saveState === "conflict" && <span className="flex items-center gap-1 text-amber-300" title={saveError || ""}><AlertCircle size={12} /> Refreshed</span>}
          <span className="hidden sm:inline">Shared workspace — visible to all teams</span>
        </div>
      </header>

      {(bootError || saveError) && (
        <div
          role="alert"
          className={`flex items-start gap-2 px-6 py-2.5 text-sm border-b ${
            saveState === "conflict"
              ? "bg-amber-50 border-amber-200 text-amber-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
        >
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <div className="flex-1">
            {bootError ? (
              <>
                <span className="font-semibold">Couldn't reach the server.</span>{" "}
                Your projects aren't loaded — this is not an empty workspace. Check that the API is
                running, then reload. <span className="text-red-600">({bootError})</span>
              </>
            ) : (
              saveError
            )}
          </div>
          {bootError ? (
            <button type="button" onClick={() => window.location.reload()} className="shrink-0 font-medium underline hover:no-underline">
              Reload
            </button>
          ) : (
            <button type="button" aria-label="Dismiss" onClick={() => { setSaveError(null); setSaveState("idle"); }} className="shrink-0 opacity-60 hover:opacity-100">
              <X size={16} />
            </button>
          )}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* left column */}
        <aside className="w-72 shrink-0 bg-white border-r border-slate-200 flex flex-col overflow-y-auto">
          <div className="p-3 border-b border-slate-200 sticky top-0 bg-white z-10">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Projects</span>
              <button type="button" aria-label="Create new project" onClick={() => setShowNewProject((v) => !v)} className="text-slate-400 hover:text-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-300 rounded transition-colors">
                <Plus size={16} />
              </button>
            </div>
            {showNewProject && (
              <div className="flex gap-1">
                <label htmlFor="new-project-name" className="sr-only">Project name</label>
                <input id="new-project-name" autoFocus value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createProject()} placeholder="Project name" className="flex-1 text-sm border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-orange-400" />
                <button type="button" onClick={createProject} className="text-xs bg-slate-800 text-white px-2 rounded hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-orange-300">Add</button>
              </div>
            )}
          </div>

          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />

          <div className="flex-1">
            {index.length === 0 && <div className="p-4 text-xs text-slate-400 leading-relaxed">No projects yet. Create one to get started.</div>}

            {index.map((p) => {
              const isExpanded = expandedIds.has(p.id);
              const isActive = currentProjectId === p.id;
              const proj = cache[p.id];
              return (
                <div key={p.id} className="border-b border-slate-100">
                  <div className={`w-full flex items-center gap-1 group ${isActive ? "bg-orange-50" : "hover:bg-slate-50"}`}>
                    <button type="button" aria-label={isExpanded ? `Collapse ${p.name}` : `Expand ${p.name}`} aria-expanded={isExpanded} onClick={(e) => toggleExpand(p.id, e)} className="text-slate-400 hover:text-slate-700 shrink-0 pl-2 py-2 focus:outline-none focus:ring-2 focus:ring-orange-300 rounded">
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <button type="button" onClick={() => selectProject(p.id)} className="flex items-center gap-1.5 flex-1 min-w-0 py-2 text-left focus:outline-none">
                      <Folder size={13} className={`shrink-0 ${isActive ? "text-orange-500" : "text-slate-400"}`} />
                      <span className={`text-sm font-medium truncate ${isActive ? "text-slate-900" : "text-slate-600"}`}>{p.name}</span>
                    </button>
                    <button type="button" aria-label={`Delete project ${p.name}`} onClick={(e) => deleteProject(p.id, p.name, e)} className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-slate-300 hover:text-red-500 shrink-0 pr-2 py-2 focus:outline-none focus:ring-2 focus:ring-red-300 rounded">
                      <Trash2 size={13} />
                    </button>
                  </div>

                  {isExpanded && proj && (
                    <div className="pb-2">
                      {proj.pages.map((page) => (
                        <div key={page.id} className="pl-4">
                          <div className="flex items-center gap-1 px-2 py-1 group">
                            <FileText size={11} className="text-slate-300 shrink-0" />
                            <label className="sr-only" htmlFor={`page-name-${page.id}`}>Page name</label>
                            <input id={`page-name-${page.id}`} defaultValue={page.name} onBlur={(e) => e.target.value.trim() && e.target.value !== page.name && renamePage(page.id, e.target.value.trim())} className="text-xs font-bold uppercase tracking-wide text-slate-400 bg-transparent flex-1 min-w-0 focus:outline-none focus:text-slate-700" />
                            <button type="button" aria-label={`Upload screen to ${page.name}`} onClick={() => triggerUpload(page.id)} className="text-slate-300 hover:text-orange-500 shrink-0 focus:outline-none focus:ring-2 focus:ring-orange-300 rounded">
                              <Upload size={12} />
                            </button>
                            <button type="button" aria-label={`Delete page ${page.name}`} onClick={(e) => deletePage(page.id, page.name, e)} className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-slate-300 hover:text-red-500 shrink-0 focus:outline-none focus:ring-2 focus:ring-red-300 rounded">
                              <Trash2 size={12} />
                            </button>
                          </div>

                          {page.screens.map((s) => (
                            <div key={s.id} className={`ml-4 flex items-center gap-1 rounded text-sm group/screen ${currentScreenId === s.id ? "bg-slate-800 text-white" : "hover:bg-slate-100 text-slate-600"}`}>
                              <Layers size={12} className="shrink-0 opacity-60 ml-2" />
                              <label className="sr-only" htmlFor={`screen-name-${s.id}`}>Screen name</label>
                              <input
                                id={`screen-name-${s.id}`}
                                defaultValue={s.name}
                                onFocus={() => { setCurrentScreenId(s.id); setSelectedHotspotId(null); }}
                                onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && renameScreen(s.id, e.target.value.trim())}
                                className={`flex-1 min-w-0 bg-transparent text-sm py-1.5 truncate focus:outline-none ${currentScreenId === s.id ? "text-white" : "text-slate-600"}`}
                              />
                              <button type="button" aria-label={`Delete screen ${s.name}`} onClick={(e) => deleteScreen(s.id, s.name, e)} className={`shrink-0 pr-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-red-300 rounded ${currentScreenId === s.id ? "text-slate-400 hover:text-red-300" : "opacity-0 group-hover/screen:opacity-100 focus:opacity-100 text-slate-300 hover:text-red-500"}`}>
                                <Trash2 size={12} />
                              </button>
                            </div>
                          ))}
                          {page.screens.length === 0 && <div className="ml-4 text-xs text-slate-300 px-2 py-1 italic">No screens yet</div>}
                        </div>
                      ))}

                      {newPageFor === p.id ? (
                        <div className="flex gap-1 px-2 pl-4 mt-1">
                          <label className="sr-only" htmlFor="new-page-name">Page name</label>
                          <input id="new-page-name" autoFocus value={newPageName} onChange={(e) => setNewPageName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPage()} placeholder="Page name" className="flex-1 text-xs border border-slate-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-orange-400" />
                          <button type="button" onClick={addPage} className="text-xs bg-slate-800 text-white px-2 rounded hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-orange-300">Add</button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => setNewPageFor(p.id)} className="ml-4 mt-1 flex items-center gap-1 text-xs text-slate-400 hover:text-orange-500 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-orange-300 rounded">
                          <Plus size={11} /> Add page
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* middle column: canvas */}
        <main className="flex-1 min-w-0 overflow-auto p-6">
          {!currentProject && <EmptyState text="Select or create a project to begin." />}
          {currentProject && !currentScreen && <EmptyState text="Upload a screenshot to a page and start placing copy requirements." />}
          {currentScreen && (
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-slate-400">{findPageForScreen(currentProject, currentScreen.id)?.name}</span>
                  <ChevronRight size={13} className="text-slate-300" />
                  <span className="font-semibold">{currentScreen.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawMode((v) => !v)}
                  aria-pressed={drawMode}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full border flex items-center gap-1.5 transition-colors focus:outline-none focus:ring-2 focus:ring-orange-300 ${drawMode ? "bg-orange-500 text-white border-orange-500" : "bg-white text-slate-600 border-slate-300 hover:border-orange-400 hover:text-orange-600"}`}
                >
                  <PenLine size={13} />
                  {drawMode ? "Click & drag on the image…" : "Add copy hotspot"}
                </button>
              </div>
              <ImageCanvas screen={currentScreen} drawMode={drawMode} selectedHotspotId={selectedHotspotId} onSelectHotspot={setSelectedHotspotId} onCreateHotspot={addHotspot} />
            </div>
          )}
        </main>

        {/* right column */}
        <aside className="w-96 shrink-0 bg-white border-l border-slate-200 overflow-y-auto">
          {!currentProject && <EmptyState text="" small />}
          {currentProject && !selectedHotspot && <ProjectOverview project={currentProject} stats={stats} total={total} onUpdateMeta={updateProjectMeta} />}
          {selectedHotspot && (
            <HotspotDetail
              key={selectedHotspot.id}
              hotspot={selectedHotspot}
              onChange={(patch) => updateHotspot(selectedHotspot.id, patch)}
              onSubmitStage={(stage, name, patch) => submitStage(selectedHotspot.id, stage, name, patch)}
              onDelete={() => deleteHotspot(selectedHotspot)}
              onClose={() => setSelectedHotspotId(null)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

/* ---------- sub components ---------- */

function EmptyState({ text, small }) {
  return (
    <div className={`flex flex-col items-center justify-center text-center text-slate-400 ${small ? "p-6" : "h-full min-h-96"}`}>
      <FileText size={small ? 20 : 32} className="mb-2 opacity-50" />
      {text && <p className="text-sm max-w-xs">{text}</p>}
    </div>
  );
}

function ProjectOverview({ project, stats, total, onUpdateMeta }) {
  const [name, setName] = useState(project.name);
  const [brief, setBrief] = useState(project.brief || "");
  const [stakeholders, setStakeholders] = useState(project.stakeholders || { designer: "", projectManager: "", content: "" });

  useEffect(() => {
    setName(project.name);
    setBrief(project.brief || "");
    setStakeholders(project.stakeholders || { designer: "", projectManager: "", content: "" });
  }, [project.id]);

  const pageCount = project.pages.length;
  const screenCount = project.pages.reduce((n, pg) => n + pg.screens.length, 0);

  const commitStakeholder = (key, value) => {
    const next = { ...stakeholders, [key]: value };
    setStakeholders(next);
    onUpdateMeta({ stakeholders: next });
  };

  return (
    <div className="p-5">
      <div className="rounded-xl p-4 mb-4 text-white" style={{ background: "linear-gradient(135deg, #2f2148, #241a35)" }}>
        <div className="text-3xl font-bold">{total}</div>
        <div className="text-xs text-slate-300 mt-0.5">copy hotspots across {pageCount} page{pageCount === 1 ? "" : "s"}, {screenCount} screen{screenCount === 1 ? "" : "s"}</div>
      </div>

      <div className="space-y-2 mb-6">
        {stats.map(({ key, count }) => (
          <div key={key} className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${STATUS[key].dot}`} />
            <span className="text-sm text-slate-600 flex-1">{STATUS[key].label}</span>
            <span className="text-sm font-semibold text-slate-800">{count}</span>
            <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div className={`h-full ${STATUS[key].dot}`} style={{ width: total ? `${(count / total) * 100}%` : "0%" }} />
            </div>
          </div>
        ))}
      </div>

      <label className="block text-xs font-bold uppercase tracking-wide text-slate-400 mb-1" htmlFor="project-name">Project name</label>
      <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== project.name && onUpdateMeta({ name: name.trim() })} className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mb-4 focus:outline-none focus:ring-1 focus:ring-orange-400" />

      <label className="block text-xs font-bold uppercase tracking-wide text-slate-400 mb-1" htmlFor="project-brief">Brief / business need</label>
      <textarea id="project-brief" value={brief} onChange={(e) => setBrief(e.target.value)} onBlur={() => brief !== project.brief && onUpdateMeta({ brief })} rows={5} placeholder="What is this project trying to achieve? What does Product need Design to solve for?" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mb-5 resize-none focus:outline-none focus:ring-1 focus:ring-orange-400" />

      <div className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-2">Stakeholders</div>

      <label className="block text-xs text-slate-500 mb-1" htmlFor="sh-designer">Designer</label>
      <input id="sh-designer" value={stakeholders.designer} onChange={(e) => setStakeholders({ ...stakeholders, designer: e.target.value })} onBlur={(e) => commitStakeholder("designer", e.target.value)} placeholder="Name" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-orange-400" />

      <label className="block text-xs text-slate-500 mb-1" htmlFor="sh-pm">Project Manager</label>
      <input id="sh-pm" value={stakeholders.projectManager} onChange={(e) => setStakeholders({ ...stakeholders, projectManager: e.target.value })} onBlur={(e) => commitStakeholder("projectManager", e.target.value)} placeholder="Name" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-orange-400" />

      <label className="block text-xs text-slate-500 mb-1" htmlFor="sh-content">Content</label>
      <input id="sh-content" value={stakeholders.content} onChange={(e) => setStakeholders({ ...stakeholders, content: e.target.value })} onBlur={(e) => commitStakeholder("content", e.target.value)} placeholder="Name" className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mb-4 focus:outline-none focus:ring-1 focus:ring-orange-400" />

      <p className="text-xs text-slate-400 mt-2 leading-relaxed">Select a hotspot on the screen to view or progress its copy requirements.</p>
    </div>
  );
}

/* ---------- hotspot detail: staged workflow ---------- */

function HotspotDetail({ hotspot, onChange, onSubmitStage, onDelete, onClose }) {
  const status = deriveStatus(hotspot);
  const needsCopyDone = hasStage(hotspot, "needs_copy");
  const draftedDone = hasStage(hotspot, "drafted");
  const approvedDone = hasStage(hotspot, "approved");

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-4">
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${STATUS[status].badge}`}>{STATUS[status].label}</span>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Delete this hotspot" onClick={onDelete} className="text-slate-300 hover:text-red-500 p-1 focus:outline-none focus:ring-2 focus:ring-red-300 rounded"><Trash2 size={15} /></button>
          <button type="button" aria-label="Close hotspot detail" onClick={onClose} className="text-slate-300 hover:text-slate-600 p-1 focus:outline-none focus:ring-2 focus:ring-slate-300 rounded"><X size={16} /></button>
        </div>
      </div>

      <div className="space-y-4">
        <StageOne hotspot={hotspot} locked={needsCopyDone} onChange={onChange} onSubmit={(name, patch) => onSubmitStage("needs_copy", name, patch)} />
        <StageTwo hotspot={hotspot} enabled={needsCopyDone} locked={draftedDone} onChange={onChange} onSubmit={(name, patch) => onSubmitStage("drafted", name, patch)} />
        <StageThree hotspot={hotspot} enabled={draftedDone} locked={approvedDone} onSubmit={(name) => onSubmitStage("approved", name)} />
      </div>

      <VersionHistory history={hotspot.history} />
    </div>
  );
}

/* ---------- stage card shell: waiting / active / locked ---------- */

function WaitingCard({ num, stageKey, message }) {
  return (
    <section className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3.5">
      <div className="flex items-center gap-1.5 mb-1">
        <Lock size={11} className="text-slate-300" />
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400">{num} · {STAGE_TITLES[stageKey]}</span>
      </div>
      <p className="text-xs text-slate-400 italic">{message}</p>
    </section>
  );
}

function ActiveCardHeader({ num, stageKey, title }) {
  const s = STATUS[stageKey];
  return (
    <div className={`flex items-center justify-between px-3.5 py-2 ${s.header} ${s.headerText}`}>
      <span className="text-xs font-extrabold uppercase tracking-wide">{num} · {title}</span>
      <span className="text-[10px] font-bold uppercase tracking-wide opacity-90">{STAGE_WAITING_LABEL[stageKey]}</span>
    </div>
  );
}

function LockedCardHeader({ num, stageKey, title, onEdit }) {
  const s = STATUS[stageKey];
  return (
    <div className="flex items-center justify-between px-3.5 py-2 bg-slate-100">
      <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
        <span className={`flex items-center justify-center w-4 h-4 rounded-full ${s.check} text-white`}>
          <CheckCircle2 size={11} strokeWidth={3} />
        </span>
        {num} · {title}
      </span>
      <button type="button" onClick={onEdit} className="text-xs font-semibold text-blue-600 hover:text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-300 rounded px-1">
        Edit
      </button>
    </div>
  );
}

function LockedRow({ label, value }) {
  return (
    <div className="flex items-start gap-3 mb-2 text-sm">
      <dt className="w-20 shrink-0 text-xs text-slate-400 pt-0.5">{label}</dt>
      <dd className="flex-1 text-slate-800 whitespace-pre-wrap">{value || "—"}</dd>
    </div>
  );
}

function StageMeta({ entry }) {
  if (!entry) return null;
  return (
    <div className="text-xs text-slate-400 mt-2 pt-2 border-t border-slate-100">
      {entry.action === "edited" ? "Edited" : "Submitted"} by {entry.name} · {fmtDate(entry.timestamp)}
    </div>
  );
}

function StageOne({ hotspot, locked, onChange, onSubmit }) {
  const [editing, setEditing] = useState(!locked);
  const [local, setLocal] = useState({ label: hotspot.label, tone: hotspot.tone, charLimit: hotspot.charLimit, intent: hotspot.intent, notes: hotspot.notes });
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const entry = latestStageEntry(hotspot, "needs_copy");

  const startEdit = () => {
    setLocal({ label: hotspot.label, tone: hotspot.tone, charLimit: hotspot.charLimit, intent: hotspot.intent, notes: hotspot.notes });
    setName("");
    setTouched(false);
    setEditing(true);
  };

  const errors = {
    label: !local.label.trim(),
    tone: !local.tone.trim(),
    charLimit: !(Number(local.charLimit) > 0),
    intent: !local.intent.trim(),
    notes: !local.notes.trim(),
    name: !name.trim(),
  };
  const isValid = !Object.values(errors).some(Boolean);

  const handleSubmit = () => {
    setTouched(true);
    if (!isValid) return;
    // Field edits ride along with the submit as one write — see submitStage.
    onSubmit(name.trim(), { label: local.label, tone: local.tone, charLimit: local.charLimit, intent: local.intent, notes: local.notes });
    setEditing(false);
  };

  if (!editing) {
    return (
      <section className="rounded-lg border border-slate-200 overflow-hidden">
        <LockedCardHeader num={1} stageKey="needs_copy" title="Design requirements" onEdit={startEdit} />
        <div className="p-3.5">
          <dl>
            <LockedRow label="Title" value={hotspot.label} />
            <LockedRow label="Tone" value={hotspot.tone} />
            <LockedRow label="Char limit" value={hotspot.charLimit} />
            <LockedRow label="Intent" value={hotspot.intent} />
            <LockedRow label="Notes" value={hotspot.notes} />
          </dl>
          <StageMeta entry={entry} />
        </div>
      </section>
    );
  }

  return (
    <section className={`rounded-lg border-2 overflow-hidden shadow-sm ${STATUS.needs_copy.border}`}>
      <ActiveCardHeader num={1} stageKey="needs_copy" title="Design requirements" />
      <div className="p-3.5 bg-white">
        <label className="block text-xs text-slate-500 mb-1" htmlFor="hs-title">Title {errors.label && touched && <span className="text-red-500">(required)</span>}</label>
        <input id="hs-title" value={local.label} onChange={(e) => setLocal((l) => ({ ...l, label: e.target.value }))} onBlur={() => onChange({ label: local.label })} className={`w-full text-sm border rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-orange-400 ${errors.label && touched ? "border-red-300" : "border-slate-200"}`} />

        <label className="block text-xs text-slate-500 mb-1" htmlFor="hs-tone">Tone of voice {errors.tone && touched && <span className="text-red-500">(required)</span>}</label>
        <input id="hs-tone" value={local.tone} onChange={(e) => setLocal((l) => ({ ...l, tone: e.target.value }))} onBlur={() => onChange({ tone: local.tone })} placeholder="e.g. confident, warm, concise" className={`w-full text-sm border rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-orange-400 ${errors.tone && touched ? "border-red-300" : "border-slate-200"}`} />

        <label className="block text-xs text-slate-500 mb-1" htmlFor="hs-charlimit">Character limit {errors.charLimit && touched && <span className="text-red-500">(required)</span>}</label>
        <input id="hs-charlimit" type="number" value={local.charLimit} onChange={(e) => setLocal((l) => ({ ...l, charLimit: e.target.value }))} onBlur={() => onChange({ charLimit: local.charLimit })} placeholder="e.g. 60" className={`w-full text-sm border rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-orange-400 ${errors.charLimit && touched ? "border-red-300" : "border-slate-200"}`} />

        <label className="block text-xs text-slate-500 mb-1" htmlFor="hs-intent">Intent / purpose {errors.intent && touched && <span className="text-red-500">(required)</span>}</label>
        <textarea id="hs-intent" value={local.intent} onChange={(e) => setLocal((l) => ({ ...l, intent: e.target.value }))} onBlur={() => onChange({ intent: local.intent })} rows={2} placeholder="What should this copy achieve for the user here?" className={`w-full text-sm border rounded-lg px-3 py-2 mb-3 resize-none focus:outline-none focus:ring-1 focus:ring-orange-400 ${errors.intent && touched ? "border-red-300" : "border-slate-200"}`} />

        <label className="block text-xs text-slate-500 mb-1" htmlFor="hs-notes">Notes for Content {errors.notes && touched && <span className="text-red-500">(required)</span>}</label>
        <textarea id="hs-notes" value={local.notes} onChange={(e) => setLocal((l) => ({ ...l, notes: e.target.value }))} onBlur={() => onChange({ notes: local.notes })} rows={2} placeholder="Anything else Content needs to know" className={`w-full text-sm border rounded-lg px-3 py-2 mb-3 resize-none focus:outline-none focus:ring-1 focus:ring-orange-400 ${errors.notes && touched ? "border-red-300" : "border-slate-200"}`} />

        <label className="block text-xs text-slate-500 mb-1" htmlFor="hs-name-1">Your name {errors.name && touched && <span className="text-red-500">(required)</span>}</label>
        <input id="hs-name-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jane Doe" className={`w-full text-sm border rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-orange-400 ${errors.name && touched ? "border-red-300" : "border-slate-200"}`} />

        <div className="flex gap-2">
          <button type="button" onClick={handleSubmit} className="flex-1 text-sm font-medium py-2 rounded-lg bg-slate-800 text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-orange-300">
            {entry ? "Save changes" : "Submit requirements"}
          </button>
          {entry && <button type="button" onClick={() => setEditing(false)} className="text-sm font-medium py-2 px-3 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300">Cancel</button>}
        </div>
        {touched && !isValid && <p role="alert" className="text-xs text-red-500 mt-1.5">Fill in every field above (including your name) to submit.</p>}
      </div>
    </section>
  );
}

function StageTwo({ hotspot, enabled, locked, onChange, onSubmit }) {
  const [editing, setEditing] = useState(!locked);
  const [copy, setCopy] = useState(hotspot.finalCopy);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const entry = latestStageEntry(hotspot, "drafted");
  const limit = Number(hotspot.charLimit) || 0;
  const overLimit = limit > 0 && copy.length > limit;
  const errors = { copy: !copy.trim(), name: !name.trim() };
  const isValid = !errors.copy && !errors.name;

  const startEdit = () => {
    setCopy(hotspot.finalCopy);
    setName("");
    setTouched(false);
    setEditing(true);
  };

  const handleSubmit = () => {
    setTouched(true);
    if (!isValid) return;
    onSubmit(name.trim(), { finalCopy: copy });
    setEditing(false);
  };

  if (!enabled) {
    return <WaitingCard num={2} stageKey="drafted" message="Unlocks once requirements are submitted." />;
  }

  if (!editing) {
    return (
      <section className="rounded-lg border border-slate-200 overflow-hidden">
        <LockedCardHeader num={2} stageKey="drafted" title="Content copy" onEdit={startEdit} />
        <div className="p-3.5">
          <dl>
            <LockedRow label="Final copy" value={hotspot.finalCopy} />
          </dl>
          <StageMeta entry={entry} />
        </div>
      </section>
    );
  }

  return (
    <section className={`rounded-lg border-2 overflow-hidden shadow-sm ${STATUS.drafted.border}`}>
      <ActiveCardHeader num={2} stageKey="drafted" title="Content copy" />
      <div className="p-3.5 bg-white">
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-slate-500" htmlFor="hs-final-copy">Final copy {errors.copy && touched && <span className="text-red-500">(required)</span>}</label>
          {limit > 0 && <span className={`text-xs font-medium ${overLimit ? "text-red-500" : "text-slate-400"}`}>{copy.length}/{limit}</span>}
        </div>
        <textarea id="hs-final-copy" value={copy} onChange={(e) => setCopy(e.target.value)} onBlur={() => onChange({ finalCopy: copy })} rows={5} placeholder="Enter the approved copy here" className={`w-full text-sm border rounded-lg px-3 py-2 mb-1 resize-none focus:outline-none focus:ring-1 ${overLimit ? "border-red-300 focus:ring-red-400" : errors.copy && touched ? "border-red-300" : "border-slate-200 focus:ring-orange-400"}`} />
        {overLimit && <div className="flex items-center gap-1 text-xs text-red-500 mb-2"><AlertCircle size={12} /> Over the character limit set by Design</div>}

        <label className="block text-xs text-slate-500 mb-1 mt-2" htmlFor="hs-name-2">Your name {errors.name && touched && <span className="text-red-500">(required)</span>}</label>
        <input id="hs-name-2" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam Lee" className={`w-full text-sm border rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-orange-400 ${errors.name && touched ? "border-red-300" : "border-slate-200"}`} />

        <div className="flex gap-2">
          <button type="button" onClick={handleSubmit} className="flex-1 text-sm font-medium py-2 rounded-lg bg-slate-800 text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-orange-300">
            {entry ? "Save changes" : "Submit copy"}
          </button>
          {entry && <button type="button" onClick={() => setEditing(false)} className="text-sm font-medium py-2 px-3 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300">Cancel</button>}
        </div>
        {touched && !isValid && <p role="alert" className="text-xs text-red-500 mt-1.5">Enter the copy and your name to submit.</p>}
      </div>
    </section>
  );
}

function StageThree({ hotspot, enabled, locked, onSubmit }) {
  const [editing, setEditing] = useState(!locked);
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const entry = latestStageEntry(hotspot, "approved");
  const isValid = !!name.trim();

  const startEdit = () => { setName(""); setTouched(false); setEditing(true); };

  const handleSubmit = () => {
    setTouched(true);
    if (!isValid) return;
    onSubmit(name.trim());
    setEditing(false);
  };

  if (!enabled) {
    return <WaitingCard num={3} stageKey="approved" message="Waiting on drafted copy before this can be approved." />;
  }

  // `entry` can be absent if a conflict refresh replaced this hotspot's history
  // out from under us; fall back to the editable form rather than crashing.
  if (!editing && entry) {
    return (
      <section className="rounded-lg border border-slate-200 overflow-hidden">
        <LockedCardHeader num={3} stageKey="approved" title="Sign-off" onEdit={startEdit} />
        <div className="p-3.5 flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 size={14} /> {entry.action === "edited" ? "Re-approved" : "Approved"} by {entry.name} · {fmtDate(entry.timestamp)}
        </div>
      </section>
    );
  }

  return (
    <section className={`rounded-lg border-2 overflow-hidden shadow-sm ${STATUS.approved.border}`}>
      <ActiveCardHeader num={3} stageKey="approved" title="Sign-off" />
      <div className="p-3.5 bg-white">
        <label className="block text-xs text-slate-500 mb-1" htmlFor="hs-name-3">Your name {!isValid && touched && <span className="text-red-500">(required)</span>}</label>
        <input id="hs-name-3" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alex Chen" className={`w-full text-sm border rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-1 focus:ring-orange-400 ${!isValid && touched ? "border-red-300" : "border-slate-200"}`} />
        <div className="flex gap-2">
          <button type="button" onClick={handleSubmit} className="flex-1 text-sm font-medium py-2 rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-300">
            {entry ? "Save changes" : "Approve"}
          </button>
          {entry && <button type="button" onClick={() => setEditing(false)} className="text-sm font-medium py-2 px-3 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300">Cancel</button>}
        </div>
        {touched && !isValid && <p role="alert" className="text-xs text-red-500 mt-1.5">Enter your name to approve.</p>}
      </div>
    </section>
  );
}

function VersionHistory({ history }) {
  const [open, setOpen] = useState(false);
  const sorted = [...(history || [])].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <section className="mt-4 pt-4 border-t border-slate-100">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-orange-300 rounded">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <History size={12} />
        Version history ({sorted.length})
      </button>

      {open && (
        <ul className="mt-3 space-y-2">
          {sorted.length === 0 && <li className="text-xs text-slate-400 italic">No amendments logged yet.</li>}
          {sorted.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2 text-xs">
              <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${STATUS[entry.stage].dot}`} />
              <div>
                <span className="font-medium text-slate-700">{STAGE_TITLES[entry.stage]}</span>
                <span className="text-slate-400"> · {entry.action === "edited" ? "Edited" : "Submitted"}</span>
                <div className="text-slate-400">{entry.name} · {fmtDate(entry.timestamp)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- canvas ---------- */

function ImageCanvas({ screen, drawMode, selectedHotspotId, onSelectHotspot, onCreateHotspot }) {
  const containerRef = useRef(null);
  const [draft, setDraft] = useState(null);
  const dragStart = useRef(null);

  const getPct = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1) * 100;
    const y = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1) * 100;
    return { x, y };
  };

  const onMouseDown = (e) => {
    if (!drawMode) return;
    const p = getPct(e);
    dragStart.current = p;
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onMouseMove = (e) => {
    if (!drawMode || !dragStart.current) return;
    const p = getPct(e);
    const x = Math.min(dragStart.current.x, p.x);
    const y = Math.min(dragStart.current.y, p.y);
    const w = Math.abs(p.x - dragStart.current.x);
    const h = Math.abs(p.y - dragStart.current.y);
    setDraft({ x, y, w, h });
  };

  const onMouseUp = () => {
    if (!drawMode || !dragStart.current) return;
    dragStart.current = null;
    if (draft && draft.w > 1.5 && draft.h > 1.5) onCreateHotspot(draft);
    setDraft(null);
  };

  return (
    <div ref={containerRef} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} className={`relative w-full select-none rounded-lg overflow-hidden border border-slate-200 shadow-sm ${drawMode ? "cursor-crosshair" : ""}`}>
      <img src={screen.image} alt={screen.name} className="w-full h-auto block pointer-events-none" draggable={false} />

      {screen.hotspots.map((h) => {
        const status = deriveStatus(h);
        return (
          <div
            key={h.id}
            role="button"
            tabIndex={0}
            aria-label={`${h.label}, stage: ${STATUS[status].label}`}
            onClick={(e) => { e.stopPropagation(); onSelectHotspot(h.id); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectHotspot(h.id); } }}
            className={`absolute border-2 rounded-sm transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-orange-400 ${STATUS[status].box} ${selectedHotspotId === h.id ? "ring-2 ring-offset-1 ring-orange-400 z-10" : "hover:brightness-95"}`}
            style={{ left: `${h.x}%`, top: `${h.y}%`, width: `${h.w}%`, height: `${h.h}%`, backgroundColor: selectedHotspotId === h.id ? "rgba(251,146,60,0.12)" : "rgba(255,255,255,0.05)" }}
          >
            <span className={`absolute -top-5 left-0 text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${STATUS[status].badge} border`}>{h.label}</span>
          </div>
        );
      })}

      {draft && <div className="absolute border-2 border-dashed border-orange-400 bg-orange-400/10 pointer-events-none" style={{ left: `${draft.x}%`, top: `${draft.y}%`, width: `${draft.w}%`, height: `${draft.h}%` }} />}
    </div>
  );
}
