# Linux bundled-engine prototype (#9)

Local, throwaway implementation tested on 2026-10-28. This is not a release.
Ticket: <https://github.com/atsyplenkov/zotero-mupdf-compress/issues/9>.
No branch or commit was created. The user's personal library was not mounted or changed.

## Current verdict

The native engine and single-attachment Compress/Revert workflow run inside the
isolated Zotero 10.0.6 profile without an externally installed PDF engine. The
corrected core suite passed 22 checks, with zero failures or skipped checks.
An expanded run passed all 25 checks, including feedback reopening and timing.
The separate busy-shutdown check also passed after fixing a closing-widget error.
The user subsequently tested the prototype and reported that it works. They accept
the current popup wording for now, although it is too verbose. They requested menu
and Settings changes for the release specification, without changing the prototype.
Visual quality on representative documents has not been explicitly accepted.
The remaining compatibility and safety gaps below are unchanged.

## User feedback for the release specification

- Retain **Compress PDF > Compress/Revert** directly on eligible PDF attachments.
- Also offer the same actions on a single selected parent item when it has exactly
  one PDF attachment. Both actions must target that attachment and use its existing
  safety checks and session record. Hide the parent-item menu when there are zero
  or multiple PDF attachments; do not choose one automatically. Notes and non-PDF
  attachments do not affect the PDF count. This does not add batch compression.
- Fix the Settings pane so selecting MuPDF Compress displays its own content and
  the temporary-folder control. In the user's screenshot, MuPDF Compress is selected
  but PDFerret's content remains visible. This is a user-reported display fault;
  its cause and installed-build details have not been established. Do not add
  additional settings. Preserve the next-launch temporary-folder behavior.
- Keep popup wording and timing unchanged for now. The user finds the wording too
  verbose but does not require a change at this stage.
- Record these requirements for the release specification. Do not modify or rebuild
  the prototype in response to this feedback.

The user supplied screenshots with the feedback. No screenshot or personal-library
content was uploaded to GitHub. The issue comment records only the relevant UI
observations and decisions.

## Local artifacts

- Source, UI, native build recipe and notices: `prototype/`.
- XPI: `.local-test/prototype/mupdf-compress-prototype.xpi`.
- Request-gated integration extension and scripts: `prototype-tests/`.
- Isolated environment: [zotero-environment.md](zotero-environment.md).
- Fixture provenance: [pdf-corpus.md](pdf-corpus.md).
- Engine evidence: `.local-test/prototype/engine-check/results.json`.
- Core in-app evidence: `.local-test/prototype/integration-suite-fixed.json`.
- Expanded UI evidence: `.local-test/prototype/integration-ui-review.json`.
- Final regression evidence: `.local-test/prototype/integration-final-suite.json`
  (25 passed, zero failed/skipped; normal exit 0).
- Hands-on setup/menu evidence: `.local-test/prototype/integration-hands-on-ready.json`.
- Busy-shutdown evidence: `.local-test/prototype/integration-busy-stop-fixed.json`.
- Cleanup evidence: `.local-test/prototype/cleanup-check-results.json`.
- Restart evidence: `.local-test/prototype/integration-normal-restart.json`.
- Comparison image: `.local-test/prototype/quality-comparison.png`.
- Captured success window: `.local-test/prototype/feedback-window.png`.

Runtime artifacts and test-library data remain local under `.local-test/`.

## Hands-on review

At handoff, the isolated Zotero window was left open on workspace **6**, in collection
**MuPDF prototype #9 - hands-on review hands-on-ready**. It contains four fresh
stored/linked fixture attachments. The stored image-heavy PDF is selected and
already compressed, with an active verified session backup. Right-click it and
choose **Compress PDF > Revert**, then try Compress again. The linked image-heavy,
text/vector and embedded-annotation fixtures are also available. Close any PDF
reader tab before either action.

The two setup checks passed. Zotero's context-menu builder and popup handlers
exposed both actions for one PDF and hid the submenu for multiple selected PDFs.
The test dispatched menu events without opening a popup on the user's active
workspace; manual menu interaction remains part of hands-on review.

Keep this session open to retain its current Revert record. Normal close removes
session backups; a later launch cannot revert this session's compressed files.
The window is supervised locally by `.local-test/prototype/review-supervisor.py`;
close its main window normally to finish. No deliberate crash was performed.
The user has since reported successful use and supplied the feedback recorded above.
This setup description does not confirm that the same session is still running.

## Observed results

MuPDF 1.28.5 was built from the pinned archive, whose SHA-256 matched
`98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934`.
The bundled executable's SHA-256 is
`036fc2602cfdccad54bac496a70c4385d07dc93736633d9ab6a4c308a8f532cf`.
It links only libc and libm, but requires **GLIBC_2.43** on this build host.
The lock helper requires GLIBC_2.34. These binaries are local-host artifacts,
not portable Linux release builds. Full source-access instructions, build recipe,
MuPDF COPYING and third-party notices accompany the XPI.

