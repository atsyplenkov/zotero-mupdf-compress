# SPDX-License-Identifier: AGPL-3.0-or-later
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
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

    def test_windows_checkout_preserves_recorded_native_build_inputs(self):
        record = json.loads(self.files["native/linux-x86_64/build-record.json"])
        paths = ["addon/native/session-lock.c", *record["buildInputs"]]
        checkout = Path(self.temporary.name) / "checkout"
        subprocess.run([
            "git", "-c", "core.autocrlf=true", "-c", "core.eol=crlf",
            "checkout-index", f"--prefix={checkout.as_posix()}/", "--", *paths,
        ], cwd=distribution.REPO, check=True, capture_output=True)
        for path in paths:
            entry = path.removeprefix("addon/") if path.startswith("addon/") else f"source/{path}"
            self.files[entry] = (checkout / path).read_bytes()
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

    def test_rejects_component_names_not_accepted_by_runtime(self):
        components = json.loads(self.files["native/components.json"])
        platform = components["platforms"]["linux-x86_64"]
        name = "_support.so"
        content = b"required runtime file"
        platform["files"].append({
            "name": name, "path": f"linux-x86_64/{name}",
            "sha256": hashlib.sha256(content).hexdigest(), "executable": False,
        })
        platform["artifact"] = hashlib.sha256(json.dumps(platform["files"], separators=(",", ":")).encode()).hexdigest()
        self.files["native/components.json"] = json.dumps(components).encode()
        self.files[f"native/linux-x86_64/{name}"] = content
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("unsafe or duplicate component name", output)

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

    def add_windows_candidate(self):
        components = json.loads(self.files["native/components.json"])
        names = ("mutool.exe", "session-lock.exe")
        files = []
        measured = []
        for name in names:
            data = f"Windows fixture {name}".encode()
            checksum = hashlib.sha256(data).hexdigest()
            files.append({"name": name, "path": f"windows-x86_64/{name}", "sha256": checksum, "executable": True})
            measured.append({"name": name, "sha256": checksum, "machine": "AMD64",
                             "osVersion": "6.0", "subsystemVersion": "6.0", "needed": ["kernel32.dll"], "delayImports": []})
            self.files[f"native/windows-x86_64/{name}"] = data
            self.files["BUILD-RECORD.md"] += ("\n" + checksum).encode()
        identity = hashlib.sha256(json.dumps(files, separators=(",", ":")).encode()).hexdigest()
        components["platforms"]["windows-x86_64"] = {
            "os": "WINNT", "abi": "x86_64-msvc", "artifact": identity, "files": files,
        }
        self.files["native/components.json"] = json.dumps(components).encode()
        inputs = {
            "addon/native/build-windows.ps1": "native/build-windows.ps1",
            "scripts/configure-windows-native.py": "source/scripts/configure-windows-native.py",
            "scripts/inspect-windows-native.py": "source/scripts/inspect-windows-native.py",
            "scripts/record-windows-native.py": "source/scripts/record-windows-native.py",
        }
        build = {
            "schemaVersion": 1, "platform": "windows-x86_64", "sourceRevision": "a" * 40,
            "source": {"url": distribution.MUPDF_SOURCE, "sha256": distribution.MUPDF_SHA256},
            "helperSourceSha256": hashlib.sha256(self.files["native/session-lock-windows.c"]).hexdigest(),
            "buildInputs": {key: hashlib.sha256(self.files[value]).hexdigest() for key, value in inputs.items()},
            "toolchain": {key: "test" for key in ("runner", "runner_version", "os_version", "msbuild", "msvc", "sdk")},
            "target": "Windows 10 x64", "runtime": "MSVC static CRT (/MT)",
            "configuration": "test", "commands": ["test"], "files": measured,
        }
        self.files["native/windows-x86_64/build-record.json"] = json.dumps(build).encode()
        self.files["native/windows-x86_64/build-trace.txt"] = b"test trace"

    def test_accepts_windows_candidate_with_matching_records(self):
        self.add_windows_candidate()
        result, output = self.check()
        self.assertEqual(result, 0, output)

    def test_rejects_case_insensitive_windows_component_collisions(self):
        self.add_windows_candidate()
        components = json.loads(self.files["native/components.json"])
        platform = components["platforms"]["windows-x86_64"]
        extra = dict(platform["files"][0])
        extra["name"] = "MUTOOL.exe"
        extra["path"] = "windows-x86_64/MUTOOL.exe"
        platform["files"].append(extra)
        platform["artifact"] = hashlib.sha256(json.dumps(platform["files"], separators=(",", ":")).encode()).hexdigest()
        self.files["native/components.json"] = json.dumps(components).encode()
        self.files["native/windows-x86_64/MUTOOL.exe"] = self.files["native/windows-x86_64/mutool.exe"]
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("unsafe or duplicate component name", output)

    def test_rejects_windows_executable_with_mismatched_build_record(self):
        self.add_windows_candidate()
        build = json.loads(self.files["native/windows-x86_64/build-record.json"])
        build["files"][0]["sha256"] = "0" * 64
        self.files["native/windows-x86_64/build-record.json"] = json.dumps(build).encode()
        result, output = self.check()
        self.assertEqual(result, 1, output)
        self.assertIn("Windows build record digest mismatch", output)

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
