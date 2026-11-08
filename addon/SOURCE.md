# Corresponding source

MuPDF Compress is licensed AGPL-3.0-or-later. This XPI carries the source and
build information needed to study and rebuild what it contains.

## Extension source

The runtime extension files are at the root of this XPI: `bootstrap.js`,
`prefs.js`, `manifest.json`, and `content/`. The TypeScript and build inputs
are under `source/`:

- `source/src/` is the TypeScript source compiled into `content/scripts/`.
- `source/typings/global.d.ts` declares the sandbox globals used by the source.
- `source/package.json` and `source/package-lock.json` pin the build tooling.
- `source/tsconfig.json` and `source/zotero-plugin.config.ts` are the build
  configuration. `source/Makefile`, `source/mise.toml`, and `source/mise.lock`
  record the project commands and tool pins.
- `source/LICENSE` is the project license text.

Recorded toolchain: Node 26.12.1, npm 11.20.0, TypeScript 5.9.3, and
`zotero-plugin-scaffold` 0.8.2. Rebuild from the repository tag matching the
manifest version:

```sh
npm ci
npm run build
```

The build combines the runtime files in `addon/` with the TypeScript in `src/`.
The `source/` tree in this XPI is the matching TypeScript and build input, not
a standalone build tree.

The project repository is
<https://github.com/atsyplenkov/zotero-mupdf-compress>. Development candidates
record their build revision in `native/linux-x86_64/build-record.json`; they
are not stable releases and need not have a version tag.

## MuPDF source

The bundled `native/linux-x86_64/mutool` is built from unmodified MuPDF 1.28.5:

- Archive: `https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz`
- SHA-256: `98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934`

A distributor of this XPI must make that verified archive available from the
same place as the XPI, for as long as the XPI is distributed. The candidate
Actions artifact includes that archive beside the XPI. For a GitHub release,
attach the archive to the release that carries the XPI. If an
equivalent mirror is used instead, its directions must stay next to the XPI and
the mirror must support equivalent copying.

The archive is the MuPDF Corresponding Source; no MuPDF files were patched.
`native/build-engine.sh` verifies the SHA-256 before extracting, applies the
flags recorded in `BUILD-RECORD.md`, and regenerates the Linux executables,
`native/components.json`, `native/digests.json`, and the build records inside
the controlled Ubuntu 22.04 build container. The packaged
`source/.github/workflows/linux-candidate.yml` shows the Docker build and run
commands; `native/linux.Dockerfile` defines the build environment.
`source/scripts/inspect-linux-native.py` checks measured ELF requirements.
The extraction and runtime test scripts are also under `source/scripts/`.

The compatibility target is glibc 2.35. Measured symbol and runtime-library
requirements are recorded separately for each executable. Native test logs
identify the environments used; they do not establish Zotero integration or
support for every Linux distribution.

The source patch requested by issue #34 is intentionally not included in this
development slice. Final release requires rebuilding and retesting the agreed
source and patches on all supported targets.

## Session-lock helper

`native/session-lock.c` in this XPI is the complete source of the
`native/linux-x86_64/session-lock` helper. It has no PDF functionality and is
licensed AGPL-3.0-or-later. The same build recipe compiles it.

## Licenses and notices

- `LICENSE`: project license text.
- `notices/MuPDF-COPYING`: MuPDF license.
- `THIRD-PARTY.md`: index of third-party, CMap, font, and hyphenation notices.
- `notices/`: the complete notice files.
