# Balanced `mutool` compression and safe validation

Checked on 2026-10-28 against MuPDF 1.28.5 documentation and the [`1.28.5` source tag](https://github.com/ArtifexSoftware/mupdf/tree/1.28.5). MuPDF 1.28.5 was released 2026-09-25 ([release history](https://mupdf.com/releases/history)).

## Bottom line

One `mutool clean` invocation gives a balanced preset: repair and structure cleanup, deflate, object streams, and 150-DPI image downsampling with JPEG recompression. `--structure=keep` must be passed explicitly, because `mutool clean` drops the PDF structure tree by default.

Validation that is both documented and dependable is: exit status, output existence and size, page-count equality from `mutool info`, and a full-document render check with `mutool draw`, which exits non-zero when any page fails to render. Detecting blank or visually damaged output needs a pixel comparison against the original, which is a heuristic and must be tuned in the prototype.

Two MuPDF specifics shape the design:

- `--*-image-subsample-dpi` does nothing on its own; the resampling branch also requires a recompression method other than `never`.
- The `lossy`/`lossless`-prefixed recompression options assign the optional quality to the opposite image family in source, so the unprefixed forms are the safe surface.

## Proposed command

```sh
mutool clean \
  -ggg -z -Z -f -i -m --structure=keep \
  --color-image-subsample-dpi=150 --color-image-recompress-method=jpeg:85 \
  --gray-image-subsample-dpi=150  --gray-image-recompress-method=jpeg:85 \
  --recompress-images-when=smaller \
  ORIGINAL_PDF_PATH TEMP_PDF_PATH
```

`-ggg` collects garbage, compacts the cross-reference table, and merges duplicate objects. `-gggg` adds stream-duplicate checking at extra CPU cost; measure it before adopting. `-e` (compression effort) is omitted so MuPDF uses its default amount.

### Why each option

| Option | Effect | Source |
| --- | --- | --- |
| `-ggg` | Garbage collect, compact xref, merge duplicate objects | [mutool clean docs](https://mupdf.readthedocs.io/en/1.28.5/tools/mutool-clean.html) |
| `-z` | Deflate uncompressed streams | same |
| `-Z` | Object streams and cross-reference streams | same |
| `-f` | Compress font streams | same |
| `-i` | Compress image streams | same |
| `-m` | Preserve metadata | same |
| `--structure=keep` | Keep the tagged-PDF structure tree | same; default is drop (`include/mupdf/pdf/clean.h:56-60`) |
| `--color-image-subsample-dpi=150` | Subsample colour images whose effective resolution exceeds 150 DPI down to 150 DPI | [mutool clean docs](https://mupdf.readthedocs.io/en/1.28.5/tools/mutool-clean.html); threshold and target come from one value (`source/tools/pdfclean.c:190-195`) |
| `--color-image-recompress-method=jpeg:85` | Re-encode colour images as JPEG at quality 85 | docs; quality parsing at `source/tools/pdfclean.c:201-205` |
| `--gray-image-*` | The same for greyscale images | docs |
| `--recompress-images-when=smaller` | Keep the rewrite only when it is smaller (this is the default) | docs; enforcement at `source/pdf/pdf-image-rewriter.c:827` |

Effective resolution is computed from how large the image is drawn on the page, not from its pixel dimensions alone (`source/pdf/pdf-image-rewriter.c:53-64`). An image qualifies for subsampling when that value exceeds the threshold.

## Documented behaviour that constrains the preset

1. **A DPI threshold alone is inert.** Every resampling branch requires the corresponding recompression method to be something other than `never` (`source/pdf/pdf-image-rewriter.c:738-772`). Setting only `--color-image-subsample-dpi` produces no image work.

2. **Recompression covers every image of that type, not just downsampled ones.** When no resampling occurred, the rewriter still calls `recompress_image` (`source/pdf/pdf-image-rewriter.c:799-815`). The `smaller` guard then compares sizes only: a re-encode that is smaller is kept even when it costs quality. Expect already-optimised JPEGs to be recompressed at the target quality.

3. **JPEG quality defaults to 75** when no quality is supplied (`source/pdf/pdf-image-rewriter.c:417`). The preset passes 85 explicitly so the policy is visible and adjustable.

4. **Prefixed quality options are assigned to the wrong family.** `--color-lossy-image-recompress-method=jpeg:80` stores the quality in the *lossless* field, and the lossless variant stores it in the *lossy* field (`source/tools/pdfclean.c:195-200`). The unprefixed `--color-image-recompress-method` copies method and quality to both families correctly (`source/tools/pdfclean.c:201-205`). Use unprefixed forms, or verify any prefixed form experimentally.

5. **`jbig2` is listed but not implemented.** The CLI advertises `jbig2` (`source/tools/pdfclean.c:111-113` and the docs), but `fz_recompress_method` has no JBIG2 member (`include/mupdf/pdf/image-rewriter.h:34-42`). A `jbig2` request matches no encoder and falls through to Flate (`source/pdf/pdf-image-rewriter.c:651-668`). Do not rely on it for bi-level scans; leaving bitonal options unset keeps those images untouched.

6. **Object streams raise the PDF version.** With `-Z`, a document below version 1.5 is promoted to 1.5 (`source/pdf/pdf-write.c:2707-2716`). That is expected and harmless for Zotero, but it is a file change worth knowing about.

7. **Encryption is kept by default.** `PDF_ENCRYPT_KEEP` is the zero value of the enum (`include/mupdf/pdf/crypt.h:31`), and `mutool clean` only changes encryption when `-D` or `-E` is passed. The prototype's rule is to skip encrypted attachments instead.

8. **Rewriting invalidates digital signatures.** Any PDF rewrite changes the signed byte range. `mutool clean` does not advertise a signature-preserving mode.

9. **`-m` is the documented way to keep metadata.** The docs describe it as "Preserve metadata". Whether XMP metadata is dropped, rewritten, or merely re-encoded without `-m` is not stated in the docs or in the clean path, so keep `-m` for predictability and confirm the difference in the prototype.

## Encrypted and damaged input

**Encrypted.** `mutool clean` accepts `-p password`. If the document needs a password and the supplied one does not authenticate, it throws `cannot authenticate password: <file>` and exits non-zero (`source/pdf/pdf-clean-file.c:559`, `source/tools/pdfclean.c:299`). `mutool info` prints an `Encryption object (N 0 R):` block only when the trailer has an `/Encrypt` dictionary (`source/tools/pdfinfo.c:217-222`), which makes encryption detectable before any write.

**Damaged.** `pdf_clean_file` performs a prepass that forces repairs before edits are applied, so repairs cannot silently discard the rewrite (`source/pdf/pdf-clean-file.c:561-564`). A file that cannot be opened, or that requires a password, fails with a non-zero exit status. A file that is merely malformed may still be repaired and rewritten successfully; in that case the reliable signals are exit status and the page count of the repaired input, not stderr text.

## Validation procedure

### Stage 1 — document-level checks (documented)

1. Run `mutool info ORIGINAL_PDF_PATH`. Exit non-zero (`source/tools/pdfinfo.c:1091`) means unreadable input: stop.
2. Parse `Pages: N` from the same output (`source/tools/pdfinfo.c:226`). A preceding `Encryption object` block means encrypted input: skip.
3. Run the compression command, capturing exit status and stderr.
4. Require exit status 0 (`source/tools/pdfclean.c:299`), an output file that exists, and an output size smaller than the original.
5. Run `mutool info TEMP_PDF_PATH` and require the same `Pages: N` value.

### Stage 2 — render check (documented)

Render every page at low resolution:

```sh
mutool draw -r 18 -o CHECK_PAGE_%d.pgm TEMP_PDF_PATH
```

`mutool draw` counts page-content errors and returns non-zero when any page failed to render (`source/tools/mudraw.c:1403`, `:2916`). The `%d` placeholder is required for per-page files; without it MuPDF writes the pages through one shared output (`source/tools/mudraw.c:2592-2594`). A non-zero exit here rejects the output.

Repeat the same command against the original when the pixel comparison below is enabled.

### Stage 3 — blank or damaged page heuristic (needs experiments)

Render both documents as above, then compare each page's ink coverage:

- Parse the PGM (P5) header and count pixels below a near-white threshold.
- Reject when a page that had ink in the original becomes effectively blank.
- Reject when a page's ink coverage collapses by a large factor.

Starting thresholds to calibrate: reject if the original page has at least 0.5% ink and the compressed page has less than 25% of that ink, or less than 0.05% absolute. Rendering at 18 DPI keeps this cheap even for long documents, and the same pass supplies the render check.

`mutool draw -s 5` prints per-page MD5 checksums, documented as usable "to check if rendering has changed" ([mutool draw docs](https://mupdf.readthedocs.io/en/1.28.5/tools/mutool-draw.html)). Lossy compression always changes the checksum, so it cannot serve as an equality test; it is only useful for detecting byte-identical renders.

## Experiments the prototype must run

- Confirm that the command above parses and runs on 1.28.5, and capture the exact stderr text for encrypted, repaired, and non-PDF inputs.
- Measure size reduction and visual quality on the corpus, and decide whether quality 85, 150 DPI, or `-gggg` should change.
- Verify whether metadata survives without `-m`, since the docs do not say.
- Calibrate the ink-coverage thresholds and confirm that the render check catches deliberately blanked output.
- Confirm that `mutool clean` returns non-zero, or at least leaves no usable output, for a truncated PDF.

## Sources

- [mutool clean, MuPDF 1.28.5](https://mupdf.readthedocs.io/en/1.28.5/tools/mutool-clean.html)
- [mutool info, MuPDF 1.28.5](https://mupdf.readthedocs.io/en/1.28.5/tools/mutool-info.html)
- [mutool draw, MuPDF 1.28.5](https://mupdf.readthedocs.io/en/1.28.5/tools/mutool-draw.html)
- [PDF write options, MuPDF 1.28.5](https://mupdf.readthedocs.io/en/1.28.5/reference/common/pdf-write-options.html)
- MuPDF source at tag `1.28.5`: [`source/tools/pdfclean.c`](https://github.com/ArtifexSoftware/mupdf/blob/1.28.5/source/tools/pdfclean.c), [`source/pdf/pdf-clean-file.c`](https://github.com/ArtifexSoftware/mupdf/blob/1.28.5/source/pdf/pdf-clean-file.c), [`source/pdf/pdf-image-rewriter.c`](https://github.com/ArtifexSoftware/mupdf/blob/1.28.5/source/pdf/pdf-image-rewriter.c), [`source/pdf/pdf-write.c`](https://github.com/ArtifexSoftware/mupdf/blob/1.28.5/source/pdf/pdf-write.c), [`source/tools/pdfinfo.c`](https://github.com/ArtifexSoftware/mupdf/blob/1.28.5/source/tools/pdfinfo.c), [`source/tools/mudraw.c`](https://github.com/ArtifexSoftware/mupdf/blob/1.28.5/source/tools/mudraw.c), [`include/mupdf/pdf/image-rewriter.h`](https://github.com/ArtifexSoftware/mupdf/blob/1.28.5/include/mupdf/pdf/image-rewriter.h), [`include/mupdf/pdf/clean.h`](https://github.com/ArtifexSoftware/mupdf/blob/1.28.5/include/mupdf/pdf/clean.h), [`include/mupdf/pdf/crypt.h`](https://github.com/ArtifexSoftware/mupdf/blob/1.28.5/include/mupdf/pdf/crypt.h)
- [MuPDF release history](https://mupdf.com/releases/history)
