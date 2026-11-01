# Compress one stored PDF (#12)

Checked on 2026-11-01 against Zotero 10.0.6 in the disposable profile from #8.
No personal library, personal Zotero profile, or private extension configuration
was opened. The prototype tree was not changed.

## Versions and artifacts

- Zotero 10.0.6 (`BuildID=20261007153824`), isolated profile under `.local-test`.
- Extension `mupdf-compress@atsyplenkov.github.io` version 0.1.0. Tested XPI:
  size 31263122 bytes, SHA-256
  `bb8993d0e2bc562e8f2a071c51cc2e6fd13705fe5056be820646940dc6aa013a`. A rebuild
  changes zip entry timestamps and therefore the hash even when the contents are
  equivalent.
- Throwaway driver `mupdf-compress-menu-driver@test.invalid` version 0.1.0,
  SHA-256 `c2f936cea91f0699a1422ee996d04260909345d07ba9a3cb49c1d9600f48188c`.
- Bundled engine: MuPDF 1.28.5, digest `036fc260…`, extracted to the profile at
  `mupdf-compress/036fc2602cfdccad/` with mode 0700. The host build still requires
  GLIBC_2.43; that is a known limitation, not an approved distribution baseline.

## Menu entry point

`src/menu.ts` registers one owned submenu, **Compress PDF**, with **Compress** and
**Revert** items for Zotero's `main/library/item` menu target. It uses
`Zotero.MenuManager` when that API exists and falls back to injecting the submenu
into `#zotero-itemmenu` per main window when it does not. Both item callbacks
resolve the target again when invoked, then call the same attachment-operation
entry point. `src/target.ts` keeps target resolution separate from the operation
and currently accepts exactly one selected stored or linked PDF attachment. The
submenu is registered at startup, injected into existing main windows, and
removed on window unload and on shutdown, including a `Zotero.MenuManager`
unregister of the same menu ID. The owned element carries that ID, so shutdown
removes it explicitly: the manager's own plugin cleanup runs after the explicit
unregister and would no longer find a registration to remove elements from. Labels are plain English because the earlier
ticket deferred Fluent locales after a Zotero locale-rebuild rejection.

The operation changes in this ticket:

- A menu invocation can pass no target; the operation then returns the
  ineligible explanation instead of throwing.
- The backup hash is checked again immediately before replacement.
- Blocked results use a code-specific message instead of "The action was
  blocked", so a missing file, reader state, encryption, unreadable input,
  validation failure, changed bytes, backup failure, or lost session lock each
  explains itself. No message suggests another PDF engine or an override.
- The success message now includes the saved percentage (the earlier message
  omitted it).
- `documentInfo` also matches MuPDF's stderr password rejection, so a
  password-protected PDF is reported as encrypted instead of as an engine
  failure. A nonzero exit while reading the input is reported as unreadable; a
  draw failure during validation is reported as validation.
- A test-only `afterCompress` hook, gated on
  `extensions.mupdf-compress.testMode`, joins the existing gated hooks.

## Checks run

The privileged driver and host scripts live under `.local-test/menu-tests/` and
are intentionally not committed, matching the earlier tickets. The driver
refuses any profile other than `.local-test/zotero/profile`, claims one explicit
request, and writes its report incrementally.

The driver builds the item context menu with `ZoteroPane.buildItemContextMenu()`
and invokes the built XUL command, which is the same builder and command path a
right-click uses. It does not synthesize a pointer click. The MenuManager path is
the only path exercised on Zotero 10.0.6.

| Check | Result |
| --- | --- |
| One stored PDF exposes `Compress PDF > Compress`/`Revert` | pass |
| Compression from that command keeps the item, key, and path | pass |
| Native highlight and note keys, parents, positions, and sort indices survive | pass |
| Stored file becomes `to_upload`; last-synced hash and modification time stay | pass |
| Output is smaller; session record holds original and installed hashes | pass |
| Submenu hidden for two selected items and for a book item; shown for one linked PDF | pass |
| Second Compress reports `repeated`, bytes and record unchanged, result visible past 11 s | pass |
| Closing the running progress window does not cancel; the result reopens | pass |
| Success window auto-dismissed after 10011 ms measured from visibility | pass |
| No-benefit on the blank fixture: unchanged, no record, dismissed after 10050 ms | pass |
| Encrypted password-protected input: `encrypted`, unchanged, no record | pass |
| Encrypted empty-user-password input: `encrypted`, unchanged, no record | pass |
| Unreadable input: `unreadable`, unchanged, no record | pass |
| Open reader: `open`, unchanged, no record | pass |
| Invalid output: `validation`, unchanged, no record | pass |
| Attachment changed during Compression: `compress-changed`, later bytes kept, no record | pass |
| Unwritable session folder: `backup`, unchanged, no record | pass |
| Missing attachment file: `missing`, no record | pass |
| Unavailable bundled engine: `engine`, unchanged, no record, no external-engine advice | pass |
| Bundled `mutool -v` reports 1.28.5 from the profile cache, mode 0700 | pass |
| The progress window shows the named stage "Backing up", a Dismiss button only, no percentage, and the closing note | pass |
| The main window stayed responsive while the progress window was open | pass |
| Disable removes the owned menu element and no submenu is rebuilt | pass |
| Enable restores one owned submenu, and one command opens one progress window | pass |

