# Replacing and syncing stored and linked PDF attachments

Resolves ticket #3 in `atsyplenkov/zotero-mupdf-compress`.

Sources are Zotero's own source code and user documentation, read 2026-10-28:

- `zotero/zotero` branch `main` at `584cef63b5a9349e508185cbcdc5840530a23704` (current release line, Zotero 10.0.x)
- `zotero/zotero` branch `7.0` at `188c54c186fbbaa6889145986d43ba64160a44fa` (Zotero 7.0.x)

Where behaviour differs between the two, the report says so. Line numbers refer to those commits.

## Bottom line

Zotero exposes **no API that replaces an attachment's file contents**. The supported-in-practice procedure is:

1. Keep the attachment item. Never delete and re-import it — annotations are child items of that item, not content inside the PDF.
2. Replace the bytes at the path returned by `item.getFilePathAsync()`, keeping the same filename and leaving `item.attachmentPath` untouched.
3. Only for stored attachments, mark the item for upload explicitly (`attachmentSyncState = 'to_upload'`) and save with `saveTx({ skipAll: true })`.
4. Refresh the UI with `Zotero.Notifier.trigger('refresh', 'item', item.id)`, after calling `getFilePathAsync()` again to update Zotero's cached file-exists state.
5. Leave `attachmentSyncedModificationTime` and `attachmentSyncedHash` alone. They hold the *last known server* values and are used as the upload precondition.

Linked attachments follow steps 1, 2, and 4 only. They have no sync state, and Zotero will never upload them.

## What is stored where

| Concept | Evidence |
| --- | --- |
| An attachment is an item; its file is a separate artefact | `Zotero.Item.prototype.isStoredFileAttachment()` / `isLinkedFileAttachment()` at `chrome/content/zotero/xpcom/data/item.js:2729` and `:2763` (branch `main`; 7.0 has the same methods at `:2438` / `:2472`) |
| Stored files live in `storage/<8-char item key>/<filename>` | `getStorageDirectory()` at `chrome/content/zotero/xpcom/attachments.js:2817`, which appends the item key to `Zotero.getStorageDirectory()` |
| The database path for a stored file is a filename only, prefixed `storage:` | `item.js:2924`–`:2950` (`getFilePath`) rejects any stored path containing a directory separator |
| Linked files are absolute paths, or `attachments:`-relative paths resolved against the linked-attachment base directory | `BASE_PATH_PLACEHOLDER = 'attachments:'` at `attachments.js:41`; resolution in `getFilePath` / `getFilePathAsync` (`item.js:2953`, `:3064`) |
| Linked files cannot exist in group libraries | `item.js:2203`: `if (linkMode == Zotero.Attachments.LINK_MODE_LINKED_FILE && libraryType != 'user') throw` |

