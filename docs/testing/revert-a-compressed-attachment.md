# Revert a compressed attachment (#15)

Checked on 2026-11-02 against Zotero 10.0.6 in the disposable profile from #8.
No personal library, personal Zotero profile, or private extension configuration
was opened. The prototype tree was not changed.

## Versions and artifacts

- Zotero 10.0.6 (`BuildID=20261007153824`), isolated profile under `.local-test`.
- Extension `mupdf-compress@atsyplenkov.github.io` version 0.1.0. Tested XPI:
  size 31551797 bytes, SHA-256
  `e3a1fe7d00b2ff9adda1f1dbe192c0683547a29258b1a0afd339c67f84ec1402`. A rebuild
  changes zip entry timestamps and therefore the hash even when the contents are
  equivalent.
- Throwaway driver `mupdf-compress-revert-driver@test.invalid` version 0.1.0,
  size 9144 bytes, SHA-256
  `16565d5246b1f371168fe7067ec841b717c1eb10f4d8549f2d1d45c590477499`.
- Bundled engine: MuPDF 1.28.5, digest `036fc260…`, extracted to the profile at
  `mupdf-compress/036fc2602cfdccad/` with mode 0700. The host build still requires
  GLIBC_2.43; that is a known limitation, not an approved distribution baseline.

## Revert path

Revert uses the same attachment-operation entry point as Compress. The
`Compress PDF > Revert` menu command resolves the selected attachment with
`src/target.ts` and calls `operation.revert(target)`; no separate Revert target,
record, or attachment copy exists. The operation keeps one in-memory
`SessionRecord` keyed by `(libraryID, attachmentKey)` with the resolved path, the
opaque session backup, the original SHA-256, and the installed compressed
SHA-256.

A Revert requires that record, the same resolved path, and the installed
compressed hash. It checks the reader safeguard, verifies the backup against the
recorded original hash, writes a private sibling copy, repeats the reader, path,
and hash checks, and only then moves the copy onto the attachment path at the
same filename. The backup is removed, and the record deleted, only after the
replacement and the metadata step succeed. A stored attachment is marked
`to_upload` through the shared metadata step; a linked attachment is left alone
there. Failures before replacement keep the record and the backup, so the same
attachment can be retried during the session.

No product change was needed for this ticket: the Revert branch described above
was already present in the shared operation module. This run establishes that
the behavior in #15's acceptance criteria holds end to end. The checks are
recorded below.

## Checks run

The privileged driver and host scripts live under `.local-test/revert-tests/`
and are intentionally not committed, matching the earlier tickets. The driver
refuses any profile other than `.local-test/zotero/profile`, claims one explicit
request, and writes its report incrementally. Most checks call
`Zotero.MuPDFCompress.compress/revert`, the same entry point the menu command
uses. One check selects the attachment in the item pane, builds the item context
menu with `ZoteroPane.buildItemContextMenu()`, and invokes the built
`Compress PDF > Revert` XUL command. No check synthesizes a pointer right-click.

| Check | Result |
| --- | --- |
| Stored Revert returns the exact fixture bytes at the same path and keeps the item, key, parent, and storage mode | pass |
| The stored original is 13,988 bytes, the installed compressed file is 2,453 bytes, and Revert restores the original SHA-256 `4b4b8769…` | pass |
| A second Compress before Revert reports `repeated`, changes no bytes, and leaves the record untouched | pass |
| Successful stored Revert consumes the record and backup, and a fresh Compress then succeeds | pass |
| Stored Revert marks the file `to_upload` and keeps the last-synced hash and modification time (`1234567890000`, `0123456789abcdef…`); the item is selected for upload | pass |
| Native highlight and note keys, parents, positions, and sort indices survive Compression and Revert | pass |
| Linked Revert returns the exact fixture bytes at its resolved path and keeps the item, key, absolute `attachmentPath`, and link mode | pass |
| Linked Revert assigns no sync state: `itemAttachments` path, `linkMode`, `syncState`, `storageModTime`, and `storageHash` are unchanged and the item stays out of `getFilesToUpload()` | pass |
| The `Compress PDF > Revert` menu command restores the compressed linked file and shows the Revert success result | pass |
| A timestamp-only change does not block Revert; the original bytes return | pass |
| Changed bytes block Revert with `revert-changed`, keep the changed bytes, and retain the record and backup; restoring the compressed bytes permits a retry | pass |
| A missing attachment blocks Revert with `missing` and retains the record; restoring the compressed file permits a retry | pass |
| A changed link path blocks Revert with `revert-changed` without touching the moved file; restoring the recorded path permits a retry | pass |
| A missing backup blocks Revert with `backup-invalid` without consuming the record; restoring the same valid backup permits a retry | pass |
| A corrupt backup blocks Revert with `backup-invalid` and keeps its corrupt bytes; restoring the valid bytes permits a retry | pass |
| An unreadable backup (mode 0000) blocks Revert with `backup-invalid`; restoring mode 0600 permits a retry | pass |
| An open reader blocks Revert with `open`, leaves the compressed bytes and backup intact, and a retry succeeds after the reader closes | pass |
| A reader opened through another linked attachment on the same file blocks Revert the same way | pass |
| A metadata failure after restoration reports `partial` with restored bytes, keeps the verified backup and `restored-awaiting-metadata` record, and a metadata-only retry completes without rewriting the file | pass |
| Blocked Revert results explain themselves and offer no override; no confirmation dialog appeared during Revert | pass |
| The progress window reaches the named stage `Reverting`, and the result window names `Revert` and reaches `Complete` | pass |

