# Session backup folder and cleanup (#16)

Checked on 2026-11-02 against Zotero 10.0.6 in the disposable profile from #8.
No personal library, personal Zotero profile, or private extension configuration
was opened. The prototype tree was not changed. The controlled
crash-during-operation run from #10 was not started.

## Versions and artifacts

- Zotero 10.0.6 (`BuildID=20261007153824`), isolated profile under `.local-test`.
- Extension `mupdf-compress@atsyplenkov.github.io` version 0.1.0. Tested XPI:
  size 31552714 bytes, SHA-256
  `6363af3484afc225a064f8eb2588879a63a26ca88dbb21e2ccb1bd5076faacc1`. A rebuild
  changes zip entry timestamps and therefore the hash even when the contents are
  equivalent.
- Throwaway driver `mupdf-compress-session-driver@test.invalid` version 0.1.0,
  size 8692 bytes, SHA-256
  `c65b62b4e827e8fb6c20797c79342c331cb20f0296c02483d9e7d110d778a98c`.
- Bundled engine: MuPDF 1.28.5, digest `036fc260...`, extracted to the profile at
  `mupdf-compress/036fc2602cfdccad/` with mode 0700. The host build still requires
  GLIBC_2.43; that is a known limitation, not an approved distribution baseline.

## Implementation

The temporary-folder preference is read once during `initSession`. The selected
folder must already exist, and creating the extension root proves it is writable.
A blank value uses `Zotero.getTempDirectory().path`. The session root is
`mupdf-compress-v1` under that folder, and the session itself is a UUID directory
with mode 0700. Backups are UUID-named PDFs with mode 0600; the attachment title
and source filename are not used.

An OS `flock` is held for the session by the bundled `session-lock` helper. The
helper prints `LOCKED` only after the lock is held, and the extension keeps its
stdin open until shutdown. A second helper on the same lock file fails without a
lock, which is how the checks distinguish ownership from a PID or lock-file
presence.

The root is created with `ignoreExisting: true` and then checked as a directory.
Before this ticket the root was created without that option: a second launch with
a persistent temporary folder would have failed because the root still existed.
Startup cleanup removes only recognized UUID session directories in the selected
root, and only after acquiring their exclusive lock. A locked session, a
recognized session with unknown content, a symlinked session, an unknown root
file, and entries in older temporary roots are left alone. A cleanup failure is
logged and does not widen the deletion scope.

Normal shutdown now registers a Zotero shutdown listener. On last-main-window
unload the extension also starts the same idempotent shutdown sequence: reject
new work, close owned feedback, wait for active operations, remove the current
session while the lock is still held, then release the lock. Closing the last
main window closes owned feedback windows and marks that window as closing, so a
finished operation cannot reopen a result window and keep Zotero running.
Feedback delivery errors remain separate from the verified file outcome.

## Checks run

The privileged driver and host scripts live under `.local-test/session-tests/`
and are intentionally not committed, matching the earlier tickets. Each driver
run refuses any profile other than `.local-test/zotero/profile`, claims one
explicit request, and writes its report incrementally. The main run seeded an
abandoned session, an externally locked session, an owned session with unknown
content, a symlink inside an owned session, a symlinked session directory, an
unknown root file, an outside sentinel, and a leftover in an older root. It then
drove real compression, a preference change, lock loss, a session restart, and a
normal window close. The restart run used the changed folder and closed the main
window during a paused operation.

| Check | Result |
| --- | --- |
| Startup cleanup removes the abandoned owned session and leaves the locked session, unknown content, symlinks, the outside sentinel, and the older root untouched | pass |
| The session lock belongs to an alive OS process, and a second helper on the same lock file fails with `Session lock unavailable` | pass |
| Compression creates one UUID-named 0600 backup in the private 0700 session directory, and the backup matches the original hash | pass |
| Changing the temporary folder does not move the active backup, does not create the next root, and the next Compression still uses the pinned session directory | pass |
| Killing the session-lock helper makes its loss visible; the next Compression reports `lock-unavailable`, leaves the attachment unchanged, creates no record, and removes the failed attempt backup | pass |
| A session restart removes the lockless abandoned session, creates a new private session directory, and Revert reports `no-record` without changing the compressed attachment | pass |
| A Compression before a normal close leaves a verified backup, and the normal close removes the session directory and backup | pass |

The restart run covered the next launch and normal shutdown:

| Check | Result |
| --- | --- |
| The changed temporary folder is active on the next launch, its abandoned seed is removed, its unknown content stays, and the previous and older roots are untouched | pass |
| The Settings pane shows the changed folder value | pass |
| A launch after the previous session offers no cross-session Revert: `no-record`, unchanged compressed bytes, no record | pass |
| Closing the main window during a paused Compression lets the operation finish, rejects new work with `stopped`, and removes the session and backup while the lock is still owned | pass |

