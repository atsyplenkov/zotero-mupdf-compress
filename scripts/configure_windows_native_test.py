# SPDX-License-Identifier: AGPL-3.0-or-later
"""Check the upstream Windows project configuration transformation."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CONFIGURE = Path(__file__).with_name("configure-windows-native.py")


class WindowsConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mupdf-windows-project-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def test_selects_static_crt_in_every_project_including_dependencies(self):
        project = (b'<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">'
                   b'<ItemDefinitionGroup Condition="\'$(Configuration)|$(Platform)\'==\'Release|x64\'">'
                   b'<ClCompile><RuntimeLibrary>MultiThreadedDLL</RuntimeLibrary></ClCompile>'
                   b'</ItemDefinitionGroup></Project>')
        for name in ("mutool.vcxproj", "dependency.vcxproj"):
            (self.directory / name).write_bytes(project)
        result = subprocess.run([sys.executable, str(CONFIGURE), str(self.directory)], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("mutool.vcxproj", "dependency.vcxproj"):
            updated = (self.directory / name).read_bytes()
            self.assertIn(b"<RuntimeLibrary>MultiThreaded</RuntimeLibrary>", updated)
            self.assertNotIn(b"MultiThreadedDLL", updated)

    def test_refuses_per_file_runtime_override(self):
        project = (b'<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">'
                   b'<ItemDefinitionGroup Condition="\'$(Configuration)|$(Platform)\'==\'Release|x64\'">'
                   b'<ClCompile><RuntimeLibrary>MultiThreadedDLL</RuntimeLibrary></ClCompile>'
                   b'</ItemDefinitionGroup><ItemGroup><ClCompile Include="foo.c">'
                   b'<RuntimeLibrary>MultiThreadedDebugDLL</RuntimeLibrary></ClCompile></ItemGroup></Project>')
        (self.directory / "mutool.vcxproj").write_bytes(project)
        result = subprocess.run([sys.executable, str(CONFIGURE), str(self.directory)], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("per-file runtime", result.stderr)


if __name__ == "__main__":
    unittest.main()
