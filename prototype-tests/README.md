# Throwaway Zotero integration checks (#9)

This directory is a privileged test extension, not production extension code.
It runs only in the isolated profile prepared for #8, and only after an explicit,
one-shot request. The corrected parent-driven core suite passed 22 checks with
no failures or skips. The optional UI checks and new review/shutdown modes have
not yet been run in Zotero. Visual-quality approval is deferred by the user;
hands-on feedback review remains pending. Automated checks do not establish
visual quality or user acceptance.

## Build and request

From the repository root:

```sh
prototype-tests/build-driver.sh
prototype-tests/request.py first-suite --faults --ui
```

The driver XPI is
`.local-test/prototype/integration-test-driver.xpi`, ID
`mupdf-compress-test-driver@prototype.invalid`. Install it alongside the prototype
into the disposable profile using the main task's installation procedure.
This directory's scripts do not install extensions or launch Zotero.

The main task must launch with
`scripts/test-environment/launch-zotero.sh`. Do not bypass its filesystem/network
isolation or silent workspace-6 routing. Do not sign in, enable sync, or use a
personal profile.

The driver checks the exact profile/data paths in the request and claims
`.local-test/prototype/integration-request.json` by moving it to
`integration-request-<run-id>.claimed.json`. Requests are never repeated
automatically. Use a new run ID for each attempt.

Evidence is written incrementally to
`.local-test/prototype/integration-<run-id>.json`.
A file with `status: running` is incomplete. A `driver-failed` result means the
driver could not run the suite. Per-check `skipped` means an adapter capability
was unavailable, not that the behavior passed. Every completed operation is
retained in `actions`, even when a subsequent byte assertion fails; the
compression assertion also includes that action's outcome code and stage.

## Driver/API contract

The prototype must expose `window.MuPDFCompressPrototype` on its main window:

- `ready`: a promise resolving after startup/extraction/session initialization.
- `compress(item)` and `revert(item)`: awaitable operations.
- `snapshot()` (preferred), `state` or `state()`: a serializable snapshot with `records`, either an array
  or an object. Entries need `itemID`, `id`, `key`, or `attachmentKey` to identify
  the item, and `backupPath` (or `backup`) for backup mutation tests.
- Operation return values should be JSON-serializable outcome objects.

The `record()` adapter in `integration.js` is the only place that needs changing
if the prototype exposes a different snapshot shape. The driver waits up to
60 seconds for the API, then awaits `ready`.

## Checks prepared

The default suite imports fresh stored and linked copies and checks:

- Smaller successful Compress retains item, key, attachment path and resolved
  path; stored files become `to_upload` while synthetic last-synced metadata
  remains unchanged, and linked-file metadata remains unchanged.
- Repeated Compress cannot change bytes or replace the session record.
- Two linked attachments sharing a resolved path cannot own two compression
  records. An alias is blocked while the owner has a record, and can compress
  after the owner successfully reverts.
- Revert restores the original SHA-256, consumes the record and allows Compress
  again; timestamp-only changes do not block restoration.
- Changed bytes, a missing attachment, and a changed linked path block Revert.
- Missing and corrupt backup cases leave installed bytes and recovery state
  untouched; returning the valid original allows a retry.
- A real Zotero PDF-reader tab blocks both operations. The harness closes only
  the test tabs it opens.
- Native Zotero highlight and note items retain their keys, parent, positions
  and sort indices across Compress/Revert of the embedded-annotation fixture.
  Embedded PDF annotation survival still needs independent engine inspection.
- Text/vector, valid blank, repairable damage, encryption and unreadable damage
  go through the same operation. Encrypted and unreadable inputs must remain
  unchanged.
- With `--faults`, replacing the test item's `saveTx` with a throwing function
  exercises a metadata failure after replacement. The method is restored in a
  `finally` block, and the verified backup and Revert are checked. The outcome
  must report `partial` with `changed: true`; visible wording needs review.
- With `--faults`, gated hooks exercise valid equal-size output (no benefit),
  invalid output, corrupt backup verification, a write before the final check,
  and a busy action while a prior action waits at the backup stage. This also
  checks a busy alias pointing to the same path. Each hook and the temporary
  `testMode` preference are restored after its check.
- With `--faults`, a Revert metadata failure after restoration must retain
  `restored-awaiting-metadata`, original bytes and the verified backup. A second
  failed metadata-only retry must retain them again. A successful retry must
  preserve the file modification time, report `changed: false`, and consume the
  backup/record. Compress is then available again.
