# Isolated Zotero environment for #8

Prepared on 2026-10-28 for [#8](https://github.com/atsyplenkov/zotero-mupdf-compress/issues/8), ready for the Linux prototype in #9. User approved downloading and launching **Zotero 10.0.6 only**. Zotero 7 testing is deferred. No personal settings or library were copied, imported, or opened.

## Version and provenance

- Official standalone Linux x86_64 archive: <https://download.zotero.org/client/release/10.0.6/Zotero-10.0.6_linux-x86_64.tar.xz>
- Download size: 118303588 bytes.
- SHA-256 observed after download: `246c2574a9ac526abeaf3027ffd22fc45536a5ab25f227bb1df932fca9cedd63`.
- Extracted `app/application.ini`: `Version=10.0.6`, `BuildID=20261007153824`, Gecko `140.0`–`140.99.*`.
- The hash records the downloaded bytes; it is not an independently signed publisher checksum.

## Paths

The canonical repository path on this machine is `/home/ats/Development/zotero-mupdf-compress`. `/home/ats/Development/zotero-pdf-compresser` is a symlink to it. The launcher resolves the canonical path, so either working-directory spelling reaches the same test environment.

All paths below are relative to the repository root:

| Purpose | Path |
| --- | --- |
| Launcher | `scripts/test-environment/launch-zotero.sh` |
| Download | `.local-test/zotero/downloads/Zotero-10.0.6_linux-x86_64.tar.xz` |
| Executable | `.local-test/zotero/runtime/Zotero_linux-x86_64/zotero-bin` |
| Application definition | `.local-test/zotero/runtime/Zotero_linux-x86_64/app/application.ini` |
| Profile | `.local-test/zotero/profile` |
| Data and stored attachment storage | `.local-test/zotero/data` |
| Library database | `.local-test/zotero/data/zotero.sqlite` |
| Isolated HOME | `.local-test/zotero/home` |
| Isolated XDG config/cache/data/runtime | `.local-test/zotero/{config,cache,xdg-data,xdg-runtime}` |
| Temporary files | `.local-test/zotero/tmp` |
| Evidence and logs | `.local-test/zotero/logs` |

Downloads, runtime files, profiles, and databases are disposable local artifacts, not source files. No system Zotero installation or desktop registration was changed.

## Launch

Requires Linux x86_64, `bwrap` (bubblewrap), `python`, `hyprctl` with the current Hyprland Lua API, and an accessible X11 `DISPLAY`. Tested here with `DISPLAY=:0`. The launcher deliberately uses X11, not the inherited Wayland or session-bus environment.

Every future test launch must open silently on **workspace 6**, without switching the user's active workspace. Before creating a window, the launcher installs an in-memory named Lua window rule for the unique class `ZoteroCompressionTest`: `workspace="6 silent"`, `no_initial_focus=true`. It then passes `--class ZoteroCompressionTest` to Zotero. The rule is scoped to this test class, is reused across launches, and disappears on compositor reload; the launcher reapplies it as needed. No Hyprland config file is edited. If rule installation fails, the launcher refuses to start. Do not bypass the launcher or override its window class.

```sh
scripts/test-environment/launch-zotero.sh -ZoteroDebugText \
  > .local-test/zotero/logs/manual.log 2>&1
```

Keep that terminal alive and close the test Zotero window normally when finished. The launcher uses `--die-with-parent`; killing its supervising terminal is not a normal-shutdown test. Use this launcher, not the archive's `zotero` wrapper or a global `zotero` command. It executes:

```text
zotero-bin -app <isolated-runtime>/app/application.ini \
  -no-remote -profile <repo>/.local-test/zotero/profile \
  --class ZoteroCompressionTest
```

Before each launch, `profile/user.js` is regenerated with an explicit `extensions.zotero.dataDir`, `useDataDir=true`, auto-sync and file sync disabled, automatic translator updates disabled, and application/extension update preferences disabled. First-run sample content is suppressed. The empty test profile has no account credentials.

Bubblewrap supplies a private HOME, XDG directories, `/tmp`, `/proc`, and PID/network namespaces. The personal home and its default Zotero profile registry are not mounted. `/usr`, `/etc`, `/sys`, the repository, and the X11 socket are read-only mounts; `.local-test` is writable. No host session bus or host `/run` is mounted. Network isolation also blocks sync, update, and other HTTP requests even if a preference changes. This is a filesystem/network isolation measure, not a hostile-code security sandbox: X11 still connects to the user's desktop.

If bubblewrap, X11 access, or workspace routing fails, stop and report it. Do not fall back to an unsandboxed or unrouted launch. No Xauthority file was needed on this desktop; none was copied from the personal home.

### Fixtures and attachment setup for #9

The corpus is documented in [pdf-corpus.md](pdf-corpus.md). No attachments have been imported yet: the test library has zero items and zero attachments. Keep fixture originals unchanged. **Do not create linked attachments pointing directly at `.local-test/fixtures/*.pdf`**: compression replaces attachment bytes. Copy selected PDFs to a disposable directory such as `.local-test/zotero/linked/` and link those copies. This path is writable inside the sandbox. Stored attachment imports should use the isolated library's normal storage under `.local-test/zotero/data/storage/`.

Temporary-folder tests must also use a path inside `.local-test`, for example `.local-test/zotero/session-backups`. The rest of the repository is read-only inside Zotero. Never change data-directory preferences or sign into a Zotero account for this task. A future real sync test would require separate approval and a throwaway account; the current environment cannot reach the network.

## Checks performed

1. `bash -n scripts/test-environment/launch-zotero.sh` and `shellcheck scripts/test-environment/launch-zotero.sh`: passed.
2. Downloaded the official archive, ran `sha256sum`, and read its extracted `app/application.ini`: exact 10.0.6 version and hash above.
3. Launched with `-ZoteroDebugText`. `logs/startup.log` reports `Using data directory /home/ats/Development/zotero-mupdf-compress/.local-test/zotero/data`; startup created the database there. The first diagnostic run was stopped with SIGTERM to its own launcher; it is not evidence of normal shutdown.
4. Subsequent launches used the local diagnostic helper `logs/check-startup.py`. Inspected the test browser's `/proc/<pid>/root` and environment: `/home/ats` contained only the mounted `Development` directory; `/home/ats/Zotero`, `/home/ats/.zotero`, `/home/ats/.config`, and `/run/user/1000/bus` were absent. Its network namespace differed from the host. `logs/isolation-check.txt` records this and the explicit HOME/XDG values.
5. The helper recorded the single newly created X11 window (initially `WM_CLASS = Navigator, Zotero`; final routed check `Navigator, ZoteroCompressionTest`), then sent `WM_DELETE_WINDOW` only to that window. Each restart exited **0**. `logs/restart.log` contains `Shutting down Zotero`, `Closing database`, and `Database closed`.
6. Read the closed database with Python `sqlite3`, URI `mode=ro`: `PRAGMA integrity_check` returned `ok`; `items=0`, `itemAttachments=0`, and only user library ID 1 existed. Persisted preferences confirm the explicit data directory, auto-sync disabled, and file sync disabled.
7. Captured and inspected only the new Zotero window with `import -window <new-window-id> logs/zotero-window.png`: the empty My Library UI rendered correctly. The screenshot contains no personal library content. No reader or plugin UI has been tested.

Expected offline HTTP failures appear in debug logs for services such as the retraction list and citation locales. A `RenderCompositorSWGL failed mapping default framebuffer` warning appears at window close; it did not prevent the inspected library UI from rendering or normal exit. PDF-reader rendering still needs testing in #9.

8. After the user requested workspace-6 routing, tested the updated launcher: Hyprland reported class `ZoteroCompressionTest` on workspace **6**; the user's active workspace was **4 before and after**. This check made no screenshot and closed only its own new test window, with exit **0**. Evidence is in `logs/isolation-check.txt`. Earlier diagnostic launches preceded the workspace request; all later launches must use the routed launcher. The Lua syntax was checked against the current [official window-rule documentation](https://wiki.hypr.land/Configuring/Basics/Window-Rules/).

All test launches were stopped. The local diagnostic helper is an evidence artifact, not a general automated test: it expects exactly one new X11 window while it runs.

## Re-create the download/runtime

Run from the repository root; do not extract over a running test application:

```sh
mkdir -p .local-test/zotero/{downloads,runtime,logs}
curl --fail --location \
  'https://download.zotero.org/client/release/10.0.6/Zotero-10.0.6_linux-x86_64.tar.xz' \
  -o .local-test/zotero/downloads/Zotero-10.0.6_linux-x86_64.tar.xz
printf '%s  %s\n' \
  '246c2574a9ac526abeaf3027ffd22fc45536a5ab25f227bb1df932fca9cedd63' \
  '.local-test/zotero/downloads/Zotero-10.0.6_linux-x86_64.tar.xz' | sha256sum -c -
tar -xf .local-test/zotero/downloads/Zotero-10.0.6_linux-x86_64.tar.xz \
  -C .local-test/zotero/runtime
```

Stop if the checksum or extracted version differs. For a fresh profile, move the stopped `.local-test/zotero/profile` and `.local-test/zotero/data` directories aside together; the launcher creates empty replacements. Never remove or modify directories outside `.local-test` for a test reset.

## Not covered

Zotero 7 compatibility, extension installation, bundled MuPDF execution, stored/linked attachment operations, PDF-reader checks, annotation handling, sync, and the Compress/Revert lifecycle remain for #9. This setup does not claim those workflows work.
