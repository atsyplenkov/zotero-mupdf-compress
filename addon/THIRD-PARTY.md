# Third-party notices

This XPI bundles unmodified MuPDF 1.28.5 and a small session-lock helper. The
extension and the helper are AGPL-3.0-or-later; the full license text is in
`LICENSE` at the root of this XPI.

- `notices/MuPDF-COPYING` is the MuPDF license from the pinned source archive.
- `notices/thirdparty/` holds the complete upstream license and notice files for
  the bundled libraries. Paths match the pinned source tarball.
- `notices/resources/` holds font and hyphenation notices for the resources
  MuPDF embeds.
- `notices/Adobe-CMap-NOTICES.md` preserves the copyright and license notices
  embedded in the Adobe CMap resources.
- `notices/license-texts/` holds additional full license texts referenced by
  the bundling notices, with retrieval URLs and hashes in
  `notices/license-texts/SOURCES.md`.

This software is based in part on the work of the FreeType Team.
This software is based in part on the work of the Independent JPEG Group.

Enabled bundled libraries: Brotli, cmark-gfm, extract, FreeType, Gumbo,
HarfBuzz, jbig2dec, Little CMS, Independent JPEG Group libjpeg, MuJS,
OpenJPEG, and zlib. Font, hyphenation, and CMap notices are included too.

Disabled: curl, libcrypto, X11/GL viewers, and the optional OCR, barcode, and
archive features.

The source pin, the native build recipe, and the corresponding extension source
location are in `SOURCE.md`. The measured native build details are in
`BUILD-RECORD.md`.
