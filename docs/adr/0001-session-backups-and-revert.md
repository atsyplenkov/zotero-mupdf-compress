# Session backups and Revert

Accepted for [ticket #6](https://github.com/atsyplenkov/zotero-mupdf-compress/issues/6).

Keep one verified original PDF per successfully compressed attachment for the current Zotero session. Block another Compress until successful Revert. This avoids repeated lossy compression and makes Revert unambiguous without introducing persistent history.

## Identity and location

- Key in-memory records by `(libraryID, attachmentKey)`, not filename or path. Each record stores the resolved attachment path, backup path, original SHA-256 hash, and the SHA-256 hash of the successfully installed compressed PDF.
- Use an extension-owned root under the selected temporary folder, with a private UUID directory for each session and opaque UUID-based backup filenames. Do not put attachment titles or source filenames in backup names.
- Fix the temporary-folder choice when the session starts. Preference changes apply on the next Zotero launch; never migrate active backups during a session.
- Revert records exist only in memory. Leftover directories from a crash do not enable Revert in a later session.

## Compress lifecycle

1. Serialize Compress and Revert operations for each attachment. Reject Compress while that attachment has an active successful compression record.
2. Resolve the attachment path, apply the open-reader safeguard, and hash the input. Create a complete backup in the owned session directory and verify its SHA-256 hash against the input before replacing any attachment bytes.
3. Produce and validate smaller output according to the decisions in #5. Failed compression, failed validation, or output that is not smaller leaves the attachment unchanged and creates no Revert state.
4. Immediately before replacement, recheck the resolved path and input hash. If either changed, stop without replacing the attachment. Apply the replacement and stored/linked attachment handling settled in #3.
5. Record the installed compressed content hash and enable Revert only after successful replacement. Preserve the verified backup if replacement occurred but a later metadata/UI step failed; report the incomplete operation without losing recovery information.

A missing, unwritable, or unverifiable backup location prevents replacement. Compression without a verified backup is not offered. Temporary files from unsuccessful attempts can be removed only within the owned session directory or at explicitly tracked output paths; they are not successful compression records.

## Revert lifecycle

1. Require the current session's record and a readable backup whose SHA-256 hash matches the recorded original.
2. Require the same resolved attachment path and SHA-256 content hash as the installed compressed PDF. A missing attachment, changed path, or changed bytes blocks Revert. Timestamp-only changes do not block it. Do not offer a force-overwrite fallback.
3. Apply the open-reader safeguard. Prepare a verified sibling copy of the backup, then recheck the attachment path and compressed content hash immediately before replacing the attachment. Keep the backup intact until restoration succeeds.
4. Restore at the same attachment path and apply the stored/linked attachment handling from #3. After successful Revert, remove the record and backup. The attachment can then be compressed again, creating a new backup.

A missing or unreadable backup blocks Revert without changing the attachment. Retain the record and any remaining backup for retry until successful Revert or session cleanup. Failed Revert never consumes the backup. If restoration succeeds but subsequent metadata/UI work fails, keep recovery information and report the partial failure; do not silently treat it as a completed Revert.

The hash rule detects changed bytes at the final check. It does not promise to prevent an unrelated process from writing between that check and replacement. The prototype must document and test the limits of its replacement and locking implementation.

## Ownership and cleanup

- Hold an OS-released exclusive lock for the lifetime of each active session directory. A PID, timestamp, or mere lock-file presence is not sufficient proof that a directory is abandoned.
- Startup cleanup may delete only recognized extension-owned session directories for which it has acquired exclusive ownership. Never delete an active session's backups, unrelated temporary files, or paths reached through symlinks. Do not recursively follow symlinks during deletion.
- Run startup cleanup in the selected temporary root. If a preference change leaves crash leftovers in an older root, leave those untouched until that root is selected again; do not search arbitrary old folders.
- On normal shutdown, reject new operations and wait for active operations to finish before deleting the current session's backups. Keep ownership until cleanup is complete. Backups retained after failures still expire at session cleanup.
- If cleanup fails, leave the remaining owned files for a later safe cleanup attempt. Never broaden deletion scope to make cleanup succeed.

Safe cross-process ownership is an implementation requirement, not a confirmed Zotero API capability. If it cannot be established, stop before compression. Ticket #9 must verify the lock mechanism and crash/shutdown behavior before claiming this lifecycle works.

## Prototype acceptance checks

- Successful Compress creates one verified backup; a second Compress is blocked. Successful Revert restores the original bytes and allows a new Compress.
- Failed compression, invalid output, output that is not smaller, and failed backup verification leave the attachment unchanged and do not enable Revert.
- A changed file, missing attachment, or changed resolved path blocks Revert without overwrite. A timestamp-only change permits Revert.
- A missing or unreadable backup blocks Revert without consuming the session record; making the same valid backup available again permits retry.
- Changing the temporary-folder preference leaves current backups in place and takes effect on the next launch.
- Startup cleanup leaves a concurrently locked session untouched, removes an abandoned recognized directory only after acquiring ownership, and never follows symlinks or deletes unrelated files.
- Normal shutdown waits for an in-progress operation before cleanup. Restart after a crash offers no cross-session Revert.
- Exercise stored and linked attachments, backup corruption, partial replacement/metadata failures, external-write races, and unavailable locking. Report any unverified behavior explicitly.
