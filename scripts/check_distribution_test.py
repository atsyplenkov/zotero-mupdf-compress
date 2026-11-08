# SPDX-License-Identifier: AGPL-3.0-or-later
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location(
    "distribution", Path(__file__).with_name("check-distribution.py")
)
distribution = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(distribution)


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mupdf-distribution-")
        self.addCleanup(self.temporary.cleanup)
        self.original_xpi = distribution.XPI
        self.original_update = distribution.UPDATE_JSON
        self.addCleanup(self.restore_paths)
        with zipfile.ZipFile(self.original_xpi) as archive:
            self.files = {name: archive.read(name) for name in archive.namelist()}
        self.update = json.loads(self.original_update.read_text())
        distribution.XPI = Path(self.temporary.name) / "candidate.xpi"
        distribution.UPDATE_JSON = Path(self.temporary.name) / "update.json"

    def restore_paths(self):
        distribution.XPI = self.original_xpi
        distribution.UPDATE_JSON = self.original_update

    def check(self):
        with zipfile.ZipFile(distribution.XPI, "w") as archive:
            for name, content in self.files.items():
                archive.writestr(name, content)
        entries = self.update["addons"]["mupdf-compress@atsyplenkov.github.io"]["updates"]
        entries[0]["update_hash"] = "sha512:" + hashlib.sha512(distribution.XPI.read_bytes()).hexdigest()
        distribution.UPDATE_JSON.write_text(json.dumps(self.update))
        output = io.StringIO()
        with contextlib.redirect_stderr(output), contextlib.redirect_stdout(output):
            result = distribution.main()
        return result, output.getvalue()

    def test_accepts_complete_candidate(self):
        result, output = self.check()
        self.assertEqual(result, 0, output)

    def test_rejects_altered_native_component(self):
        self.files["native/linux-x86_64/session-lock"] = b"altered helper"
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("component digest mismatch", output)

    def test_rejects_stale_artifact_identity(self):
        components = json.loads(self.files["native/components.json"])
        components["platforms"]["linux-x86_64"]["artifact"] = "0" * 64
        self.files["native/components.json"] = json.dumps(components).encode()
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("artifact identity", output)

    def test_rejects_absent_required_runtime_file(self):
        components = json.loads(self.files["native/components.json"])
        platform = components["platforms"]["linux-x86_64"]
        platform["files"].append({
            "name": "runtime.so", "path": "linux-x86_64/runtime.so",
            "sha256": "0" * 64, "executable": False,
        })
        platform["artifact"] = hashlib.sha256(json.dumps(platform["files"], separators=(",", ":")).encode()).hexdigest()
        self.files["native/components.json"] = json.dumps(components).encode()
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("missing component: native/linux-x86_64/runtime.so", output)

    def test_rejects_a_higher_glibc_requirement(self):
        record = json.loads(self.files["native/linux-x86_64/build-record.json"])
        record["files"][0]["glibcMax"] = "2.43"
        self.files["native/linux-x86_64/build-record.json"] = json.dumps(record).encode()
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("exceeds the glibc 2.35 target", output)

    def test_rejects_mismatched_helper_source(self):
        self.files["native/session-lock.c"] += b"\n/* changed source */\n"
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("helper source mismatch", output)

    def test_rejects_mismatched_build_recipe(self):
        self.files["native/build-engine.sh"] += b"\n# changed recipe\n"
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("build recipe mismatch", output)

    def test_rejects_compatibility_beyond_zotero_10(self):
        manifest = json.loads(self.files["manifest.json"])
        manifest["applications"]["zotero"]["strict_max_version"] = "11.*"
        self.files["manifest.json"] = json.dumps(manifest).encode()
        entries = self.update["addons"]["mupdf-compress@atsyplenkov.github.io"]["updates"]
        entries[0]["applications"]["zotero"]["strict_max_version"] = "11.*"
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("limited to Zotero 10", output)

    def test_rejects_pre_zotero_10_compatibility_even_when_feed_matches(self):
        manifest = json.loads(self.files["manifest.json"])
        manifest["applications"]["zotero"]["strict_min_version"] = "6.999"
        self.files["manifest.json"] = json.dumps(manifest).encode()
        entries = self.update["addons"]["mupdf-compress@atsyplenkov.github.io"]["updates"]
        entries[0]["applications"]["zotero"]["strict_min_version"] = "6.999"
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("Zotero 10", output)


if __name__ == "__main__":
    unittest.main()
