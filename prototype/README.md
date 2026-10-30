# THROWAWAY Linux XPI for ticket #9

This local prototype answers whether the bundled native workflow works in Zotero.
It is not production code or a release. No branch, commit, update feed, or external
PDF-engine installation is needed. Only Linux x86_64 is packaged. Zotero 10's
manifest parser requires a nonempty update URL, so the manifest names a reserved
`example.invalid` URL. There is no published feed; updates are disabled in the
isolated test profile.

## Build

```sh
prototype/build-engine.sh
prototype/build-xpi.sh
```

The XPI is `.local-test/prototype/mupdf-compress-prototype.xpi`. The engine build
recipe, source checksum/access instructions, MuPDF license, and bundled third-party
notices accompany the XPI. See `vendor/SOURCE.md` and `vendor/THIRD-PARTY.md`.
The XPI includes its own extension source and the native lock-helper source.

Install and run **only** in the disposable environment documented in
`docs/testing/zotero-environment.md`. With that Zotero closed:

```sh
prototype-tests/build-driver.sh
python prototype-tests/install-isolated.py
scripts/test-environment/launch-zotero.sh
```

The installer refuses to modify a running disposable profile and cannot target
another profile. The test driver does nothing without a one-shot request.
Run evidence and outstanding human-review questions are in
`docs/testing/prototype-results.md`.
Do not link fixture originals: create disposable copies below `.local-test`.
Right-click one stored or linked PDF attachment and choose **Compress PDF →
Compress** or **Revert**. Both actions remain available; unavailable actions explain
why. The temporary-folder preference takes effect on the next launch.

## Implementation decisions

- Bootstrap lifecycle is adapted from the AGPL-3.0-or-later community
  [zotero-plugin-template v3.1.0 `addon/bootstrap.js`](https://github.com/windingwind/zotero-plugin-template/blob/v3.1.0/addon/bootstrap.js),
  retrieved 2026-10-28. The template itself credits Zotero's Make It Red example.
  This throwaway implementation omits the template's TypeScript/toolkit/npm build
  chain: there is only a bootstrap file, small chrome UI files, and a zip build.
- Feature-detect MenuManager; use its item-only context on Zotero 8+ and manual
  XUL menu injection when absent. The 7.x fallback exists but is untested.
- A small chrome progress window uses Zotero's normal chrome styling. It does not
  use `Zotero.ProgressWindow`: a custom window gives explicit closed-window
  detection and a fixed 10-second result timer from rendering, with no mouse-hover
  extension of that timer. There is no Cancel action; closing does not stop work.
  It opens as a dependent, non-modal transient dialog so a tiling compositor does
  not treat every status window as another library window. Stages have no invented
  percentage. A dismissed window reopens only for results. Main-window closure
  closes its feedback windows; final-main-window unload waits for session cleanup.
  Widget opening/rendering/closing failures are contained at the feedback boundary;
  they cannot reclassify completed file/metadata work as partial. `snapshot().uiErrors`
  records only UI exception names and numeric codes, never exception messages.
- Native resources are read from the XPI through NetUtil, extracted into the
  disposable profile, checked against bundled SHA-256 digests, and made executable.
  Both engine execution and lifetime locking use Firefox Subprocess pipes.
  Native stderr is drained and discarded. Raw PDF diagnostics are never logged.
- Backups are flat opaque UUID files in a private session directory. A bundled
  helper holds an OS `flock` with stdin open. Cleanup takes the same exclusive
  lock, checks an exact marker, refuses symlinks/unknown files, and never recurses.
  A failed initialization or lost lock blocks replacement.
- Validate both page counts and full-document 72-DPI renders, then require smaller
  output. Intermediate output is inside a private 0700 UUID sibling directory,
  because MuPDF may unlink a precreated output file. Replacement renames from
  there after final path/hash/reader/lock/backup checks. Cleanup removes only the
  tracked output and an empty directory, never recursively. The original verified
  backup survives metadata failures. A Revert that restored bytes but failed its
  metadata update can retry only that metadata step after verifying original bytes.
- Resolved paths are reserved across attachment identities during work and while
  a successful/partial session record exists. Two linked attachment items pointing
  at the same path cannot bypass busy or repeated-compression protection.
- Stored files are marked `to_upload`; last-synced hash/time are not rewritten.
  Linked files never receive a sync state. Attachment identity/path are retained.
- Normal Zotero shutdown waits for active operations through an awaited Zotero
  shutdown listener, then removes the owned session while retaining its lock.

## Isolated integration API

Every main window has `window.MuPDFCompressPrototype`:

```js
await MuPDFCompressPrototype.ready;
MuPDFCompressPrototype.snapshot();
await MuPDFCompressPrototype.compress(attachmentItem);
await MuPDFCompressPrototype.revert(attachmentItem);
MuPDFCompressPrototype.closeProgress();
```

`ready` resolves even on initialization failure; inspect `snapshot().ready` and
`initializationError`. The snapshot includes the session path, lock state, records,
busy attachment identities and resolved paths, cleanup results, feedback history,
and stage events. `startupStage` identifies initialization progress; if test mode
was enabled before launch, a startup failure also records
`initializationDiagnostic` with its exception name/message. This diagnostic runs
before any PDF operation and is never used for raw engine/PDF errors.
Outcomes contain `code`, `message`, `changed` (boolean or null when unknown),
`autoDismiss`, and `stage`; the UI adds `visibleAt` when rendered.

Fault injection is permitted only when the explicit raw Zotero preference
`extensions.mupdf-compress-prototype.testMode` is boolean `true`. With that flag,
assign async callbacks to `.hooks.afterBackup`, `.hooks.beforeValidate`,
`.hooks.beforeReplace`, and `.hooks.afterReplaceBeforeMetadata`. Context includes
`action`, `item`, `path`, and the applicable `backupPath`, `output`, or `record`.
The final safety checks run after `beforeReplace`. `.testStop()` is similarly gated
and waits for active operations, then cleans the session. These helpers are local
prototype diagnostics, not a supported plugin API.

## Limits that must remain explicit

- Syntax checks and packaging do not establish a successful Zotero run. See the
  parent ticket's integration report for observed results.
- Only Zotero 10.0.6 is approved for the current run. Gecko module imports, MenuManager
  events, preference rendering, and reader detection need real compatibility runs
  before claiming support for other versions.
- `Reader._readers` is private. If it is unavailable, this prototype blocks work.
- Rendering and equal page counts do not prove visual equivalence. There is no
  calibrated unexpected-blank-page or severe-ink-loss detector. Valid blank pages
  are accepted. Visual quality and thresholds remain user-review questions.
- Encryption/password entry is not implemented. Engine failures on encrypted or
  unreadable inputs leave the attachment untouched. Repairable PDFs can pass
  MuPDF validation; no independent-engine validation is bundled.
- `flock` owns session backups, not the attachment file. The final check/rename
  cannot prevent another process from writing in the small interval between them.
  Symlink checks reject known symlinks, but do not defend against a hostile process
  concurrently swapping directory components. Use a private trusted temp folder.
- Session records are memory-only. Crash leftovers are deleted only after taking
  their lock; they never make Revert available in a later session. This is not
  durable recovery. Shutdown errors can leave recognized artifacts for later cleanup.
- This environment is offline. `to_upload` state can be checked, but remote sync,
  WebDAV, conflicts, full-text reindexing, forms/signatures/tagged PDFs, large-file
  performance, and a broad real-document corpus are not covered by this prototype.
