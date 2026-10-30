#!/usr/bin/env python3
"""Generate synthetic PDF inputs for ticket #8; keep originals outside Zotero."""

import hashlib
import json
from pathlib import Path
import random
import subprocess

import pymupdf as fitz

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".local-test" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)


def save(doc, name, **kwargs):
    doc.set_metadata({"title": name, "author": "Synthetic ticket #8 fixture",
                      "creationDate": "D:20261028000000Z"})
    doc.save(OUT / name, **kwargs)
    doc.close()


text = fitz.open()
for n in range(2):
    page = text.new_page()
    page.insert_text((50, 60), f"Text and vector fixture: page {n + 1}", fontsize=18)
    for row in range(24):
        page.insert_text((50, 100 + row * 18),
                         f"Line {row + 1}: searchable text; 0123456789; compression test.")
    page.draw_rect(fitz.Rect(50, 560, 250, 710), color=(0, 0, 1))
    page.draw_circle(fitz.Point(380, 630), 65, color=(1, 0, 0))
save(text, "text-vector.pdf")

images = fitz.open()
rng = random.Random(8)
width, height = 1200, 1600
for n in range(2):
    samples = bytearray(width * height * 3)
    for y in range(height):
        for x in range(width):
            i = (y * width + x) * 3
            noise = rng.randrange(32)
            samples[i:i + 3] = bytes(((x // 5 + noise) % 256,
                                      (y // 7 + noise) % 256,
                                      ((x + y) // 11 + noise) % 256))
    pixmap = fitz.Pixmap(fitz.csRGB, width, height, samples, False)
    page = images.new_page(width=288, height=384)
    page.insert_image(page.rect, pixmap=pixmap)
    page.insert_text((12, 24), f"Synthetic RGB image {n + 1}; 300 DPI", fontsize=10)
save(images, "image-heavy.pdf", deflate=False)

annotated = fitz.open(OUT / "text-vector.pdf")
page = annotated[0]
rect = page.search_for("searchable text")[0]
page.add_highlight_annot(rect).update()
note = page.add_text_annot((470, 80), "Keep this embedded PDF note after compression.")
note.update()
save(annotated, "annotated.pdf")

encrypted = fitz.open(OUT / "text-vector.pdf")
save(encrypted, "encrypted.pdf", encryption=fitz.PDF_ENCRYPT_AES_256,
     user_pw="fixture-user", owner_pw="fixture-owner", permissions=fitz.PDF_PERM_PRINT)  # betterleaks:allow synthetic fixture password for an encrypted test PDF, not an account credential (review 2027-04-28)

blank = fitz.open()
blank.new_page()
save(blank, "blank.pdf")

# Remove only the cross-reference table and trailer, leaving page objects intact.
original = (OUT / "text-vector.pdf").read_bytes()
xref = original.index(b"\nxref\n")
(OUT / "damaged-recoverable.pdf").write_bytes(original[:xref] + b"\n%%EOF\n")
# Retain a PDF header but no parseable document: this must never be accepted.
(OUT / "damaged-unreadable.pdf").write_bytes(b"%PDF-1.7\nTruncated before any objects.\n")

expected_pages = {"text-vector.pdf": 2, "image-heavy.pdf": 2, "annotated.pdf": 2,
                  "encrypted.pdf": 2, "blank.pdf": 1, "damaged-recoverable.pdf": 2,
                  "damaged-unreadable.pdf": None}
records = []
for name, count in expected_pages.items():
    path = OUT / name
    warnings = ""
    try:
        doc = fitz.open(path)
        needs_password = bool(doc.needs_pass)
        if name == "encrypted.pdf":
            assert needs_password and not doc.authenticate("wrong-password")
            assert doc.authenticate("fixture-user")
        else:
            assert not needs_password
        assert doc.page_count == count
        repaired = doc.is_repaired
        for page in doc:
            page.get_pixmap(matrix=fitz.Matrix(0.5, 0.5))
        if name == "annotated.pdf":
            assert len(list(doc[0].annots())) == 2
        if name == "text-vector.pdf":
            assert "searchable text" in doc[0].get_text()
        if name == "blank.pdf":
            assert set(doc[0].get_pixmap().samples) == {255}
        doc.close()
        render = "passed"
    except fitz.FileDataError:
        if count is not None:
            raise
        needs_password, repaired, render = False, False, "rejected as expected"
    warnings = fitz.TOOLS.mupdf_warnings()
    command = ["qpdf", "--check"]
    if name == "encrypted.pdf":
        command.append("--password=fixture-user")
    check = subprocess.run(command + [str(path)], capture_output=True, text=True)
    expected_exit = 2 if count is None else (3 if name == "damaged-recoverable.pdf" else 0)
    assert check.returncode == expected_exit, (name, check.stdout, check.stderr)
    records.append({"file": name, "bytes": path.stat().st_size,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "pages": count, "requires_password": needs_password,
                    "repaired_on_open": repaired, "render": render,
                    "mupdf_warnings": warnings, "qpdf_exit": check.returncode,
                    "qpdf_output": check.stdout + check.stderr})

manifest = {"provenance": "Generated entirely by prepare-fixtures.py; no external documents or personal data.",
            "pymupdf": fitz.VersionBind, "mupdf": fitz.VersionFitz,
            "qpdf": subprocess.check_output(["qpdf", "--version"], text=True).strip(),
            "fixtures": records}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest, indent=2))
