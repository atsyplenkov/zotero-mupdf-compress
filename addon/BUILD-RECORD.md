# Native build record

This record describes the Linux x86_64 binaries currently bundled under
`native/` in this XPI. It states what was measured on the build host. It does
not characterize those binaries as portable release binaries and makes no
distribution or GLIBC baseline claim.

MuPDF source was not patched. The session-lock helper is compiled from
`native/session-lock.c` in this XPI.

## Toolchain and build

- MuPDF 1.28.5 source archive: `https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz`
- Source archive SHA-256: `98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934`
- GCC and G++ 16.2.1 20260810, GNU make, binutils, coreutils, curl, tar.
- Build host kernel: Linux 7.2.8-9-omarchy x86_64. No container or chroot.
- Recorded build time: 2026-10-28T09:44:51Z.
- Recipe: `native/build-engine.sh`. It verifies the source checksum and runs:

```sh
make -j4 build=release tools \
  HAVE_X11=no HAVE_GLUT=no HAVE_LIBCRYPTO=no HAVE_CURL=no
cc -std=c11 -O2 -Wall -Wextra -Werror native/session-lock.c -o session-lock
```

## Executable digests

| File | Bytes | Mode | SHA-256 |
| --- | ---: | --- | --- |
| `native/mutool` | 43,964,072 | 0755 | `036fc2602cfdccad54bac496a70c4385d07dc93736633d9ab6a4c308a8f532cf` |
| `native/session-lock` | 16,920 | 0755 | `94c573b4717829fad9f2597d350dd891616f10ed4e255d5a75b0b54d1684dcef` |

`native/digests.json` holds the same digests. The extension verifies an
extracted executable against that record before it runs it.

## Runtime linkage

Measured with `readelf -d` and `ldd` on the build host:

- `mutool`: `libm.so.6`, `libc.so.6`, and `/lib64/ld-linux-x86-64.so.2`.
  No X11, GL, curl, or libcrypto library is linked.
- `session-lock`: `libc.so.6` and `/lib64/ld-linux-x86-64.so.2`.

Both files are dynamically linked PIE executables.

## Symbol requirements

Measured with `readelf --version-info`:

- `mutool` uses GLIBC symbol versions up to `GLIBC_2.43`. The highest come
  from `libm` functions: `acosf`, `atan2f`, `log10f`, and `sqrtf` require
  `GLIBC_2.43`; `hypotf` requires `GLIBC_2.35`; `fmod`, `fmodf`, and the
  `__isoc23_*` conversions require `GLIBC_2.38`.
- `session-lock` uses GLIBC symbol versions up to `GLIBC_2.34`
  (`__libc_start_main`).

## Status and limits

- The `GLIBC_2.43` requirement measured above is a host-build limitation, not
  an approved distribution baseline or a promised minimum for other systems.
  It must not be quoted as a support floor.
- This record does not label the bundled binaries portable and does not claim
  any Linux distribution or ABI support. A release that claims wider
  compatibility needs its own controlled build and runtime evidence.
- Static linking is not used. A `noexec` location or a missing runtime library
  makes execution fail; there is no fallback engine or second executable
  location.
- Bytes and linkage are recorded for the exact files listed above. Rebuilding
  changes them and requires a new record.
