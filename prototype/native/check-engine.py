#!/usr/bin/env python3
"""Run pinned preset and all-page native rendering on disposable fixture copies."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

REPO = Path(__file__).resolve().parents[2]
ENGINE = REPO / ".local-test/prototype/native/mutool"
FIXTURES = REPO / ".local-test/fixtures"
WORK = REPO / ".local-test/prototype/engine-check"
WORK.mkdir(parents=True, exist_ok=True)
PRESET = ["clean", "-ggg", "-z", "-Z", "-f", "-i", "-m", "--structure=keep",
          "--color-image-subsample-dpi=150", "--color-image-recompress-method=jpeg:85",
          "--gray-image-subsample-dpi=150", "--gray-image-recompress-method=jpeg:85",
          "--recompress-images-when=smaller"]

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(args):
    p = subprocess.run([str(ENGINE), *map(str, args)], capture_output=True, timeout=120)
    return {"exit": p.returncode, "stdout": p.stdout.decode(errors="replace"),
            "stderr": p.stderr.decode(errors="replace")}

def pages(info):
    found = re.search(r"^Pages:\s*(\d+)", info["stdout"], re.M)
    return int(found.group(1)) if found else None

def raster_metrics(before, after):
    first = before.read_bytes()
    second = after.read_bytes()
    header = re.compile(rb"P5\s+(\d+)\s+(\d+)\s+255\s")
    a, b = header.match(first), header.match(second)
    assert a and b and a.groups() == b.groups(), (before, after)
    p, q = first[a.end():], second[b.end():]
    assert len(p) == len(q) == int(a.group(1)) * int(a.group(2))
    return {"width": int(a.group(1)), "height": int(a.group(2)),
            "original_nonwhite_pixels": sum(x < 245 for x in p),
            "output_nonwhite_pixels": sum(x < 245 for x in q),
            "original_mean_ink": sum(255-x for x in p) / len(p),
            "output_mean_ink": sum(255-x for x in q) / len(q),
            "mean_absolute_pixel_difference": sum(abs(x-y) for x, y in zip(p, q)) / len(p)}

manifest = json.loads((FIXTURES / "manifest.json").read_text())
results = []
for fixture in manifest["fixtures"]:
    original = FIXTURES / fixture["file"]
    assert sha(original) == fixture["sha256"], f"Fixture changed before check: {original}"
    folder = WORK / original.stem
    folder.mkdir(exist_ok=True)
    source = folder / "original.pdf"
    output = folder / "compressed.pdf"
    shutil.copyfile(original, source)
    item = {"fixture": original.name, "original_bytes": source.stat().st_size,
            "original_sha256": sha(source), "input_info": run(["info", source])}
    if fixture["requires_password"]:
        item["outcome"] = "rejected: password-protected input"
        assert item["input_info"]["exit"] != 0
    elif fixture.get("pages") is None:
        item["outcome"] = "rejected: unreadable input"
        assert item["input_info"]["exit"] != 0
    else:
        assert item["input_info"]["exit"] == 0
        assert pages(item["input_info"]) == fixture["pages"]
        item["compression"] = run([*PRESET, source, output])
        assert item["compression"]["exit"] == 0, item["compression"]
        item["output_info"] = run(["info", output])
        assert item["output_info"]["exit"] == 0
        assert pages(item["output_info"]) == fixture["pages"]
        # 72 DPI render of every page, not a first-page probe.
        item["full_render_original"] = run(["draw", "-q", "-r", "72", "-F", "pgm", "-o", "/dev/null", source])
        item["full_render_output"] = run(["draw", "-q", "-r", "72", "-F", "pgm", "-o", "/dev/null", output])
        assert item["full_render_original"]["exit"] == item["full_render_output"]["exit"] == 0
        item["metrics_render_original"] = run(["draw", "-q", "-r", "36", "-o", folder / "before-%d.pgm", source])
        item["metrics_render_output"] = run(["draw", "-q", "-r", "36", "-o", folder / "after-%d.pgm", output])
        assert item["metrics_render_original"]["exit"] == item["metrics_render_output"]["exit"] == 0
        item["page_metrics"] = [raster_metrics(folder / f"before-{p}.pgm", folder / f"after-{p}.pgm")
                                for p in range(1, fixture["pages"] + 1)]
        item["output_bytes"] = output.stat().st_size
        item["output_sha256"] = sha(output)
        item["saved_bytes"] = item["original_bytes"] - item["output_bytes"]
        item["saved_percent"] = item["saved_bytes"] / item["original_bytes"] * 100
        item["outcome"] = "validated smaller output" if item["saved_bytes"] > 0 else "valid output without size benefit"
        if shutil.which("qpdf"):
            p = subprocess.run(["qpdf", "--check", str(output)], capture_output=True, timeout=30)
            item["qpdf_output_check"] = {"exit": p.returncode, "stdout": p.stdout.decode(), "stderr": p.stderr.decode()}
            assert p.returncode == 0
    assert sha(original) == fixture["sha256"], f"Fixture changed during check: {original}"
    results.append(item)
    print(f"{item['fixture']}: {item['outcome']}; {item.get('output_bytes', '—')} bytes")
report = {"engine_version": run(["-v"]), "preset": PRESET, "results": results,
          "limitations": "Synthetic fixtures only; pixel metrics are measurements, not a validated visual-quality or damage threshold."}
(WORK / "results.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"PASS: original fixture hashes unchanged; report {WORK / 'results.json'}")
