# SPDX-License-Identifier: AGPL-3.0-or-later
"""Exercise Windows candidate inspection with PE fixtures, without Windows."""

import hashlib
import json
from pathlib import Path
import struct
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

INSPECTOR = Path(__file__).with_name("inspect-windows-native.py")


def executable(dll="KERNEL32.dll", machine=0x8664):
    """A minimal x64 PE32+ image with one ordinary import descriptor."""
    image = bytearray(0x400)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 0x3c, 0x80)
    image[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", image, 0x84, machine, 1, 0, 0, 0, 240, 0x22)
    opt = 0x98
    struct.pack_into("<H", image, opt, 0x20b)
    struct.pack_into("<HH", image, opt + 40, 6, 0)
    struct.pack_into("<HH", image, opt + 48, 6, 0)
    struct.pack_into("<H", image, opt + 68, 3)
    struct.pack_into("<I", image, opt + 108, 16)
    struct.pack_into("<II", image, opt + 120, 0x1000, 40)
    section = opt + 240
    struct.pack_into("<8sIIII", image, section, b".rdata", 0x200, 0x1000, 0x200, 0x200)
    struct.pack_into("<IIIII", image, 0x200, 0, 0, 0, 0x1060, 0x1070)
    name = dll.encode("ascii") + b"\0"
    image[0x260:0x260 + len(name)] = name
    return bytes(image)


class WindowsInspectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mupdf-pe-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        for name in ("mutool.exe", "session-lock.exe"):
            (self.directory / name).write_bytes(executable())

    def inspect(self):
        return subprocess.run([sys.executable, str(INSPECTOR), str(self.directory)], text=True, capture_output=True)

    @unittest.skipUnless(shutil.which("clang-cl") and shutil.which("lld-link"), "Windows cross-compiler unavailable")
    def test_records_headers_from_a_real_linked_x64_pe(self):
        source = self.directory / "main.c"
        source.write_text("int main(void) { return 0; }\n")
        obj = self.directory / "main.obj"
        subprocess.run(["clang-cl", "/nologo", "/c", "/F" + f"o{obj}", str(source)], check=True, capture_output=True)
        binary = self.directory / "mutool.exe"
        subprocess.run(["lld-link", "/entry:main", "/subsystem:console,6.0", "/nodefaultlib", "/machine:x64",
                        f"/out:{binary}", str(obj)], check=True, capture_output=True)
        (self.directory / "session-lock.exe").write_bytes(binary.read_bytes())
        result = self.inspect()
        self.assertEqual(result.returncode, 0, result.stderr)
        for item in json.loads(result.stdout):
            self.assertEqual(item["machine"], "AMD64")
            self.assertEqual(item["osVersion"], "6.0")
            self.assertEqual(item["subsystemVersion"], "6.0")

    def test_records_executable_machine_and_os_imports(self):
        result = self.inspect()
        self.assertEqual(result.returncode, 0, result.stderr)
        files = json.loads(result.stdout)
        self.assertEqual([entry["name"] for entry in files], ["mutool.exe", "session-lock.exe"])
        for entry in files:
            self.assertEqual(entry["machine"], "AMD64")
            self.assertEqual(entry["needed"], ["kernel32.dll"])
            self.assertEqual(entry["subsystemVersion"], "6.0")

    def test_rejects_unbundled_visual_cpp_runtime(self):
        (self.directory / "mutool.exe").write_bytes(executable("VCRUNTIME140.dll"))
        result = self.inspect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("vcruntime140.dll", result.stderr.lower())

    def test_candidate_inspection_binds_measurements_to_packaged_record(self):
        candidate = self.directory / "candidate.xpi"
        measurement = {
            "name": "mutool.exe", "sha256": hashlib.sha256(executable()).hexdigest(), "machine": "AMD64",
            "osVersion": "6.0", "subsystemVersion": "6.0", "needed": ["kernel32.dll"], "delayImports": [],
        }
        helper = {**measurement, "name": "session-lock.exe"}
        with zipfile.ZipFile(candidate, "w") as archive:
            archive.writestr("native/windows-x86_64/build-record.json", json.dumps({
                "platform": "windows-x86_64", "sourceRevision": "a" * 40, "files": [measurement, helper],
            }))
        command = [sys.executable, str(INSPECTOR), str(self.directory), "--candidate", str(candidate),
                   "--source-revision", "a" * 40]
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = bytearray(executable())
        data[-1] = 1
        (self.directory / "mutool.exe").write_bytes(data)
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("measurements do not match", result.stderr)

    def test_rejects_candidate_record_from_a_different_revision(self):
        candidate = self.directory / "candidate.xpi"
        measurement = {
            "name": "mutool.exe", "sha256": hashlib.sha256(executable()).hexdigest(), "machine": "AMD64",
            "osVersion": "6.0", "subsystemVersion": "6.0", "needed": ["kernel32.dll"], "delayImports": [],
        }
        helper = {**measurement, "name": "session-lock.exe"}
        with zipfile.ZipFile(candidate, "w") as archive:
            archive.writestr("native/windows-x86_64/build-record.json", json.dumps({
                "platform": "windows-x86_64", "sourceRevision": "a" * 40, "files": [measurement, helper],
            }))
        result = subprocess.run([sys.executable, str(INSPECTOR), str(self.directory), "--candidate", str(candidate),
                                 "--source-revision", "b" * 40], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("source revision mismatch", result.stderr.lower())

    def test_rejects_wrong_architecture(self):
        (self.directory / "session-lock.exe").write_bytes(executable(machine=0x014c))
        result = self.inspect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("architecture", result.stderr.lower())


if __name__ == "__main__":
    unittest.main()
