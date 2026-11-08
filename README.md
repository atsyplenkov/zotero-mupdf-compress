# MuPDF Compress for Zotero

AGPL-3.0-or-later Zotero extension that compresses the selected stored or
linked PDFs, one after another, with a bundled MuPDF engine. This checkout currently
implements the plugin lifecycle, the Settings pane (#11), the single-attachment
context menu and stored-PDF Compression (#12), linked-PDF Compression (#13), the
parent-item menu for a sole PDF (#14), Revert with shared-path ownership and
partial recovery (#17), the session backup folder, ownership, and cleanup (#16),
and the distribution material: license, notices, build recipe, build record, and
packaged source (#18). The bundled
engine in this checkout is the host build; `BUILD-RECORD.md` records its measured
runtime requirements, including the GLIBC_2.43 limitation. That is not an
approved portable baseline.

The manifest targets Zotero 7 and newer. Only Zotero 10.0.6 has been run so far.

![](assets/interface.png)

## Build

Node 26.12.1 and npm 11.20.0 were used for the recorded build.

```sh
npm ci
make build
```

The installable XPI is `mu-pdf-compress_<version>.xpi` in the repository root.
`.scaffold/` holds internal build output. The build uses
`zotero-plugin-scaffold` and TypeScript. The add-on ID is
`mupdf-compress@atsyplenkov.github.io`.

The XPI also carries the distribution material the license requires:

- `LICENSE`, `notices/`, and `THIRD-PARTY.md` for the project, MuPDF,
  third-party libraries, CMaps, fonts, and hyphenation patterns.
- `SOURCE.md` for the MuPDF 1.28.5 source pin, source access, and build
  instructions.
- `native/build-engine.sh` and `native/session-lock.c` for the native build.
- `BUILD-RECORD.md` for the measured toolchain, flags, digests, linkage, and
  symbol requirements.
- `source/` for the matching TypeScript and build configuration.

`scripts/check-distribution.py` checks those packaged contents and runs as part
of `mise run check`. Distributing an XPI also requires the verified
`mupdf-1.28.5-source.tar.gz` archive to be available from the same place as the
XPI; `SOURCE.md` states that requirement.

## Releases

Zotero reads
`https://github.com/atsyplenkov/zotero-mupdf-compress/releases/download/release/update.json`.
Pushing a stable `vMAJOR.MINOR.PATCH` tag runs the release workflow. The tag must
match the version in `package.json` and point to the checked-out commit, including
when the workflow is started manually. Prerelease versions are rejected. The
workflow publishes `mu-pdf-compress.xpi` on the version tag and refreshes
`update.json` on the stable `release` tag. It refuses to replace a feed that
already offers a newer version, and it checks published version releases before
accepting a missing feed (HTTP 404). Other download errors and malformed feeds
stop publication.
The update manifest carries the same `strict_min_version` and
`strict_max_version` as the XPI manifest. An installed copy can then update
inside Zotero. A fresh install still uses the XPI from the version release.
The workflow first builds and checks the XPI, verifies the MuPDF source archive,
then uploads both files and the matching update manifest to a draft release. It
publishes the draft before refreshing the stable feed. A retry uses the files
from an already published version release and leaves them unchanged. The source
archive remains alongside the XPI on that release.

Copies installed with the old `example.invalid` update URL need one manual
installation of an XPI containing the real update URL. Subsequent releases can
then be discovered through Zotero's update check.

## Settings

Selecting MuPDF Compress in Zotero Settings shows one text field, Temporary
folder. A blank value means Zotero's temporary directory. The folder must already
exist and be writable. A change applies on the next Zotero launch; the current
session keeps its folder and backups. Session backups live in a private UUID
directory with an OS-held lock. Quitting Zotero or shutting the add-on down
removes the current session folder after any active operation finishes. Closing
a main window leaves the session folder in place. No quality preset, retention
setting, or recovery override is offered.

## Layout

- `addon/` contains the bootstrap lifecycle, manifest, default preferences, the
  Settings pane markup, the native binaries and their build recipe, and the
  distribution license and notice files.
- `src/` contains the TypeScript startup, main-window and pane registration, the
  context menu, target resolution, the attachment operation, the session
  backup/lock/lifecycle handling, and the bundled-engine runner.
- `scripts/check-distribution.py` checks the built XPI contents.
- `typings/` contains the sandbox globals and generated preference typing.
  `npm run build` regenerates `typings/prefs.d.ts` and an excluded
  `typings/i10n.d.ts`.

## Testing

`make test` runs `mise run check`, the completion gate also used by CI. It
includes lint, type checking, `node --test src/*.test.ts scripts/*.test.mjs`, the build, and the
distribution checks.

```sh
make test
```

The isolated-profile driver and host scripts are local under `.local-test/` and
are not committed. See
[docs/testing/zotero-environment.md](docs/testing/zotero-environment.md) for the
isolated Zotero launcher and
[docs/testing/pdf-corpus.md](docs/testing/pdf-corpus.md) for fixture generation.

## License

AGPL-3.0-or-later. The XPI carries `LICENSE`, the MuPDF license, the
third-party, CMap, and font notices, the native build recipe, the measured build
record, and the matching extension source. See `SOURCE.md` in the XPI for
corresponding-source access.
