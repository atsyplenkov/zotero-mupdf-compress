# Parent item with one PDF (#14)

Checked on 2026-11-02 against Zotero 10.0.6 in the disposable profile from #8.
No personal library, personal Zotero profile, or private extension configuration
was opened. The prototype tree was not changed.

## Versions and artifacts

- Zotero 10.0.6 (`BuildID=20261007153824`), isolated profile under `.local-test`.
- Extension `mupdf-compress@atsyplenkov.github.io` version 0.1.0. Tested XPI:
  size 31263313 bytes, SHA-256
  `12e770acb38308aa8588472bc3bc05460288f57b968ba0488a2416d12b860a7c`. This is
  the build installed for the run. A later gate rebuild changes zip entry
  timestamps and therefore the hash even when the contents are equivalent.
- Throwaway driver `mupdf-compress-parent-driver@test.invalid` version 0.1.0,
  size 8861 bytes, SHA-256
  `70bfc18b79ea44a507f25f0b5439b1a6a00e3e58c5f4457f02bff32ef8f057dc`.
- Bundled engine: MuPDF 1.28.5, digest `036fc260…`, extracted to the profile at
  `mupdf-compress/036fc2602cfdccad/` with mode 0700. The host build still requires
  GLIBC_2.43; that is a known limitation, not an approved distribution baseline.

## Target resolution

`src/target.ts` keeps `eligible()` for one directly selected stored or linked PDF
attachment. `resolveTarget()` now falls back to `solePdf()` when exactly one
regular item is selected. `childPdfs()` counts current child attachments whose
`attachmentContentType` is `application/pdf` through `item.getAttachments()`.
That API already excludes notes and trashed children, and the content-type filter
removes non-PDF attachments. The submenu appears only when the count is exactly
one and that child passes `eligible()`.

A parent with two PDFs is hidden even when only one of them is a stored file. A
sole web PDF, and a parent with one stored PDF plus one web PDF, are also hidden.
There is no best-attachment heuristic and no fallback that ignores a second PDF.

The count does not inspect file existence or reader state. A missing or open sole
PDF remains a target, and the shared attachment operation explains the blocked
invocation. Both the submenu `onShowing` handler and the action callback call
`resolveTarget()`, so child eligibility is recomputed when the action starts. The
action callback also re-reads the current selection from the owning main window,
falling back to the captured menu items only when no selection is available. A
check that adds a second PDF after the menu is built receives `ineligible` when
that stale menu command is invoked; another changes the selection to two items
and receives the same explanation.

Both menu actions pass the resolved child to the same
`operation.compress()`/`operation.revert()` entry point. The session record is
created for the child's library and key; no parent record exists.

## Menu ownership

The MenuManager registration and the manual injection path are unchanged from
#12 and share the target resolver. The item context still supplies
`context.items`, but the action callback re-reads the current selection from the
owning main window. `context.collectionTreeRow` is not read because newer
multi-row menus remove it. Disable unregisters the owned menu ID, removes the
owned element, and removes the manually inserted element, listener, and
per-window registration.

The manual path was exercised on Zotero 10.0.6 by setting `Zotero.MenuManager` to
`undefined` while enabling the extension, then restoring it before building the
menu. The parent submenu was present and visible, and disable removed it without
rebuilding. Actual Zotero 7 remains #19.

## Checks run

The privileged driver and host scripts live under `.local-test/parent-tests/` and
are intentionally not committed, matching the earlier tickets. The driver refuses
any profile other than `.local-test/zotero/profile`, claims one explicit request,
and writes its report incrementally. Most checks build the item context menu with
`ZoteroPane.buildItemContextMenu()` and invoke the built XUL command, which is
the same builder and command path a right-click uses. One check opens the real
item popup with `openPopupAtScreen()`, opens the real `Compress PDF` submenu with
`openMenu(true)`, and invokes the built command. No check synthesizes a device
pointer click.

The same checks were run before the change against the previous build. The eight
parent checks that existed then all failed with "The Compress PDF submenu is
hidden for an eligible target"; the direct-attachment and hidden-target checks
still passed. That pre-change report is
`.local-test/parent-tests/evidence-pre-parent-1.json`.

