# Settings pane and plugin lifecycle (#11)

Checked on 2026-10-28 against Zotero 10.0.6 in the disposable profile from #8.
No personal library, personal Zotero profile, or private extension configuration
was opened.

## Reported fault and reproduction

The user reported that selecting MuPDF Compress in Settings left another
extension's pane visible. The prototype reproduced the fault in the isolated
profile with these versions:

- Zotero 10.0.6 (`BuildID=20261007153824`), isolated profile under `.local-test`.
- Prototype extension `mupdf-compress-prototype@zotero.local`, version 0.0.1.
- No PDFerret installation. The previously selected built-in General pane stood
  in for another extension's pane; the mechanism is the same for any pane.

The driver opened Settings, selected `zotero-prefpane-general`, then set the
navigation value to `mupdf-compress-prototype-preferences`. The pane entry stayed
`loaded: false` with an empty, hidden container. The General container stayed
visible while the navigation value named the prototype pane. The debug log
recorded:

```text
JavaScript error: jar:file:///.../mupdf-compress-prototype@zotero.local.xpi!/content/preferences.js, line 5: TypeError: can't access property "value", input is null
```

The cause is the order inside Zotero's pane loader. `Zotero_Preferences._loadPane`
runs the pane `scripts` before it inserts the pane markup. The prototype script
called `document.getElementById("mupdf-compress-temporary-folder")` during that
early run, found null, and threw on `.value`. The exception aborted the pane
switch before the code that hides the other pane containers. That is why a
selected MuPDF Compress pane could show the previous pane's content.

Evidence: `.local-test/repro/evidence.json` and
`.local-test/zotero/logs/repro.log` (local artifacts). The prototype tree was
left unchanged.

## Implementation

The release extension is `mupdf-compress@atsyplenkov.github.io`, version 0.1.0.
It uses the community template lifecycle and the scaffold build:

- `addon/bootstrap.js` registers chrome, loads the TypeScript bundle, and awaits
  `onStartup`. It implements `onMainWindowLoad`, `onMainWindowUnload`, and
  `shutdown`.
- `src/hooks.ts` registers one preference pane at startup, tracks every open
  main window, and on shutdown unregisters the pane, clears the window
  registrations, marks the add-on inactive, and deletes the global add-on
  object. Disable, uninstall, and upgrade therefore remove the owned pane.
  `APP_SHUTDOWN` returns early, as in the template; Zotero's plugin shutdown
  observer removes panes during application quit.
- `addon/content/preferences.xhtml` is static XHTML with a declarative
  `preference="extensions.mupdf-compress.temporaryFolder"` binding. It has no
  pane script, so the pane cannot run before its markup exists. Zotero's own
  preference binding loads and saves the value.
- `addon/prefs.js` sets the default to an empty string. The pane explains that
  blank means Zotero's temporary directory, that the folder must already exist
  and be writable, and that changes take effect on the next Zotero launch.
- The pane offers one text input. It has no quality preset, retention setting,
  or recovery override.
- No context menu is registered in this ticket. Menu ownership and cleanup are
  in #14; this ticket covers the pane and the shared lifecycle cleanup path.

The resource build is `zotero-plugin-scaffold` 0.8.2 with TypeScript 5.9.3 and
`zotero-types` 4.1.0-beta.4. The built XPI is
`.scaffold/build/mu-pdf-compress.xpi`.

One implementation note: adding a plugin locale file made Zotero 10.0.6 log an
unhandled rejection with an undefined reason during its plugin locale rebuild,
once at startup and once at plugin disable. The pane text is therefore plain
English for now. Recheck that Zotero behavior before adding Fluent locales.

## Checks run

The privileged driver and host scripts live under `.local-test/settings-tests/`
and are intentionally not committed, matching the decision for this ticket. They
refuse any profile other than `.local-test/zotero/profile`, claim one explicit
request, and leave the report in `.local-test/settings-tests/`.

The packaged XPI was installed into the stopped disposable profile. The manifest
was checked for the add-on ID, a nonempty update URL, and the version range. The
XPI contains `content/preferences.xhtml` with the declarative preference binding,
`prefs.js` with a blank default, and no pane script. Installed artifact:

```text
SHA-256 e80399577676c77bdaf727fa7a7310ff7835784c81fcf594f06b40a612d64f1c
size    2797 bytes
ID      mupdf-compress@atsyplenkov.github.io
version 0.1.0
min/max 6.999 / 10.0.*
```

The hash identifies the exact tested bytes. Rebuilding the XPI changes zip entry
timestamps and therefore the hash even when the contents are equivalent.

The suite result is six passes with no failures and no skipped checks, plus an
application restart pair:

| Check | Result |
| --- | --- |
| Startup registers one owned pane, zero pane scripts, and the main window | pass |
| A fixture extension's pane loads with only its own content | pass |
| Saved value is shown after switching from the fixture pane to MuPDF Compress | pass |
| Editing saves the value; blank saves blank; the reopened pane shows blank | pass |
| Clearing the user value falls back to the blank default | pass |
| Switching back to the fixture pane hides the MuPDF pane and leaves no MuPDF text there | pass |
| Disable removes the pane, window registrations, and the add-on global | pass |
| A seeded value appears in `prefs.js` and is shown after an application restart | pass |

The disable check also confirmed that the fixture pane remained and the MuPDF
Compress navigation item was gone. The restart check reset the preference to
blank after reading it. Each run exited normally with status 0. No unhandled
rejection from the extension was observed. The suite ran with a workspace guard;
the user's active workspace stayed unchanged before and after the final suite,
seed, and restart runs (workspace 1 in the last cycle).

Evidence, all local:

- `.local-test/settings-tests/evidence-settings-final.json`
- `.local-test/settings-tests/evidence-persist-final-seed.json`
- `.local-test/settings-tests/evidence-persist-final-check.json`
- `.local-test/settings-tests/install-record.json`
- `.local-test/zotero/logs/settings-settings-final.log`

Expected unrelated console messages in the isolated profile were the offline
server message and missing `fileRenaming.ftl` resources for non-English locales.
They are not produced by this extension.

## Limits

- Only Zotero 10.0.6 was run. Zotero 7 remains untested; the manifest targets
  Zotero 7 and newer but does not claim tested compatibility.
- Menus are out of scope for #11 and belong to #14.
- Resolving a blank value to Zotero's temporary directory, pinning the folder at
  session start, session backups, and cleanup belong to #16. This ticket checks
  the saved string and the blank default only.
- The update URL is the reserved `example.invalid` placeholder. Distribution,
  licenses, notices, and a real feed belong to #18.
- No compression, bundled engine, progress window, or session record exists in
  this tree yet.