User documentation agrees: "Copied files are stored in the Zotero data directory, and each file has its own subdirectory, which is named with a random 8-character string" ([Adding Files](https://www.zotero.org/support/attaching_files), last updated 2025-09-11).

## Why annotations survive a file swap

Annotations are items whose `parentID` is the attachment item, and their geometry is stored in the database:

- `Zotero.Annotations` sets `item.parentID = attachment.id` when creating an annotation (`chrome/content/zotero/xpcom/annotations.js:232`).
- Annotation geometry is persisted to `itemAnnotations` keyed by `itemID` and `parentItemID`, including `sortIndex` and `position` (`item.js:2275`–`:2295`).

Zotero's documentation states the consequence plainly: "annotations created in the built-in PDF reader are stored in the Zotero database, so they won't be visible in external PDF readers unless you export a PDF with embedded annotations" ([PDF Reader](https://www.zotero.org/support/pdf_reader), last updated 2026-05-05).

Two conditions follow:

- The attachment **item must survive**, so a delete-and-reimport loses annotations.
- Page indices and page order must stay stable, because `sortIndex`/`position` reference pages by index. A compressor that removes or reorders pages invalidates placed annotations even though the rows still exist.

## No public replace API

The exported `Zotero.Attachments` surface contains import, link, download, rename and conversion helpers, but nothing that swaps an existing attachment's file (`chrome/content/zotero/xpcom/attachments.js`, methods listed at `:63`–`:3454`; e.g. `importFromFile` `:63`, `convertLinkedFileToStoredFile` `:3182`).

`Zotero.Item.prototype.relinkAttachmentFile()` (`item.js:3293`) is **not** a substitute. When the target file is outside the item's storage directory it copies the file in and then sets `attachmentPath` to the new filename (`item.js:3335`–`:3379`), so the stored filename changes and the item is modified. That is a relink, not a replacement.

The nearest built-in precedent for "file changed under the same item" is recovery after a download:

```js
item.attachmentSyncedModificationTime = mtime;
item.attachmentSyncedHash = md5;
item.attachmentSyncState = "in_sync";
await item.saveTx({ skipAll: true });
```

`chrome/content/zotero/xpcom/storage/storageLocal.js:676`–`:678`, repeated after upload in `zfs.js:574`–`:576`. This is the save pattern to mirror for any sync-state write.

## How Zotero decides a stored file must be uploaded

Sync states are integers on `itemAttachments.syncState` (`storageLocal.js:5`–`:10`):

| Constant | Value |
| --- | --- |
| `SYNC_STATE_TO_UPLOAD` | 0 |
| `SYNC_STATE_TO_DOWNLOAD` | 1 |
| `SYNC_STATE_IN_SYNC` | 2 |
| `SYNC_STATE_FORCE_UPLOAD` | 3 |
| `SYNC_STATE_FORCE_DOWNLOAD` | 4 |
| `SYNC_STATE_IN_CONFLICT` | 5 |

Only stored files have a sync state. The setter throws otherwise: `"attachmentSyncState can only be set for stored files"` (`item.js:3739`–`:3741`); `attachmentSyncedModificationTime` and `attachmentSyncedHash` throw the same way (`:3781`, `:3823`).

Detection of an out-of-band file change compares the file's mtime with the stored `storageModTime` and falls back to an MD5 comparison (`storageLocal.js:329`–`:397`):

- mtime differs and hash differs → `SYNC_STATE_TO_UPLOAD`
- mtime differs but MD5 matches the synced hash → Zotero **rewrites the file's mtime back** to the stored value and uploads nothing (`:367`–`:384`)
- file missing → `SYNC_STATE_TO_DOWNLOAD`

`checkFileModTime()` (`:415`) tolerates one-second precision differences and an exactly-one-hour offset, so sub-second sloppiness does not by itself force an upload.

### Detection is not reliable inside one session on Zotero 7

`Zotero.Sync.Storage.Engine.start()` chooses between a full scan and a partial scan (`storageEngine.js:144`–`:178` on `main`; `7.0` equivalent at `storageEngine.js:143`–`:164`):

- Zotero 7.0 has no filesystem watcher. A background sync uses the partial scan path whenever a full scan happened earlier in the session and that scan is younger than `maxCheckAge` (`this.maxCheckAge = 10800`, `storageEngine.js:80` in `7.0`).
- The partial scan only covers files with a recent `storageModTime` or files Zotero opened recently (`getFilesToCheck()`, `storageLocal.js:156`–`:186`).
- The `firstInSession` guard that would force a full scan is commented out (`7.0` `storageEngine.js:154`: `//&& !this.firstInSession`).

So on Zotero 7 an attachment that was synced days ago and never opened can be skipped by background syncs for the rest of the session, even though its bytes changed. Waiting for detection risks a compressed file that stays local and silently diverges from the server copy.

Current `main` (Zotero 10.0 line) is better: `Zotero.Sync.Storage.FileChangeWatcher` (inotify, ReadDirectoryChangesW, FSEvents) feeds changed keys into `checkForUpdatedFiles()` (`fileChangeWatcher.js:25`–`:50`, `:171`–`:191`; engine branch at `storageEngine.js:153`–`:159`). A plugin cannot rely on this while Zotero 7 is in scope.

**Recommendation for this prototype: mark `to_upload` explicitly.** It is cheap, works on both branches, and does not depend on scan heuristics.

### What marking `to_upload` actually does

- `getFilesToUpload()` returns items whose state is `TO_UPLOAD` or `FORCE_UPLOAD` **and** whose link mode is `IMPORTED_FILE`, `IMPORTED_URL`, or `EMBEDDED_IMAGE` (`storageLocal.js:491`–`:502`). Linked files are structurally excluded.
- Upload authorisation sends `If-Match: <attachmentSyncedHash>` (or `If-None-Match: *` when no hash is known) — `zfs.js:386`–`:390`.
- A 412 means the server copy changed since this client last synced. Zotero then sets `IN_CONFLICT` and raises the merge dialog (`zfs.js:582`; `resolveConflicts()` at `storageLocal.js:1086`–`:1145`).
- `FORCE_UPLOAD` does not bypass `If-Match`; it only says "upload regardless of the mtime check". Zotero uses it after conflict resolution, where it first copies the remote mtime and hash into the item so the upload passes the precondition (`storageLocal.js:1122`–`:1141`).

Because upload reads the *stored* hash, the plugin must not rewrite `attachmentSyncedHash` when it changes the file. Leaving the last-synced values in place is what makes the precondition meaningful and lets a genuine remote change surface as a conflict instead of being silently overwritten.

### Two equivalent ways to set the state

High level, matching Zotero's own save pattern:

```js
item.attachmentSyncState = 'to_upload';
await item.saveTx({ skipAll: true });
```

Or the low-level bulk helper Zotero itself uses, which writes the column directly without touching item metadata:

```js
await Zotero.Sync.Storage.Local.updateSyncStates([item], 'to_upload');
```

`updateSyncStates()` is at `storageLocal.js:521`–`:545` and exists unchanged in `7.0` (`storageLocal.js:501`).

`skipAll` expands to `skipDateModifiedUpdate`, `skipClientDateModifiedUpdate`, `skipSyncedUpdate`, `skipEditCheck`, `skipNotifier`, `skipSelect` (`chrome/content/zotero/xpcom/data/dataObject.js:1022`–`:1031`; present in `7.0` at `dataObject.js:892`). Without it, saving marks the item `synced = 0` and pushes an unnecessary metadata sync (`dataObject.js:1209`–`:1213`).

## Linked attachments do not sync

| Evidence | Statement |
| --- | --- |
| [Attaching Files](https://www.zotero.org/support/attaching_files) (2025-09-11) | "Linked files are not synced, nor are they deleted if the attachment item is deleted in Zotero. They also can't be used within a group library" |
| [Syncing](https://www.zotero.org/support/sync) (2026-06-17) | "Data syncing syncs library items, but doesn't sync attached files… To sync these files, you can set up file syncing" — file sync covers stored files |
| `item.js:3739` | `attachmentSyncState` refuses non-stored files |
| `storageLocal.js:491` | `getFilesToUpload()` filters to stored link modes |

Practical consequences for the plugin:

- Replacing a linked file is a pure filesystem operation. There is no sync state to set and no upload to trigger.
- A user who keeps linked PDFs in Dropbox/OneDrive/iCloud gets their own external propagation; Zotero never participates.
- Do not attempt to convert linked files to stored files as part of Compress. `convertLinkedFileToStoredFile()` exists (`attachments.js:3182`) but it changes the attachment's link mode and path, which is a different feature with different user expectations.

## Recommended procedure

### Compress, stored attachment

```js
// 0. Guards
if (!item.isPDFAttachment()) return;
const library = Zotero.Libraries.get(item.libraryID);
if (!library.filesEditable) { /* group with no file-edit rights: refuse */ return; }

const path = await item.getFilePathAsync();   // false when missing; also refreshes _fileExists
if (!path) { /* report "file missing" */ return; }

// 1. Session backup (mechanics owned by ticket #6)
const backup = PathUtils.join(cacheDir, item.key + '.pdf');
await IOUtils.copy(path, backup);             // keep original bytes before touching anything

// 2. Compress into a sibling temp file in the same directory, so the final move is a rename
const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const tmp = PathUtils.join(PathUtils.parent(path), `.mucomp-${token}.pdf`);
try {
  await runMutool(tmp, path);                 // command and validation: ticket #5
} catch (e) {
  await IOUtils.remove(tmp).catch(() => {});
  await IOUtils.remove(backup).catch(() => {});
  throw e;
}

// 3. Validate before replacing: page count, readable, smaller
//    (ticket #5 defines the checks; do not replace on failure)

// 4. Replace in place — same directory, same filename
await IOUtils.move(tmp, path);

// 5. Mark for upload, without disturbing last-synced metadata
item.attachmentSyncState = 'to_upload';
await item.saveTx({ skipAll: true });

// 6. Refresh UI
await item.getFilePathAsync();                             // updates cached file-exists state
await Zotero.Notifier.trigger('refresh', 'item', item.id);
```

Notes on each step:

- Zotero passes `{ noOverwrite: true }` to `IOUtils.move()` exactly where it must not replace the destination (`item.js:3358`), so the unaugmented call replaces. Confirm this once in the prototype rather than assuming it. A rename within the storage directory is atomic on POSIX and avoids a half-written attachment if Zotero exits mid-copy. Writing the temp file into the configured cache directory instead and moving it across filesystems can fail or degrade into a copy; keep the temp beside the target.
- `getFilePathAsync()` sets `_fileExists` as a side effect (`item.js:3058`, `:3076`), which is what the attachment pane and parent-row indicator read.
- `relinkAttachmentFile()` already uses this same refresh call after changing a file (`item.js:3382`), so `Notifier.trigger('refresh', 'item', id)` is the established way to repaint an attachment row.
- If a downloaded file is missing, Zotero would otherwise treat the replacement path as "download again"; calling `getFilePathAsync()` after the move keeps the cached state truthful.

### Revert, stored attachment

Identical file mechanics, with a different source:

```js
const path = await item.getFilePathAsync();
if (!path) { /* report */ return; }
await IOUtils.copy(backup, path);            // or move, if the backup is single-use
item.attachmentSyncState = 'to_upload';
await item.saveTx({ skipAll: true });
await item.getFilePathAsync();
await Zotero.Notifier.trigger('refresh', 'item', item.id);
```

Revert must run the same guard as Compress (blocked when the compressed file changed after compression — ticket #6 owns the signature check and the user-facing decision).

### Linked attachment

```js
const path = item.getFilePath();             // sync variant is fine here; no DB state to update
// same temp-file + validate + move sequence as above
await Zotero.Notifier.trigger('refresh', 'item', item.id);
```

No `attachmentSyncState` write, no `saveTx`, no upload. Attempting either would throw for a linked file.

### What not to do

| Anti-pattern | Why it fails |
| --- | --- |
| Delete the attachment item and import the compressed file | Destroys annotation child items, changes the item key, breaks `zotero://` links into the PDF |
| Call `relinkAttachmentFile(compressedTemp)` | Copies the temp file in under a new name and rewrites `attachmentPath`; also marks the item modified (`item.js:3335`–`:3379`) |
| Change `attachmentPath`, or rename the stored file | Unnecessary; forces an item metadata sync and can invalidate the stored path for other devices |
| Write `attachmentSyncedHash` / `attachmentSyncedModificationTime` after compressing | Those mean "what the server has"; overwriting them defeats the `If-Match` precondition and hides real conflicts |
| Use `FORCE_UPLOAD` for a normal compression | Reserved for conflict resolution; it tells Zotero to skip the mtime sanity check rather than to resolve a conflict |
| Preserve the original mtime on the compressed file | Keeps `storageModTime` matching, which makes automatic detection conclude "unchanged"; harmless only because `to_upload` is set explicitly, and otherwise misleading to other clients |
| Rely on Zotero noticing the change by itself | Zotero 7's partial-scan heuristic can skip the file for the rest of the session (see above) |

## Edge cases worth handling in the prototype

- **Group library without file-edit rights.** Check `Zotero.Libraries.get(libraryID).filesEditable` (`storageEngine.js:145`; the accessor is declared at `chrome/content/zotero/xpcom/data/library.js:214`) before offering Compress; the file sync engine skips the modification check entirely when this is false (`storageEngine.js:145`).
- **Attachment open in the reader.** Window file locking is the practical reason to skip; the settled prototype decision already refuses these. Replacement itself does not require closing Zotero, only avoiding a locked target file.
- **Sync not configured, or WebDAV.** Setting `to_upload` is harmless; the state simply remains until a storage engine runs. States are provider-agnostic (`webdav.js` uses the same `Zotero.Sync.Storage.Local` bookkeeping).
- **Remote copy changed since last sync.** Upload returns 412 and Zotero sets `IN_CONFLICT` with its merge dialog (`zfs.js:582`). The plugin should not try to resolve this; report it if it happens immediately after a compression.
- **File never synced / no stored hash.** Upload then sends `If-None-Match: *` (`zfs.js:388`), which is the correct "create" precondition.
- **Read-only or permission-denied target.** Zotero's own handlers surface this through `Zotero.File.checkFileAccessError(e, path, 'update')` (used at `storageLocal.js:381`); reuse it for a consistent message.
- **Multi-file attachments.** Zotero may zip several files in one storage directory (`hasMultipleFiles()` at `attachments.js:2925`). A PDF attachment with siblings must not have its directory treated as single-file; operate on the resolved PDF path only, which the procedure above already does.

## Confirmed versus uncertain

Confirmed from source and documentation:

- Stored-path layout, `storage:` prefix, linked-path resolution, link-mode predicates.
- Annotations as DB child items with page-relative position data.
- Sync-state constants, stored-only enforcement, `getFilesToUpload` link-mode filter.
- mtime + MD5 detection, the mtime-rewrite shortcut, the partial-scan heuristic and its absence of a watcher on 7.0.
- `If-Match` upload precondition, 412 conflict path, post-upload bookkeeping pattern.
- Linked files excluded from file sync, both in docs and in code.

Not established here, left to the prototype:

- Whether `Zotero.Notifier.trigger('refresh', 'item', id)` alone repaints every surface that shows attachment size or file state in 7.x and 10.x. It is the pattern Zotero uses after relinking, but the item tree, item pane and reader are separate consumers; the prototype should verify visually.
- Whether Zotero 7.0's full scan at startup reliably runs before a user's first compression in a fresh session. The code suggests it does (`storageEngine.js:164`–`:166` in `7.0`), but the commented-out `firstInSession` guard makes the intent ambiguous.
- Whether replacing the file triggers any full-text re-index that would be worth suppressing. Index state is computed from indexed/total pages (`fulltext.js:2883`–`:2940`), not from file mtime, so no re-index is expected; this was not exercised.

## Implementation guidance summary

For the prototype, the smallest correct implementation is:

1. Resolve the path with `getFilePathAsync()`; refuse when false.
2. Copy the original to the session cache before touching anything.
3. Compress into a sibling temp file; validate; `IOUtils.move()` over the original path.
4. Stored only: `attachmentSyncState = 'to_upload'`, `saveTx({ skipAll: true })`.
5. `getFilePathAsync()` then `Notifier.trigger('refresh', 'item', id)`.
6. Revert repeats 3–5 from the cached original, after the changed-file guard from ticket #6.

No Zotero API call re-encodes or re-hashes the attachment for us; the file is the source of truth, and the sync state is the one piece of Zotero metadata that has to be written by hand.