| Check | Result |
| --- | --- |
| A parent with one stored PDF, one child note, and one non-PDF attachment exposes `Compress PDF > Compress`/`Revert` | pass |
| Revert before Compression reports `no-record`; the PDF bytes and record state stay unchanged | pass |
| Compression from the parent stores the session record under the sole PDF's key, not the parent's, and keeps the PDF item and path | pass |
| The stored PDF becomes `to_upload`; the parent has no record | pass |
| A second parent Compress reports `repeated`; both actions stay visible | pass |
| Parent Revert restores the exact original bytes and consumes the record; a fresh Compress then succeeds | pass |
| A parent with one linked PDF compresses and reverts that attachment; the link mode and resolved path stay | pass |
| A real opened item popup and submenu compress and revert the sole PDF; the record stays with the PDF and the bytes return exactly | pass |
| The submenu appears for one stored PDF, its direct attachment selection, and a parent carrying notes/non-PDF attachments | pass |
| The submenu is hidden for zero PDFs, two PDFs, a sole web PDF, a stored-plus-web PDF pair, a non-PDF selection, and a multi-item selection | pass |
| A missing sole PDF stays eligible; Compress reports `missing`, leaves bytes unchanged, and creates no record | pass |
| An open sole PDF stays eligible; Compress reports `open`, leaves bytes unchanged, and creates no record | pass |
| A busy parent target keeps both actions visible; a second Compress reports `busy` while the first finishes successfully | pass |
| Adding a second PDF after the menu is built makes the stale parent action report `ineligible` without changing the first PDF | pass |
| Changing the selection to two items after the menu is built makes the stale action report `ineligible` without changing the PDF | pass |
| Disable removes the owned MenuManager menu element; enable restores one owned entry | pass |
| Starting without `Zotero.MenuManager` registers the manual parent menu; disable removes it and does not rebuild it | pass |

Sizes: the stored annotated PDF went from 13,988 to 2,453 bytes (82.5% saved);
the linked text/vector PDF went from 12,816 to 1,658 bytes (87.1% saved). Both
Reverts returned the recorded original hashes.

Host checks on the same artifact:

- `mise run check` exits 0. That runs typecheck, the lint and version checks, the
  generated-preference check, and the XPI build.
- `git status` shows only `src/menu.ts`, `src/target.ts`, and this documentation
  change. No file under `prototype/` or `prototype-tests/` changed.
- The packaged script bundle contains the shared `resolveTarget` call for both
  menu actions.
- The packaged XPI contains `native/mutool`, `native/session-lock`,
  `native/digests.json`, the Settings pane, the progress window, and the script
  bundle.

## Evidence

All local, not committed:

- `.local-test/parent-tests/evidence-parent-5.json` — driver report, 11 checks.
- `.local-test/parent-tests/evidence-pre-parent-1.json` — the failing pre-change
  run for the parent checks.
- `.local-test/parent-tests/install-record.json` — installed artifact hashes.
- `.local-test/parent-tests/parent-driver.xpi` — throwaway driver.
- `.local-test/zotero/logs/parent-parent-5.log` — application debug log.

The launcher's workspace guard was active. The active workspace read 1 before and
after this run, and the guard recorded one focus correction for a test window.

## Limits

- Only Zotero 10.0.6 was run. The manual injection path was simulated there by
  removing MenuManager during startup; actual Zotero 7 remains #19.
- Menu interaction uses Zotero's real menu builder and the built XUL command.
  One check opens the real item popup and submenu; no check synthesizes a device
  pointer right-click. The real-pointer boundary is not claimed.
- Revert conflicts, partial recovery, changed or missing backups, and shared-path
  alias ownership belong to #15/#17. This ticket verifies the parent entry point
  and its shared record, not a new recovery path.
- The sole-web-PDF parent is a synthetic Zotero attachment item. Unusual link
  modes are covered only by that fixture.
- Sync is offline. The stored `to_upload` check is local metadata; no upload or
  conflict was exercised.
- The fixtures are synthetic. Visual-quality and representative-document review
  belong to #19.
- The disposable profile contains only synthetic test items. No personal library
  or account was used.