A blank-preference run used Zotero's temporary directory and paused a Revert
instead of a Compression:

| Check | Result |
| --- | --- |
| A blank temporary folder uses `Zotero.getTempDirectory()`, and the active session is a private UUID directory below its `mupdf-compress-v1` root | pass |
| Compression creates an opaque backup in that session, and the backup is verified before Revert | pass |
| Closing the main window during a paused Revert lets Revert finish, restores the exact original bytes, removes the backup and record, rejects new work with `stopped`, and removes the session directory | pass |

The driver observed zero main windows while the paused Revert finished, and the
result was still a success. The progress window did not keep the process alive.

A startup-failure run pointed the preference at a regular file:

| Check | Result |
| --- | --- |
| Startup reports `ready: false` with a session failure, Compression reports `backup`, the attachment bytes stay unchanged, and no record is created | pass |

Host checks on the same artifacts:

- All four runs exited 0. The normal-close session directory and its backup are
  gone; the current root keeps only the seeded locked/unknown/symlink entries and
  the unknown root file.
- The next launch created `mupdf-compress-v1` only under the changed folder. The
  previous root was not searched. The older root still holds its seeded sessions.
- The outside sentinel still reads `outside sentinel`. The symlinked session
  target and the symlink inside the owned session still exist.
- `prefs.js` held the changed temporary folder after the normal close, then the
  blank value and the unusable path for the later runs.
- The blank-value Revert restored the fixture hash
  `ea84c99bfe83aedf6553f84844159967e06769c75ebf957a23a05771b66a03f8`; its session
  directory was gone after exit.
- The startup-failure attempt left the fixture at the same hash, and the
  unusable path is still a regular file.
- The busy-shutdown attachment is compressed (12,816 bytes to 1,658 bytes,
  87.1% saved) and the result is a success. The progress window closed with the
  main window; no feedback window kept the process alive.
- `git status` shows no change under `prototype/` or `prototype-tests/`.

## Evidence

All local, not committed:

- `.local-test/session-tests/evidence-sess16-main-final2.json` — driver report,
  7 checks.
- `.local-test/session-tests/host-evidence-sess16-main-final2.json` — host checks.
- `.local-test/session-tests/evidence-sess16-restart-final2.json` — driver report,
  3 checks.
- `.local-test/session-tests/host-evidence-sess16-restart-final2.json` — host
  checks.
- `.local-test/session-tests/evidence-sess16-revert-final.json` — blank-value
  Revert report, 3 checks.
- `.local-test/session-tests/host-evidence-sess16-revert-final.json` — host
  checks.
- `.local-test/session-tests/evidence-sess16-startup-final.json` — startup-failure
  report, 1 check.
- `.local-test/session-tests/host-evidence-sess16-startup-final.json` — host
  checks.
- `.local-test/session-tests/handoff.json` — item keys, paths, hashes, and the
  pre-close session path.
- `.local-test/session-tests/install-record.json` — installed artifact hashes.
- `.local-test/zotero/logs/session-sess16-main-final2.log`,
  `session-sess16-restart-final2.log`, `session-sess16-revert-final.log`, and
  `session-sess16-startup-final.log` — application debug logs.

The launcher's workspace guard was active. The active workspace read 3 before and
after all four runs; the guard recorded no focus correction.

## Limits

- Only Zotero 10.0.6 was run. Zotero 7 remains unexercised; that belongs to #19.
- The temporary-folder change was written through the same preference the pane
  binds to, not by typing in the Settings input. Pane display, editing, and
  persistence were checked in #11. This run reopens the pane and confirms the
  changed value after the next launch.
- The controlled crash-during-operation run from #10 was not started because no
  approval is recorded for it. Crash leftovers are represented by seeded owned
  directories; the restart check confirms there is no cross-session Revert.
- The lock-loss check sends SIGTERM to the helper from the driver. It does not
  cover a hostile process that removes or replaces directory components while
  the session runs.
- The startup-failure run fails before the lock helper starts, because the
  selected temporary path is a regular file. A helper-level failure at
  initialization is not isolated. The live lock is checked by the second-owner
  probe, and the loss path is checked separately.
- The busy-shutdown checks use a test hook to pause after the verified backup
  (Compression) and during replacement (Revert). They then close the real main
  window through X11 and release the hook. They do not prove that every possible
  subprocess failure during shutdown leaves the same result.
- Sync is offline. This ticket changes no sync metadata; stored/linked sync
  behavior remains as recorded in #15 and #17.
