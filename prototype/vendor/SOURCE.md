# Source and build for the local #9 prototype

This is a disposable Linux x86_64 build, not a release. MuPDF source files
were not patched. The build generates files inside its disposable build tree.

## MuPDF 1.28.5

- Source: https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz
- SHA-256: `98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934`
- Source archive: `.local-test/prototype/downloads/mupdf-1.28.5-source.tar.gz`.
- Unpacked source: `.local-test/prototype/build/mupdf-1.28.5-source/`.
- License: `MuPDF-COPYING` (GNU Affero General Public License version 3);
  upstream licensing terms and exceptions remain in that source archive.

Run from this repository:

```sh
prototype/build-engine.sh
python prototype/native/collect-notices.py
python prototype/native/check-lock.py
```

The recipe verifies the archive hash before extracting and runs:

```sh
make -j4 build=release tools \
  HAVE_X11=no HAVE_GLUT=no HAVE_LIBCRYPTO=no HAVE_CURL=no
```

Build tools: GNU make, GCC C/C++ toolchain, binutils, curl, tar, coreutils.
Python 3 copies notices and runs focused native checks. The build uses the
bundled third-party sources; no PDF engine installation is needed at runtime.
`JOBS` can change parallelism; `CC` selects the session-lock C compiler.
No build container was used. The compiler, platform, exact output hashes,
sizes, dynamic linkage, and ELF symbol versions are recorded in
`.local-test/prototype/logs/native-build.txt`. That file describes only the
measured local binary; it is not a portable glibc support promise.

## Extension helper

`prototype/native/session-lock.c` is the complete source of the session-lock
helper, licensed AGPL-3.0-or-later. Its build recipe is in
`prototype/build-engine.sh`. It has no PDF functionality and performs no
recursive deletion. Source paths must be absolute without symlink components.
It prints `LOCKED\n` after taking a nonblocking exclusive Linux `flock` and
keeps the descriptor open until stdin reaches EOF or the process exits.

The lock protects cooperating processes that retain the same lock-file inode.
Do not unlink/recreate a live lock file or rename its parent while another
process may be holding it. The helper cannot protect against unrelated writers
or owners deliberately bypassing this procedure.

## Before distributing

No XPI or binary has been published by this task. A public distribution must
offer equivalent same-place access to this exact MuPDF source archive and the
complete extension/helper source and build instructions, at no charge, alongside
the XPI. Do not rely solely on an upstream source URL remaining available.
Include all license and resource notices in the XPI, and review any additional
conditions attached to the selected fonts/hyphenation patterns before release.

The local prototype is not a finished legal/compliance or portable-build review.
