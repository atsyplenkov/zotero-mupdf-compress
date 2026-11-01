# Compress one linked PDF (#13)

Checked on 2026-11-01 against Zotero 10.0.6 in the disposable profile from #8.
No personal library, personal Zotero profile, or private extension configuration
was opened. The prototype tree was not changed.

## Versions and artifacts

- Zotero 10.0.6 (`BuildID=20261007153824`), isolated profile under `.local-test`.
- Extension `mupdf-compress@atsyplenkov.github.io` version 0.1.0. Tested XPI:
  size 31263122 bytes, SHA-256
  `1dad07512e9e8f1e1217e108fd1b912bd366189321ce829f6cefeaeb9c62f995`. A rebuild
  changes zip entry timestamps and therefore the hash even when the contents are
  equivalent.
- Throwaway driver `mupdf-compress-linked-driver@test.invalid` version 0.1.0,
  SHA-256 `5d8a830056c2e1b6fefeaf51d67cec0abd44a5d8ab7267a2706223815f6ca0da`.
- Bundled engine: MuPDF 1.28.5, digest `036fc260…`, extracted to the profile at
  `mupdf-compress/036fc2602cfdccad/` with mode 0700. The host build still requires
  GLIBC_2.43; that is a known limitation, not an approved distribution baseline.

## Linked attachment handling

Compression resolves the attachment with `item.getFilePathAsync()`. An absolute
linked path and a base-directory-relative path (`attachments:…`) therefore reach
the same operation and the same resolved file. The replacement writes only at
that resolved path. The attachment item, its key, `attachmentPath`, and link mode
stay unchanged, so the link remains valid.

`src/operation.ts` calls `metadata()` after a verified replacement. That function
writes `to_upload` only when `item.isStoredFileAttachment()` is true. A linked
attachment keeps its existing `itemAttachments` values: `path`, `linkMode`,
`syncState`, `storageModTime`, and `storageHash`. Zotero's upload selection,
`Zotero.Sync.Storage.Local.getFilesToUpload()`, only includes stored link modes,
so the compressed linked file is not queued for upload.

The backup, validation, reader, and refusal rules are the shared stored-PDF
rules; there is no linked-specific branch in the operation.

## Checks run

The privileged driver and host scripts live under `.local-test/linked-tests/` and
are intentionally not committed, matching the earlier tickets. The driver
refuses any profile other than `.local-test/zotero/profile`, claims one explicit
request, and writes its report incrementally. Most checks build the item context
menu with `ZoteroPane.buildItemContextMenu()` and invoke the built XUL command.
That exercises the same builder and command path a right-click uses, but the
popup is opened with a synthetic `popupshowing` event. One check opens the real
item popup with `openPopupAtScreen()`, opens the real `Compress PDF` submenu with
`openMenu(true)`, and then invokes the built command. No check synthesizes a
device pointer click, so the real-pointer acceptance boundary in #10 is not
claimed here and remains for release acceptance.

| Check | Result |
| --- | --- |
| One absolute linked PDF exposes `Compress PDF > Compress`/`Revert`; Compression keeps the item, key, link mode, and resolved path | pass |
| A linked PDF compressed from the real opened item popup and submenu keeps the link and produces the same smaller output | pass |
| The linked file shrinks from 12,816 to 1,658 bytes (87.1% saved); the session record holds the original and installed hashes, and the backup hash matches the original | pass |
| The `itemAttachments` row keeps its `path`, `linkMode`, `syncState`, `storageModTime`, and `storageHash`; the in-memory sync state, synced hash, and synced modification time do not change | pass |
| The linked item is absent from `getFilesToUpload()` before and after Compression | pass |
| A base-directory-relative linked PDF (`attachments:…`) compresses at its resolved path and keeps the placeholder path | pass |
| An open reader blocks Compression with `open`; bytes and record state stay unchanged | pass |
| Invalid compressed output is rejected with `validation`; the linked file is unchanged and no record exists | pass |
| The blank fixture produces `no-benefit`; the linked file is unchanged and no record exists | pass |
| A missing linked file is explained with `missing`; no record exists | pass |
| An unwritable session folder blocks Compression with `backup`; the linked file is unchanged and no record exists | pass |
| A linked file changed during Compression is kept with `compress-changed`; no record exists | pass |
| An unavailable bundled engine produces `engine`; the linked file is unchanged and no record exists | pass |
| No `.mupdf-compress-*` output directory remains beside a linked file after success or failure | pass |

Host checks on the same artifacts:

- The XPI contains `native/mutool`, `native/session-lock`,
  `native/digests.json`, the Settings pane, the progress window, and the script
  bundle. Executable digests match `addon/native/digests.json`.
- The extracted `mutool` reports 1.28.5 and is mode 0700. `ldd` shows only
  `libc`, `libm`, and the loader for both native executables. No `mutool` is
  installed on the host `PATH`.
- The packaged bundle contains the accepted preset options and none of the
  prefixed image options.
- The successful linked output keeps 2 pages and renders both pages. The
  text/vector original also has 2 pages and renders both pages. The absolute and
  relative outputs have the same SHA-256,
  `46910b21fca9fae74b386cde9f7b7c11998ad9a25a535a663a2a4f978667388b`.
- All fixture originals keep their recorded hashes.
- `git status` shows no change under `prototype/` or `prototype-tests/`.

## Evidence

All local, not committed:

- `.local-test/linked-tests/evidence-linked-final-4.json` — driver report,
  10 checks.
- `.local-test/linked-tests/install-record.json` — installed artifact hashes.
- `.local-test/zotero/logs/linked-linked-final-4.log` — application debug log.

## Limits

- Linked Revert belongs to #15. This run shows only that failed linked attempts
  create no session record.
- The two linked path forms are absolute and base-directory-relative. A linked
  file reached through a symlinked path is rejected by the path check and was not
  exercised here.
- Only Zotero 10.0.6 was run. The Zotero 7 manual menu-injection path is
  unexercised; it belongs to #19.
- One menu check opens the real item popup and submenu and invokes the built
  command; it still does not synthesize a device pointer click. The real-pointer
  boundary is not exercised here.
- Sync is offline. The upload check is Zotero's local upload selection, not a
  remote upload or conflict.
- The corpus for this run is the text/vector and blank fixtures. Document
  compatibility and visual-quality approval belong to #19.
- The host engine binary requires GLIBC_2.43. Runtime requirements and any
  distribution baseline are #18/#19 decisions.
