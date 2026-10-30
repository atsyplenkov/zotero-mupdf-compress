# Measured local native build

Ticket #9, 2026-10-28. This is a local throwaway build, not a release.

- MuPDF 1.28.5, source SHA-256 verified against the pin in `SOURCE.md`.
- GCC 16.2.1 20260810; no build container.
- `mutool`: 43,964,072 bytes, mode 0755, SHA-256
  `036fc2602cfdccad54bac496a70c4385d07dc93736633d9ab6a4c308a8f532cf`.
- `session-lock`: 16,920 bytes, mode 0755, SHA-256
  `94c573b4717829fad9f2597d350dd891616f10ed4e255d5a75b0b54d1684dcef`.
- `mutool` ELF dependencies: libc, libm, GNU dynamic loader. Highest required
  symbol version: **GLIBC_2.43** (libm); libc requirements reach GLIBC_2.38.
- Helper ELF dependencies: libc and GNU dynamic loader; highest symbol
  requirement GLIBC_2.34.
- These are local-host artifacts. Broad Linux portability is untested and
  this glibc baseline is too recent for a broad-distribution release.

Detailed compiler, linkage and ELF output:
`.local-test/prototype/logs/native-build.txt`.

## Native fixture results

The settled preset from #5 was applied to disposable copies. For all five
readable, unencrypted fixtures: page counts matched, every input/output page
rendered at 72 DPI, and qpdf accepted the output. Password-protected input and
unreadable damage were rejected. All seven original hashes stayed unchanged.

| Fixture | Input bytes | Output bytes | Saved |
| --- | ---: | ---: | ---: |
| Text/vector | 12,816 | 1,658 | 87.06% |
| Image-heavy | 11,524,690 | 1,273,065 | 88.95% |
| Embedded annotations | 13,988 | 2,453 | 82.46% |
| Valid blank | 597 | 736 | None; output must not replace input |
| Repairable damage | 11,412 | 1,458 | 87.22% |

At 36 DPI, grayscale before/after pixels were identical for text/vector,
annotated, blank, and repairable-damage fixtures. Image-heavy mean absolute
pixel differences were 0.557 and 0.561 on a 0–255 scale; nonwhite-pixel counts
were unchanged. These measurements do not establish a damage threshold.
The legitimate blank remained entirely white. Two embedded annotations kept
their type, page, rectangle, info and vertices in an independent PyMuPDF check.
Native Zotero annotations and Compress/Revert must be checked in Zotero.

Raster images for the user's quality review are under
`.local-test/prototype/engine-check/image-heavy/{before,after}-1.png` and
`{before,after}-2.png` at 100 DPI. Agent inspection found the synthetic
gradient/noise page and text present in both first-page images; this does not
represent scanned small print or real scientific figures. User review remains
necessary. The machine-readable native report is `engine-check/results.json`.

## Lock checks

`python prototype/native/check-lock.py` passed: concurrent acquisition is
blocked; stdin EOF and SIGKILL release ownership; final and ancestor symlinks,
hardlinks, FIFO, directory, unsafe mode, relative path, and parent traversal
are rejected. Owner checking exists in C but alternate-owner rejection was not
exercised. No cleanup logic is implemented in this helper.
