# Distribution contents and source access (#18)

Checked on 2026-11-02. This ticket covers the artifact checks only; no Zotero
launch was made for it. Parent decisions are in #10, and the extraction
behavior recorded here refers to the earlier isolated-profile runs.

## Artifact

- Path: `.scaffold/build/mu-pdf-compress.xpi`
- Size: 31,551,797 bytes, 152 zip entries
- SHA-256: `551708dfa272adc5d0d1a709172892888599427a8d3e6cf83e8573083ac33b71`

A rebuild changes zip entry timestamps, so the hash identifies only the checked
bytes.

## Packaged material

| Path | Contents |
| --- | --- |
| `LICENSE` | Canonical AGPL-3.0 text fetched from gnu.org; the project is AGPL-3.0-or-later |
| `notices/MuPDF-COPYING` | License text from the pinned MuPDF source archive |
| `notices/thirdparty/` | Verbatim upstream license and notice files for the bundled libraries |
| `notices/resources/` | Verbatim font and hyphenation notices |
| `notices/Adobe-CMap-NOTICES.md` | CMap copyright/license notices grouped from the pinned source |
| `notices/license-texts/` | GPL-3.0, LGPL-2.1, LGPL-3.0, and LPPL-1.3c texts with retrieval URLs and hashes |
| `THIRD-PARTY.md` | Index of the notice trees and the FreeType/IJG attribution lines |
| `SOURCE.md` | Extension and MuPDF source locations, source pin, build instructions, release obligation |
| `BUILD-RECORD.md` | Measured toolchain, flags, digests, linkage, symbol requirements, and limits |
| `native/build-engine.sh`, `native/session-lock.c` | Native build recipe and complete helper source |
| `source/` | TypeScript, `typings/global.d.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `zotero-plugin.config.ts`, and `LICENSE` |

The notice tree is 83 files: 76 verbatim upstream files copied from the pinned
MuPDF archive through the prototype's collection, `MuPDF-COPYING`, the grouped
CMap notices, and five license texts. `diff -r` against the prototype's
`vendor/notices` showed only those additions.

The source entries are byte-identical to this checkout. `scripts/check-distribution.py`
compares every packaged source file with the repository file and fails on a
difference.

## Manifest

The packaged `manifest.json` declares:

```json
{
  "manifest_version": 2,
  "name": "MuPDF Compress",
  "version": "0.1.0",
  "applications": {
    "zotero": {
      "id": "mupdf-compress@atsyplenkov.github.io",
      "update_url": "https://example.invalid/mupdf-compress/updates.json",
      "strict_min_version": "6.999",
      "strict_max_version": "10.0.*"
    }
  }
}
```

The update URL is nonempty because Zotero 10 requires that field. Its `.invalid`
host cannot resolve, so it is not an update feed. The manifest is byte-identical
to the manifest in the XPI that the #14 run installed into Zotero 10.0.6, so that
installation accepted the same fields.

## Native digests and cache

The packaged `native/mutool` and `native/session-lock` match the digests in
`native/digests.json` and in `BUILD-RECORD.md`:

- `mutool`: `036fc2602cfdccad54bac496a70c4385d07dc93736633d9ab6a4c308a8f532cf`
- `session-lock`: `94c573b4717829fad9f2597d350dd891616f10ed4e255d5a75b0b54d1684dcef`

The earlier isolated run left the extracted copies in the disposable profile:

```text
.local-test/zotero/profile/mupdf-compress/036fc2602cfdccad/
  mutool         43,964,072 bytes, mode 0700, digest matches
  session-lock       16,920 bytes, mode 0700, digest matches
```

The same digests are in the XPI, so the extraction is a byte-for-byte copy of
the packaged files. `src/engine.ts` derives that cache from
`Zotero.getProfileDirectory()` and the first 16 hex characters of the packaged
`mutool` digest. It verifies the digests, sets mode 0700, and runs the binaries
by absolute path. The temporary-folder preference is read only by
`src/session.ts` for the session root; it cannot select the executable cache.
The disposable profile's custom temporary root
`.local-test/zotero/session-backups` contains no `mutool` or `session-lock`.

`src/files.ts` rejects paths that are not absolute, contain a `..` component, or
have a symlinked component. `src/engine.ts` applies that check to the cache
directory, each executable, and each parent before writing or hashing. A
digest mismatch fails startup with `native-digest-mismatch`; it never reaches
Compression.

This ticket did not re-run extraction or a symlink fault injection. The
observations above are from the #14 run and from the current profile state.

## Checks run

| Check | Result |
| --- | --- |
| `npm run build` produces the XPI | pass |
| `scripts/check-distribution.py` | pass |
| `mise run check` (lint, typecheck, versions, build, distribution) | pass |
| Packaged source equals the repository source | pass |
| Packaged native digests equal the files and the build record | pass |
| Manifest fields and reserved update URL | pass |
| `git status` shows no change under `prototype/` or `prototype-tests/` | pass |

`scripts/check-distribution.py` is now part of the `generated` step in `hk.pkl`,
so a missing license, notice, build record, recipe, source file, or digest
mismatch fails the project gate.

## Limits

- No Zotero install or launch was made for #18. The manifest and extraction
  evidence above come from the identical manifest installed in #14 and from the
  surviving profile state.
- The native build recipe was not re-run here. It is the executed prototype
  recipe with paths and digest-output changes only; running it downloads or
  reuses the pinned archive and replaces the committed binaries.
- No release exists yet. `SOURCE.md` requires the verified
  `mupdf-1.28.5-source.tar.gz` archive to be offered from the same place as the
  XPI, for as long as the XPI is distributed; that obligation is documented, not
  demonstrated by a published release.
- The GLIBC_2.43 requirement remains a host limitation. No distribution or
  GLIBC baseline is claimed.
- Zotero 7 remains untested.