- With `--ui`, enumerate only windows at the exact prototype progress URI and
  matching synthetic attachment title. Close a running window at the gated
  backup stage, verify the operation remains busy, then verify its successful
  result appears in a new window. Success and no-benefit must remain open at
  8.5 seconds and close near 10 seconds from their visible timestamp; a blocked
  result must still be open after 11 seconds. These checks take about 35 seconds.
  UI automation does not establish visual quality or non-modal behavior.

The source fixture originals are never linked or replaced. Imports use copies
under `.local-test/prototype/integration-files-<run-id>/`. Every library change
uses Zotero's in-app APIs; no live database SQL is used. Imported items are left
in the disposable library to aid inspection.

## Hands-on review session

After the stopped-profile install and before the final launch:

```sh
prototype-tests/request.py hands-on-review --mode review-session
```

This creates a named `MuPDF prototype #9 - hands-on review <run-id>` collection
with fresh stored and linked image-heavy attachments plus stored text/vector
and embedded-annotation fixtures. Only the stored image-heavy attachment is
compressed, then selected in the library with an active session Revert record.
The evidence includes item paths, original hashes, the active backup record,
and short review instructions. Leave that isolated Zotero session open for the
user. Opening its reader is optional; close it before Compress or Revert.

Evidence explicitly records visual quality as deferred, hands-on feedback as
pending, and no accepted preset. The linked copy and other fixtures remain
original. This mode does not run the timed UI checks or mark user review done.

## Shutdown while busy

Use a separate launch; this intentionally stops the extension session:

```sh
prototype-tests/request.py shutdown-busy-check --mode shutdown-busy
```

The gated `afterBackup` hook holds a Compress operation. A temporary-folder
preference change must not move its backup or create a second session root.
`testStop()` must set `stopping`, reject new work, and remain unresolved while
the operation and its verified backup are held. Releasing the operation must
allow successful compression before shutdown removes its session directory and
backup, drops all records and releases the native lock. A later action must
remain blocked. The temporary-folder preference and hook are restored even on
failure. Close the test app normally after collecting evidence; do not reuse
that stopped extension session for hands-on review.

This is an orderly extension-stop check, not a deliberate process kill or a
crash-during-operation check. The parent separately checked startup cleanup and
normal application shutdown; that evidence is in `cleanup-check-results.json`.

## Separate shutdown/restart checks

To leave one compressed stored attachment and its verified backup:

```sh
prototype-tests/request.py normal-close-seed --mode seed-session
```

Launch through the approved launcher, wait for completed JSON evidence, record
the session directory from `finalState`, and close the test window normally.
The host must check that the owned session directory was removed and the process
exited normally. Then request:

```sh
prototype-tests/request.py normal-close-restart --mode restart-check \
  --previous-run normal-close-seed
```

This verifies that Revert cannot use the prior session's record and cannot
change the seed attachment; its compressed SHA-256 must match the seed evidence.
If the selected temporary root is unchanged, the old session directory and seed
backup must be absent, and the new session directory must differ. This does not
distinguish normal-shutdown deletion from next-startup deletion. The same two-mode sequence can check a deliberately
crashed test process, but this harness never kills Zotero itself. The host must
record the precise process killed and prove subsequent cleanup of abandoned
directories.

Concurrent locked-directory cleanup needs separate host orchestration; the
parent recorded that check in `cleanup-check-results.json`. Shutdown during an
active operation uses the separate `shutdown-busy` mode above. Merely observing
that the helper can take a lock does not establish safe startup cleanup.

## Not covered automatically

Visual compression quality; full UI feedback-text/layout review and non-modality;
uncontrolled external-write races;
all cleanup/symlink races; an unavailable lock helper; real sync conflicts;
Zotero 7.

The prepared corpus is synthetic. Review on representative non-sensitive PDFs
is still required before accepting the preset's quality.

## Checks run while preparing this harness

`node --check` on both JavaScript files, `bash -n` on the build script,
Python compilation, XPI creation and manifest/member inspection were run
successfully. `node prototype-tests/check-harness.mjs` also passed: a mocked
failed Compress remains in JSON evidence and appears in compression-assertion
diagnostics. It also checks mocked review setup: four fixtures, one active
record, selection, and deferred/pending review status. Those smoke checks do not
exercise Zotero or the extension. `integration.js` stays below 800 lines; the two
extra modes live in `lifecycle-modes.js`, loaded and packaged by the driver.
No Zotero launch or in-app assertion has been run by this delegated task.
