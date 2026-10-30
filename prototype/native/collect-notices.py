#!/usr/bin/env python3
"""Copy upstream notice files for the throwaway pinned MuPDF build."""
from pathlib import Path
import shutil

REPO = Path(__file__).resolve().parents[2]
SOURCE = REPO / ".local-test/prototype/build/mupdf-1.28.5-source"
DEST = REPO / "prototype/vendor"
DEST.mkdir(parents=True, exist_ok=True)
shutil.copyfile(SOURCE / "COPYING", DEST / "MuPDF-COPYING")
paths = [
    "thirdparty/README",
    "thirdparty/brotli/LICENSE",
    "thirdparty/cmark-gfm/COPYING",
    "thirdparty/extract/COPYING",
    "thirdparty/freetype/LICENSE.TXT",
    "thirdparty/freetype/docs/FTL.TXT",
    "thirdparty/freetype/docs/GPLv2.TXT",
    "thirdparty/freetype/src/bdf/README",
    "thirdparty/freetype/src/pcf/README",
    "thirdparty/gumbo-parser/COPYING",
    "thirdparty/harfbuzz/COPYING",
    "thirdparty/harfbuzz/src/ms-use/COPYING",
    "thirdparty/jbig2dec/COPYING",
    "thirdparty/jbig2dec/LICENSE",
    "thirdparty/lcms2/LICENSE",
    "thirdparty/libjpeg/README",
    "thirdparty/mujs/COPYING",
    "thirdparty/openjpeg/LICENSE",
    "thirdparty/zlib/LICENSE",
    "resources/README",
    "resources/fonts/droid/NOTICE",
    "resources/fonts/han/LICENSE.txt",
    "resources/fonts/han/README.txt",
    "resources/fonts/noto/COPYING",
    "resources/fonts/sil/OFL.txt",
    "resources/fonts/sil/README.txt",
    "resources/fonts/urw/OFL.txt",
    "resources/hyphen/README",
]
paths += [str(p.relative_to(SOURCE)) for p in sorted((SOURCE / "resources/hyphen/license").glob("*")) if p.is_file()]
for name in paths:
    target = DEST / "notices" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE / name, target)

# Retain the complete copyright/license comment embedded in every Adobe CMap.
# Group identical notices, retaining the full list of files to which each applies.
groups = {}
for cmap in sorted((SOURCE / "resources/cmaps").iterdir()):
    if not cmap.is_file():
        continue
    lines = cmap.read_text().splitlines()
    notice = "\n".join(line for line in lines if line.startswith("%%Copyright:"))
    if notice:
        groups.setdefault(notice, []).append(cmap.name)
parts = ["# Adobe CMap notices\n",
         "Copied without edits from %%Copyright lines in the pinned MuPDF source.\n"]
for notice, names in groups.items():
    parts += ["\nFiles: " + ", ".join(names) + "\n", "\n```text\n" + notice + "\n```\n"]
(DEST / "Adobe-CMap-NOTICES.md").write_text("\n".join(parts))
header = """# MuPDF third-party and resource notices

This local throwaway prototype bundles unmodified MuPDF 1.28.5.
Complete upstream license/notice files are copied under `notices/`; paths
match the pinned source tarball. `Adobe-CMap-NOTICES.md` preserves the
copyright/license notices embedded in Adobe CMaps.

This software is based in part on the work of the FreeType Team.
This software is based in part on the work of the Independent JPEG Group.

Enabled bundled libraries: Brotli, cmark-gfm, extract, FreeType, Gumbo,
HarfBuzz, jbig2dec, Little CMS, Independent JPEG Group libjpeg, MuJS,
OpenJPEG, and zlib. Font and hyphenation notices are included too.
Disabled: curl, libcrypto, viewers, optional OCR/barcode/archive features.

Additional full license texts referenced by hyphenation notices are in
`license-texts/`, with retrieval URLs and hashes in `license-texts/SOURCES.md`.

The extension and its session-lock helper are AGPL-3.0-or-later.
Read `SOURCE.md` before distributing any XPI; this local build is not
a release and has not been assessed as a complete redistribution package.

## Included upstream files

"""
(DEST / "THIRD-PARTY.md").write_text(header + "".join("- `notices/" + p + "`\n" for p in paths))
print(f"Copied {len(paths)} upstream notice files; grouped {len(groups)} Adobe CMap notices")
