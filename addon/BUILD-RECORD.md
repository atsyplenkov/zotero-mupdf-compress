# Native build record

This record describes the Linux x86-64 programs in this XPI. The target is
glibc 2.35; the requirements below were measured with readelf on these files.
The final release must rebuild and retest the source agreed in issue #34.
MuPDF 1.28.5 was not patched for this development candidate.

- Source archive: `https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz`
- Source SHA-256: `98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934`
- Helper source SHA-256: `538fe7eac08a4cf9e8f29cdc9931286b6af36189ed68b7b14bd0012dd9b210cc`
- Source revision: `78f4f21dc134100fc54f3332827f2e6d4f575d09`
- Container base: `ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11`
- Built container image ID: `sha256:868b6b19c70ddce8812dcc8c0179124ec7454b54d2624512788cb8fa01cec3a0`
- Recorded at: 2026-11-08T11:12:26+00:00

## Toolchain

- cc: `cc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0`
- cxx: `c++ (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0`
- make: `GNU Make 4.3`
- binutils: `GNU readelf (GNU Binutils for Ubuntu) 2.38`

Installed package versions:

```
binutils=2.38-4ubuntu2.12
build-essential=12.9ubuntu3
ca-certificates=20260816ubuntu0.22.04.2
curl=7.81.0-1ubuntu1.30
g++=4:11.2.0-1ubuntu1
gcc=4:11.2.0-1ubuntu1
libc6=2.35-0ubuntu3.15
libc6-dev=2.35-0ubuntu3.15
make=4.3-4.1build1
python3=3.10.6-1~22.04.1
```

## Build commands

```sh
make -C /work/.scaffold/native-build/build/mupdf-1.28.5-source -j4 build=release tools HAVE_X11=no HAVE_GLUT=no HAVE_LIBCRYPTO=no HAVE_CURL=no
cc -std=c11 -O2 -Wall -Wextra -Werror /work/addon/native/session-lock.c -o /work/addon/native/linux-x86_64/session-lock
```

The full traced output is `native/linux-x86_64/build-trace.txt`.

## Measured runtime requirements

- `native/linux-x86_64/mutool` SHA-256: `e8e0427f8a5598f777697820fe69b5c52e040dcb0db8e9395bbec6d7b951735b`
  - Highest GLIBC version: `GLIBC_2.35`
  - GLIBC versions: GLIBC_2.2.5, GLIBC_2.3, GLIBC_2.3.2, GLIBC_2.3.4, GLIBC_2.4, GLIBC_2.7, GLIBC_2.11, GLIBC_2.14, GLIBC_2.25, GLIBC_2.27, GLIBC_2.29, GLIBC_2.33, GLIBC_2.34, GLIBC_2.35
  - Dynamic loader: `/lib64/ld-linux-x86-64.so.2`
  - Required libraries: libm.so.6, libc.so.6
- `native/linux-x86_64/session-lock` SHA-256: `8b47d059fb0f8202afa5ea20ca505ae7df6555272f9fb430d0f602b35ca5d944`
  - Highest GLIBC version: `GLIBC_2.34`
  - GLIBC versions: GLIBC_2.2.5, GLIBC_2.4, GLIBC_2.33, GLIBC_2.34
  - Dynamic loader: `/lib64/ld-linux-x86-64.so.2`
  - Required libraries: libc.so.6

## Limits

These measurements are not a claim of support for every Linux distribution,
non-glibc system, or a successful test inside Zotero. The Linux candidate CI
runs the packaged programs in Ubuntu 22.04 and 24.04; its run logs state
which candidate was tested. A noexec location or absent runtime library
prevents execution; there is no fallback engine.
