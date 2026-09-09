# Copy Atlas

Design → Content handoff tool. Upload screenshots, draw copy hotspots on them, and
move each one through a three-stage workflow (design requirements → content copy →
sign-off) with attribution and version history.

## Run it

```bash
npm install
npm run dev          # api on :3001, web on :5173  -> open http://localhost:5173
```

`npm run dev` starts both processes. You can also run them separately with
`npm run api` and `npm run web`.

## Deploy it

The server serves the built frontend, so production is a single process:

```bash
npm run build        # -> dist/
npm start            # serves app + api + images on :3001
```

Environment:

| Var               | Default      | Purpose                             |
|-------------------|--------------|-------------------------------------|
| `PORT`            | `3001`       | HTTP port                           |
| `DATA_DIR`        | `./data`     | SQLite file + uploaded images       |
| `DELETE_PASSWORD` | `TenDelete`  | Required to delete anything         |

`DATA_DIR` must be a **persistent volume**. On an ephemeral filesystem (Heroku,
plain Cloud Run, a scale-to-zero container) both the database and the uploaded
screenshots vanish on restart.

## How storage works

- **Metadata** — SQLite (`data/copy-atlas.db`) via the built-in `node:sqlite`, so
  there is no native module to compile. One row per project, with the project tree
  stored as a JSON document plus real `name` / `updated_at` columns for the sidebar
  index. The tree is kept as JSON because the client updates whole projects
  atomically; normalising pages/screens/hotspots into tables would buy nothing
  until you need cross-project queries.
- **Images** — written to `data/uploads/` and served from `/uploads/...`. Filenames
  are a SHA-256 of the content, so re-uploading identical bytes is free and the
  files are immutable and cacheable for a year. The project JSON holds only the
  path, never the image data.
- **Concurrent edits** — every project has a `rev`. Writes send the rev they were
  based on; the server rejects a stale write with `409` instead of letting it
  overwrite someone else's change. The client then adopts the server's copy and
  shows "Refreshed" in the header.

## Deletion is password-gated

Deleting a project, page, screen or hotspot opens a confirm dialog that requires
the admin password (`TenDelete` by default, override with `DELETE_PASSWORD`).

The password is held **only on the server** and checked on every destructive
request, so it is not present in the JS bundle and cannot be bypassed by editing
client state or calling the API directly. A wrong entry leaves the dialog open with
an error and the item untouched.

Pages, screens and hotspots are deleted by `PUT`ting a smaller project document
rather than through their own endpoints, so the server compares the incoming
document against the stored one and requires the password if any page, screen or
hotspot id disappeared. Ordinary edits are unaffected and need no password.

Deleting content also removes the screenshots it owned from `data/uploads/`.
Because upload filenames are content hashes, a file shared by two projects is kept
until the last reference to it is gone.

> This is a guard against accidental deletion, not an access control. Anyone who
> knows the password can delete anything, and there is still no user
> authentication on the app as a whole — see Known gaps.

## API

| Method   | Path                 | Notes                                        |
|----------|----------------------|----------------------------------------------|
| `GET`    | `/api/projects`      | Sidebar index, newest first                                        |
| `GET`    | `/api/projects/:id`  | `{ id, rev, data }`                                                |
| `PUT`    | `/api/projects/:id`  | Body `{ data, rev }`. `409` stale rev; `403` if it deletes content without the password |
| `DELETE` | `/api/projects/:id`  | Always needs the password. `403` without it                        |
| `POST`   | `/api/images`        | Raw image body, returns `{ url }`                                  |

Destructive requests carry the password in an `X-Delete-Password` header.

## Smoke tests

Both drive a real browser against a running server.

```bash
node persistence-test.mjs   # full workflow, then reload, then assert it came back
node share-test.mjs         # second browser profile sees the same workspace
node delete-test.mjs        # password gate + screenshots actually leaving disk
```

## Known gaps

- **No authentication.** Anyone who can reach the URL can read and edit every
  project, and the delete password is shared rather than per-user, so deletions
  aren't attributable to anyone. Fine on localhost; not safe to expose publicly
  as-is.
- **No live updates.** Two people editing at once won't see each other's changes
  until they reload — they'll get the conflict banner instead of silent data loss,
  but this is not real-time collaboration.
- **Images orphaned by a crash are not swept.** Deletes clean up after themselves,
  but an upload that never gets saved into a project (browser closed mid-flow) stays
  on disk. `referencedImageFiles()` in [server/db.js](server/db.js) is the hook for a
  periodic sweep if that ever matters.