Host checks on the same artifacts:

- The restored stored file is byte-identical to `.local-test/fixtures/annotated.pdf`
  (SHA-256 `4b4b8769df6f62af65aeaae849ba487bda0e098838f5afae553a0b705ca333fc`).
  It keeps 2 pages and renders every page. Its embedded Highlight and Text
  annotations keep the same pages, rectangles, and note content as the fixture.
- The restored linked file and the menu-restored file are byte-identical to
  `.local-test/fixtures/text-vector.pdf`
  (SHA-256 `ea84c99bfe83aedf6553f84844159967e06769c75ebf957a23a05771b66a03f8`).
- The database row for the stored attachment keeps `storage:stored-revert-15-final-1.pdf`,
  `linkMode=0`, `syncState=0` (`to_upload`), `storageModTime=1234567890000`, and
  `storageHash=0123456789abcdef0123456789abcdef`. The linked row keeps its path,
  `linkMode=2`, `syncState=0`, and null synced values.
- The database keeps native annotation `XJGQ4NRL` (highlight) and `XB6GQLMZ`
  (note) with parent item 648 and the positions and sort indices recorded before
  Compression.
- The session backup used for the stored attachment no longer exists, and no
  `.mupdf-compress-*` output directory remains beside either linked file.
- The XPI and driver hashes match the install record. The XPI contains
  `native/mutool`, `native/session-lock`, and `native/digests.json`; executable
  digests match `addon/native/digests.json`; `mutool -v` reports 1.28.5; `ldd`
  shows only `libm`, `libc`, and the loader.
- The packaged bundle contains the accepted preset options and none of the
  prefixed image forms.
- All fixture originals keep their recorded hashes, and `git status` shows no
  change under `prototype/` or `prototype-tests/`.

Sizes: stored annotated 13,988 to 2,453 bytes (82.5% saved); linked text/vector
12,816 to 1,658 bytes (87.1%). Revert restored both to their fixture hashes.

## Evidence

All local, not committed:

- `.local-test/revert-tests/evidence-revert-15-final-1.json` — driver report,
  13 checks.
- `.local-test/revert-tests/host-evidence-revert-15-final-1.json` — host checks.
- `.local-test/revert-tests/install-record.json` — installed artifact hashes.
- `.local-test/zotero/logs/revert-revert-15-final-1.log` — application debug log.

The launcher's workspace guard was active. The active workspace read 2 before and
after this run; the reader checks opened on workspace 6, and the guard recorded
no focus correction.

## Limits

- Only Zotero 10.0.6 was run. The Zotero 7 manual menu-injection path in
  `src/menu.ts` is unexercised; it belongs to #19.
- One Revert is invoked through Zotero's real menu builder and the built XUL
  command. The rest use the same operation entry point directly. No check
  synthesizes a device pointer click.
- Sync is offline. `to_upload` and the unchanged last-synced values are local
  metadata; no remote upload or conflict was exercised.
- The "unreadable backup" case uses mode 0000 in the disposable profile. It does
  not test a full disk, an I/O error, or a backup replaced by a directory.
- The changed-path case uses a linked attachment relink. A stored attachment's
  storage directory move was not exercised separately.
- The timestamp-only case forces the modification time backward. Other
  timestamp representations and filesystem races were not tested.
- Reader state still comes from Zotero's private reader list, and the
  fail-closed path for an unavailable list belongs to #12.
- Session-folder preference changes, startup cleanup, crash leftovers, and
  cross-session behavior belong to #16. This run used Zotero's temporary
  directory and a normal shutdown.
- Visual quality and document-compatibility approval belong to #19. This run
  checks byte restoration and the recorded annotations, not human-visible
  fidelity of compressed output.
