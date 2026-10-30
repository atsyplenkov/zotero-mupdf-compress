# Prototype PDF corpus

Prepared for [ticket #8](https://github.com/atsyplenkov/zotero-mupdf-compress/issues/8).
All seven fixtures were created successfully. They contain only synthetic data
from `scripts/test-environment/prepare-fixtures.py`, with no downloaded papers,
third-party document content, or personal library files.

## Local files and regeneration

Repository root on this machine:
`/home/ats/Development/zotero-mupdf-compress`.
Original fixtures: `.local-test/fixtures/` under that root.
SHA-256 hashes, sizes, engine versions, and complete check output are recorded in
`.local-test/fixtures/manifest.json`. Runtime files are ignored by Git.

From the repository root, with `uv` and `qpdf` installed:

```sh
uv venv .local-test/fixture-venv
uv pip install --python .local-test/fixture-venv/bin/python 'pymupdf==1.26.7'
.local-test/fixture-venv/bin/python scripts/test-environment/prepare-fixtures.py
```

The generator overwrites these fixture names. Do not regenerate during a test
session. Generated PDF identifiers and encryption salts can change hashes between
runs; the manifest records the bytes of the current run. Preserve originals and
use disposable copies for compression and linked attachments. Do not link the
originals directly into Zotero.

## Coverage and observed checks

Checked with PyMuPDF 1.26.7 / MuPDF 1.26.12 and qpdf 12.4.2.
Every readable page rendered at 36 DPI. qpdf independently checked the files.
These are corpus sanity checks, not validation of the pinned MuPDF 1.28.5 preset
or a visual-quality assessment.

| File | Pages | Bytes | Purpose and observed result |
| --- | ---: | ---: | --- |
| `text-vector.pdf` | 2 | 12,816 | Searchable text and vector shapes; text extraction and render pass; qpdf exit 0. |
| `image-heavy.pdf` | 2 | 11,524,690 | Uncompressed synthetic RGB images at 300 DPI; render passes; qpdf exit 0. |
| `annotated.pdf` | 2 | 13,988 | Text/vector input plus embedded highlight and note; two annotations found; render passes; qpdf exit 0. |
| `encrypted.pdf` | 2 | 15,178 | AES-256, user password `fixture-user`, owner password `fixture-owner`; rejects wrong password; renders after authentication; qpdf exit 0 with password. |
| `blank.pdf` | 1 | 597 | Intentionally blank valid page; all rendered pixels white; qpdf exit 0. Must not be mistaken for compression damage. |
| `damaged-recoverable.pdf` | 2 | 11,412 | Text/vector input with cross-reference table and trailer removed; MuPDF reports repair and renders both pages; qpdf exit 3 with warnings. |
| `damaged-unreadable.pdf` | — | 39 | Header without document objects; MuPDF rejects; qpdf exit 2. Must not reach replacement. |

## Handoff to ticket #9

Launch only the isolated environment described in `zotero-environment.md`.
Create a test collection and exercise both a stored attachment imported from a
fixture copy and a linked attachment pointing to a separate disposable copy
under `.local-test/linked-attachments/`. Keep the manifest and originals as the
comparison baseline. The prepared Zotero library is separate from this corpus;
attachment import and native Zotero annotation creation remain part of #9.

For the annotated case, preserve both embedded annotations. Also add a native
Zotero highlight and note in the isolated library: embedded PDF annotations do
not test Zotero database annotations. Verify attachment identity and annotation
positions after Compress and Revert.

Use `blank.pdf` as a legitimate blank baseline and compare nonblank pages before
and after compression. Use the two damaged files to distinguish repairable input
from unreadable input; a successful repair alone does not establish visual
correctness. Encrypted input should be skipped by the prototype unless its
settled design explicitly supports authentication.

No fixture category requested by #8 is missing. Limits: synthetic images do not
represent photographs, scanned small print, or real scientific figures; this
corpus cannot settle visual quality without additional user-supplied,
non-sensitive examples. Tagged PDF structure, forms, signatures, and native
Zotero annotations are not present in the generated files. No bundled `mutool`,
compression results, sync test, or plugin behavior is claimed by this setup.