Host checks on the same artifacts:

- The XPI contains `native/mutool`, `native/session-lock`, `native/digests.json`,
  the Settings pane, the progress window, and the script bundle. Executable
  digests match `addon/native/digests.json` and the pinned source checksum is
  recorded.
- `ldd` shows only `libc`, `libm`, and the loader for both native executables:
  no X11, GL, curl, crypto, or Wayland library. No `mutool` is installed on the
  host `PATH`.
- The packaged bundle contains the accepted preset options and none of the
  prefixed `--color-lossy-image`, `--color-lossless-image`,
  `--gray-lossy-image`, `--gray-lossless-image`, or `--bitonal-image` forms.
- The compressed annotated PDF keeps 2 pages, renders every page, and keeps both
  embedded annotations with the same types, rectangles, and content as the
  fixture.
- The compressed text/vector PDF keeps 2 pages, renders every page, and keeps
  extractable text.
- The compressed image-heavy PDF keeps 2 pages, renders every page, and its image
  streams are JPEG.
- The no-benefit attachment hash still equals the blank fixture.
- All fixture originals and the prepared encrypted input keep their recorded
  hashes.

Sizes: annotated 13988 to 2453 bytes (82.5% saved); text/vector 12816 to 1658
(87.1%); image-heavy 11524690 to 1273065 (89.0%). The blank fixture grows, so it
is the natural no-benefit case.

### Preset observation

The preset is the accepted option string, and the packaged bundle was checked for
it. On the image-heavy fixture, MuPDF re-encoded the images as JPEG but left
their pixel dimensions at 1200x1600. An ad-hoc run of the same binary with
`--color-image-subsample-dpi=149` produced a 600x800 image, while the accepted
`150` value does not, so MuPDF did not treat these fixture images as above the
150-DPI subsampling threshold. This records the engine's behavior on this
fixture; it is not a claim about downsampling on other documents, and it is not a
visual-quality approval.

## Evidence

All local, not committed:

- `.local-test/menu-tests/evidence-menu-final-8.json` — driver report, 15 checks.
- `.local-test/menu-tests/host-evidence-menu-final-8.json` — host checks.
- `.local-test/menu-tests/install-record.json` — installed artifact hashes.
- `.local-test/menu-tests/inputs/manifest.json` — prepared encrypted input.
- `.local-test/zotero/logs/menu-menu-final-8.log` — application debug log.

The launcher's workspace guard was active. The active workspace read 1 before and
after this run, and the guard recorded one focus correction for a test window.

## Limits

- Only Zotero 10.0.6 was run. The Zotero 7 manual menu-injection path in
  `src/menu.ts` is unexercised; it belongs to #19.
- The menu interaction uses Zotero's real menu builder and the built XUL command,
  not a synthesized pointer right-click. The test opens the submenu with a
  synthetic `popupshowing` and closes it with `popuphidden`, which is what a real
  hover and dismiss do; it does not exercise pointer focus.
- Disable and re-enable are exercised in one process. A second main window and a
  disable while the menu is open are not exercised.
- Linked-attachment Compression and Revert semantics belong to #13 and #15. This
  ticket shows only that the linked target is eligible in the menu.
- Sync is offline. `to_upload` and the unchanged last-synced values are local
  metadata; no upload or conflict was exercised.
- Session-folder preferences, startup cleanup, and crash leftovers belong to #16.
  This run used Zotero's temporary directory and normal shutdown.
- Revert behavior, including a fresh Compress after Revert, belongs to #15/#17.
- Visual quality and representative-document review belong to #19. The preset
  string and the engine's observed output are recorded here, not approved.
- The host engine binary requires GLIBC_2.43. Runtime requirements and any
  distribution baseline are #18/#19 decisions.
