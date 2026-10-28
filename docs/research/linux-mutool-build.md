# Bundling a pinned native `mutool` for Linux

Research for ticket #4. Date: 2026-10-28.

## Bottom line

Build `mutool` from the pinned MuPDF `1.28.5` source tarball; MuPDF publishes no Linux binary for current releases. `make tools` produces a single self-contained executable, so the XPI ships exactly one engine file. The plugin extracts it from its `jar:` root into a writable per-profile directory, verifies its SHA-256, sets mode `0755`, and runs it through `Zotero.Utilities.Internal.exec()`.

AGPL compliance needs three things published with the XPI: the MuPDF license text, third-party and embedded-resource notices, and equivalent access to the Corresponding Source for the exact build (tarball plus build recipe).

## 1. Pinned artifact

| Item | Value |
| --- | --- |
| Release | MuPDF 1.28.5, released 2026-09-25 ([release history](https://mupdf.com/releases/history)) |
| Source tarball | `https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz` ([releases page](https://mupdf.com/releases)) |
| Size | 68,919,385 bytes |
| SHA-256 | `98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934` (computed from that URL on 2026-10-28) |
| Top-level directory | `mupdf-1.28.5-source/` |

The releases page lists only these 1.28.5 artifacts: `-source.tar.gz`, `-source.tar.lz`, `-windows.zip`, and two Android APKs. No Linux binary is published for 1.28.5, so "obtain" collapses into "build".

The tarball is self-contained: it includes the trimmed third-party sources (7,168 files under `thirdparty/`), so no submodule checkout is needed. `thirdparty/README` states that tarball copies "have been stripped down for size and do not include test files and other auxiliary data", and that empty or missing directories would make the build fall back to system libraries.

## 2. Reproducible build

```sh
curl -fSLO https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz
echo "98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934  mupdf-1.28.5-source.tar.gz" | sha256sum -c -
tar xf mupdf-1.28.5-source.tar.gz
make -C mupdf-1.28.5-source \
  build=release tools \
  HAVE_X11=no HAVE_GLUT=no \
  HAVE_LIBCRYPTO=no HAVE_CURL=no
install -m 0755 mupdf-1.28.5-source/build/release/mutool addon/bin/linux-x64/mutool
```

Why each flag:

- `tools` builds only the command-line tools, not the viewers. The install guide notes viewers need X11/OpenGL headers, while `make tools` exists precisely to build "the MuPDF library command line tools" ([Installing](https://mupdf.readthedocs.io/en/latest/guide/install.html)). `TOOL_APPS` is just `mutool` (`Makefile` 1.28.5, lines 377-380, 476).
- `build=release` is the default (`Makefile` lines 4-6) and adds `-O2 -DNDEBUG` plus a stripped link (`Makerules` lines 157-158), so no extra `strip` step is needed.
- `HAVE_X11=no` / `HAVE_GLUT=no` stop the `pkg-config` probes and any X11 linkage (`Makerules` lines 337-343); the settings survive because command-line variables are not overridden by the makefiles.
- `HAVE_LIBCRYPTO=no` and `HAVE_CURL=no` prevent the build host's `pkg-config` results from adding shared-library dependencies that `mutool clean` does not need (`Makerules` lines 344-350; `Makethird` lines 15-25). Without them, a build machine with `libcurl` or `libcrypto` development packages present would link them and create a runtime dependency.
- `USE_SYSTEM_LIBS` stays unset: system libraries are used only when it is `yes` (`Makethird` line 3), so the bundled third-party code is compiled in.

Build-only tools: a C compiler, `make`, and binutils (`ld`, `objcopy`; `objcopy` embeds font and hyphenation resources, `Makefile` lines 86, 252-260, 278-283). `pkg-config` is optional once X11/GLUT are disabled.

**Determinism is partial.** MuPDF does not document reproducible builds. For a distributable artifact, record the compiler version and build inside a pinned container image digest, then publish the resulting binary's SHA-256 in the repository. Which container/glibc baseline to standardise on is a prototype decision, not settled here.

## 3. What ships inside the XPI

Only `mutool`. The install guide states that "the tools and viewers are portable executables that don't need any auxiliary files, so can be run from anywhere" ([Installing](https://mupdf.readthedocs.io/en/latest/guide/install.html)). That matches the source layout: fonts and hyphenation patterns are embedded at build time through `objcopy` or generated C (`Makefile` lines 252-260, 278-283), CMaps are compiled in as headers under `source/pdf/cmaps/`, and `mutool` links the static archives `libmupdf.a`, `libmupdf-third.a`, `libmupdf-threads.a`, `libmupdf-pkcs7.a` (`Makefile` lines 345-362, 377-379).

The `resources/` directory in the tarball therefore supplies build inputs and license notices, not runtime files.

## 4. Runtime dependencies

With the flags above, the link line adds only `-lm` and `-lpthread` (`Makefile` lines 26, 34-35; `Makerules` lines 353-356); the MuPDF and third-party code is statically included. On glibc 2.34 and later, `libpthread` is merged into `libc`, so the effective runtime dependency is the C library and `libm`.

Consequences for distribution:

- Binaries link against the build host's glibc symbol versions. A binary built on an older glibc runs on newer systems, but not the reverse ([glibc manual, Versioning](https://www.gnu.org/software/libc/manual/html_node/Versioning.html)). For an XPI used across distributions, build in a container pinned to the oldest glibc you intend to support.
- **Not verified here:** the exact `ldd` output, symbol-version tags, and binary size. This ticket must not build the binary, so the build ticket must run `ldd`, `readelf -V`, `mutool -v`, and record the file size.

## 5. Extracting and executing from the XPI

### Where the engine comes from

Zotero passes each plugin its `rootURI`, taken from `addon.getResourceURI().spec` (`chrome/content/zotero/xpcom/plugins.js`, line 254). For an installed `.xpi` this is a `jar:file:///…xpi!/` URI; `Zotero.Plugins.getRootURI()` and `resolveURI()` build resource URLs for it (lines 313-331). Zotero's own `getResourceAsync` documents the same reality: it goes "through an nsIChannel to handle jar: URLs containing '@'" (`xpcom/file.js`, lines 368-376).

### Reading binary bytes

`Zotero.File.getResourceAsync()` returns a UTF-8 **string** and would corrupt a native binary; `Zotero.File.getBinaryContentsAsync()` accepts only native paths and file URIs (`file.js`, lines 312-330). Two routes work:

1. **Channel route (recommended).** Build the channel the same way `getResourceAsync` does (`NetUtil.newChannel` with `loadUsingSystemPrincipal`), then `NetUtil.asyncFetch` and drain it with `nsIBinaryInputStream`. This mirrors Zotero's own jar-with-`@` handling.
2. **Raw XHR route.** `XMLHttpRequest` is exposed to plugin sandboxes, and another shipping Zotero plugin reports extracting a bundled Ghostscript binary this way ([LeeWin0531/zotero-pdf-compress README](https://github.com/LeeWin0531/zotero-pdf-compress), third-party precedent, not a specification).

Do **not** use `Zotero.HTTP.request()` naively here: it treats only `nsIFileChannel` as a file (`xpcom/http.js`, line 327) and accepts status 0 only for those channels (line 481). A `jar:` request reports status 0 and would be rejected unless `successCodes` is overridden. `IOUtils.read()` takes native paths, not jar URIs.

### Writing, permissions, and cache location

- `IOUtils`, `PathUtils`, `crypto`, and `XMLHttpRequest` are globals in the plugin sandbox (`plugins.js`, lines 141-173; the same globals are present in Zotero 7.0, `plugins.js` lines 132-161).
- Write with `IOUtils.write(path, new Uint8Array(bytes), { mode: 'create' })`; Zotero itself uses this form (`file.js`, line 1245).
- Set the executable bit with `IOUtils.setPermissions(path, 0o755)`. Zotero uses the same API with `0o644` for normal files (`file.js`, line 930; Zotero 7.0 `file.js`, lines 905-906). The `0o755` mode is the standard Unix encoding; confirm it in the prototype.
- Cache under the profile directory, `Zotero.Profile.dir` (`xpcom/profile.js`, line 30), for example `<profile>/mupdf-compress/bin/mutool-1.28.5/mutool`. `Zotero.DataDirectory.dir` (`xpcom/dataDirectory.js`, line 33) also works but often sits in a user-synced folder, which is a poor place for a large binary. The user-configurable temp folder is for session backups, not for the engine.
- Verify the extracted file's SHA-256 (via `crypto.subtle.digest`) against a pinned constant before `chmod`/execution, and re-extract on mismatch or absence.

**Unverified:** behaviour when the profile directory sits on a `noexec` mount. The prototype should surface a clear error naming the binary path rather than retrying blindly; a fallback location is a later decision.

### Running it

`Zotero.Utilities.Internal.exec(path, args)` throws when the target is not executable, resolves on exit status 0, and rejects otherwise (`utilities_internal.js`, lines 690-712; Zotero 7.0 lines 591-615). Its sibling `subprocess(command, args)` returns stdout (`utilities_internal.js`, lines 729-746; 7.0 line 630) and is the better option when diagnostics are needed.

`exec()` gives only an exit status, with no stderr, so the prototype cannot yet distinguish "encrypted PDF" from "corrupt PDF" from "disk full". That distinction belongs to the validation ticket and may require raw `Subprocess.call` for piped stderr.

## 6. AGPL and notice artifacts

The MuPDF tarball carries the AGPL-3.0 text in `COPYING`, and the project is offered under "either version 3 of the GNU Affero General Public License" or a commercial license ([MuPDF license](https://mupdf.readthedocs.io/en/latest/license.html); `README` inside the tarball).

Distributing an XPI that contains `mutool` conveys MuPDF in object-code form. AGPL §6 then requires conveying the Corresponding Source by one of its listed means; §6(d) permits "offer[ing] equivalent access to the Corresponding Source in the same way through the same place at no further charge" ([AGPL-3.0 text](https://www.gnu.org/licenses/agpl-3.0.txt)). §4 requires giving recipients a copy of the license.

Publish with each release:

- the `.xpi`;
- a mirror of `mupdf-1.28.5-source.tar.gz` (or an equivalent-access link on the same release page) plus `SHA256SUMS`;
- the build recipe and compiler/container details used for that binary.

Put inside the XPI:

- `LICENSES/MuPDF-COPYING` — the AGPL-3.0 text;
- `LICENSES/THIRD-PARTY.md` — notices for the third-party code compiled into `mutool` and for embedded resources;
- `LICENSES/SOURCE.md` — the exact source URL, SHA-256, build command, and a statement that MuPDF was not modified.

Notices must cover the default `mutool` build, which includes freetype, harfbuzz, gumbo-parser, cmark-gfm, jbig2dec, libjpeg, lcms2, mujs, openjpeg, zlib, brotli, and extract (enabled by default in `Makerules` lines 30-60; `Makethird` compiles the bundled copies). Each of those directories ships its own license file in the tarball, for example `thirdparty/freetype/LICENSE.TXT`, `thirdparty/harfbuzz/COPYING`, `thirdparty/zlib/LICENSE`, `thirdparty/openjpeg/LICENSE`.

Embedded resources add two more notices:

- **Adobe CMaps.** `resources/README` states the CMaps "are from Adobe and are covered by their own copyright and license"; the upstream license is a BSD-3-Clause-style text requiring the notice in binary distributions ([cmap-resources LICENSE](https://github.com/adobe-type-tools/cmap-resources/blob/master/LICENSE.md)).
- **Fonts and hyphenation data.** `resources/fonts/` carries `droid/NOTICE`, `noto/COPYING`, and `han/LICENSE.txt`; `resources/hyphen/` supplies the hyphenation patterns. Include these files in `THIRD-PARTY.md` rather than summarising them.

Because the extension itself is AGPL-3.0-or-later (project decision), its source stays public in this repository, which also satisfies the source-availability expectation for the plugin code. No MuPDF patches are planned; if one is ever added, §5(a) requires a prominent modification notice and date, and the modified source must ship.

Artifex's licensing page describes the AGPL as requiring source disclosure for server-based use and offering a commercial alternative for closed distribution ([Artifex licensing](https://artifex.com/licensing)). This project is local, desktop-only, and AGPL, so that page adds no extra obligation beyond §§4-6.

## 7. What this ticket settles, and what stays open

Settled:

- Build from the pinned 1.28.5 source tarball; there is no official Linux binary to fetch.
- The XPI ships one file, `mutool`; no runtime resource directory is needed.
- Extraction, integrity check, `0755`, and execution use APIs present in both Zotero 7.0 and current master.
- The compliance bundle: license text, third-party and embedded-resource notices, and same-place source access.

Open for the build/prototype tickets:

- Binary size, `ldd` output, and symbol-version baseline — measure, do not assume.
- glibc/container baseline for a distributable artifact.
- Which jar-reading route survives contact with Zotero 7 in practice.
- `IOUtils.setPermissions(…, 0o755)` behaviour on the target systems.
- `noexec` fallback and stderr diagnostics.

## Sources

- MuPDF, [Installing](https://mupdf.readthedocs.io/en/latest/guide/install.html)
- MuPDF, [Releases](https://mupdf.com/releases) and [release history](https://mupdf.com/releases/history)
- MuPDF 1.28.5, [`Makefile`](https://raw.githubusercontent.com/ArtifexSoftware/mupdf/1.28.5/Makefile), [`Makerules`](https://raw.githubusercontent.com/ArtifexSoftware/mupdf/1.28.5/Makerules), [`Makethird`](https://raw.githubusercontent.com/ArtifexSoftware/mupdf/1.28.5/Makethird)
- MuPDF 1.28.5 source tarball, `https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz` (`thirdparty/README`, `resources/README`, `COPYING`)
- MuPDF, [License](https://mupdf.readthedocs.io/en/latest/license.html); [Artifex licensing](https://artifex.com/licensing)
- GNU, [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.txt)
- Adobe, [cmap-resources license](https://github.com/adobe-type-tools/cmap-resources/blob/master/LICENSE.md)
- GNU C Library, [Symbol Versioning](https://www.gnu.org/software/libc/manual/html_node/Versioning.html)
- Zotero, [`plugins.js`](https://github.com/zotero/zotero/blob/master/chrome/content/zotero/xpcom/plugins.js), [`file.js`](https://github.com/zotero/zotero/blob/master/chrome/content/zotero/xpcom/file.js), [`utilities_internal.js`](https://github.com/zotero/zotero/blob/master/chrome/content/zotero/xpcom/utilities_internal.js), [`dataDirectory.js`](https://github.com/zotero/zotero/blob/master/chrome/content/zotero/xpcom/dataDirectory.js), [`profile.js`](https://github.com/zotero/zotero/blob/master/chrome/content/zotero/xpcom/profile.js), [`http.js`](https://github.com/zotero/zotero/blob/master/chrome/content/zotero/xpcom/http.js); Zotero 7.0 branch equivalents
- LeeWin0531, [zotero-pdf-compress](https://github.com/LeeWin0531/zotero-pdf-compress) — third-party precedent for jar-based binary extraction