The synthetic image-heavy PDF shrank from 11,524,690 to 1,273,065 bytes:
10,251,625 bytes saved (88.95%). Page counts, full-page renders, qpdf checks and
embedded annotation checks passed for readable native-engine fixtures. Blank
output was larger and must not replace its input. Encrypted and unreadable input
was rejected. Fixture-original hashes remained unchanged.

Inside Zotero, stored and linked Compress/Revert retained attachment identity,
path and original bytes after Revert. Stored files became `to_upload` without
rewriting last-synced hash/time; linked files received no upload state. This is
local metadata evidence, not an online sync test. Native Zotero highlight/note
keys, parents, positions and sort indices survived both operations.

The corrected suite checked repeated compression, timestamp-only Revert, changed
bytes/path/missing files, missing/corrupt backups and retry, a real reader tab,
invalid/no-benefit output, backup-verification failure, external writes before the
final check, busy operations, linked aliases and partial metadata failures.
Private 0700 sibling output directories prevent ambient umask from exposing
intermediate PDFs. Alias path reservations prevent a second attachment from
recompressing an already-owned path. Metadata retry after a restored-but-incomplete
Revert finishes without replacing bytes again.

Cross-process cleanup checks held a real native lock outside the Zotero PID
namespace while startup ran. The active session was preserved, abandoned recognized
sessions were removed, unknown content was left intact, and a symlink plus its
outside sentinel were untouched. A session containing a symlink reports
`cleanup-failed` and remains intact; this is a safe refusal, not deletion success.
After releasing the external lock, a later startup removed that owned session.
Normal window close exited 0, removed the active session and its backup, and a
restart rejected Revert for the prior session without changing its compressed PDF.
A separate controlled check paused an operation after its verified backup, requested
shutdown, and verified that ownership and backups remained until the operation was
released. The operation then finished, cleanup removed the session, and new work
was rejected. Changing the temporary-folder preference did not move the active
session or initialize another root; the preference was restored before exit.
A deliberate crash during an operation was not tested.

All test windows were routed to workspace 6. Progress windows were observed as
small floating dialogs, with the main window retaining its normal layout. The
user changed active workspaces during some runs, so before/after workspace numbers
from those longer runs are not evidence of a launcher-caused switch.

## Defects found during the prototype

- Zotero 10 requires `applications.zotero.update_url`; omission caused sideloaded
  XPIs to be rejected and removed. A reserved `example.invalid` placeholder satisfies
  the manifest; there is no update feed, and test-profile updates remain disabled.
- Checking a nonexistent native-cache path with `nsIFile.isSymlink()` caused startup
  to fail. Missing-path handling was narrowed to the intended creation case.
- Fast native commands could finish before stdin close, producing a pipe EOF error.
  The subprocess wrapper now tolerates only the documented EOF code and still
  requires a successful native exit. Two initial integration failures exposed this.
- Tiled progress windows made repeated test operations unusable. Non-modal dependent
  dialogs now float, and closing the last main window drains operations and closes
  feedback so Zotero can exit normally. A shutdown test also exposed a widget error
  that incorrectly changed an already-successful operation into a partial failure;
  feedback rendering now cannot change the verified file/metadata outcome.
- Review found private-output, alias-ownership and partial-Revert-retry defects;
  those were fixed and exercised in the corrected in-app suite.

Earlier failed runs remain in the evidence directory. Some host orchestration
attempts ended when their supervisor failed or timed out; they are not normal-close
results. The later `cleanup-seed` and `normal-restart` runs establish normal-close
and restart behavior separately.

## Assumptions confirmed or still open

Confirmed on this host: extraction/execution of bundled native tools; OS-held
cross-process session ownership; in-place attachment replacement; local sync
metadata handling; session-only Revert with changed-file protection; reader guard;
and native Zotero annotation identity retention. Automated UI checks confirmed that
closing progress did not cancel work, success reopened the result, success/no-benefit
dismissed after about 10 seconds (observed 10,009 and 10,019 ms), and blocked-action
feedback remained visible beyond 11 seconds. These checks do not replace human
feedback acceptance.

Challenged: a source-only scaffold research result was insufficient for the current
manifest loader; native transport has short-process races; a generic Linux build
on a new host is not a portable artifact; multiple linked items can share one file;
and independent chrome windows need window-manager and application-exit checks.

Still open: visual quality on representative papers/scans, human acceptance of
feedback and session-only Revert, Zotero 7 compatibility, a lower-glibc native build,
real sync/conflicts, full-text refresh behavior, tagged PDFs/forms/signatures,
calibrated unexpected-blank/ink-loss detection, noexec fallback, and broad corpus
performance. Full renders and equal page counts do not prove visual equivalence.

An external writer can still race the final hash check and rename. The session
lock owns backups, not attachment bytes. Cleanup refuses unknown files and symlinks;
it does not promise protection against a hostile process replacing directory
components concurrently. Use a trusted private temporary folder.
