#!/usr/bin/env python3
"""Configure the pinned MuPDF MSBuild projects for a static release CRT.

This changes compiler settings in the extracted build tree only; it does not
patch MuPDF's C/C++ source. All project files are transformed so transitive
project references use the same runtime. Fail if Release|x64 settings differ
from those expected by this recipe.
"""

import argparse
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

NAMESPACE = "{http://schemas.microsoft.com/developer/msbuild/2003}"
DYNAMIC = b"<RuntimeLibrary>MultiThreadedDLL</RuntimeLibrary>"
STATIC = b"<RuntimeLibrary>MultiThreaded</RuntimeLibrary>"


def configure(directory: Path) -> None:
    projects = sorted(directory.glob("*.vcxproj"))
    if not projects or not (directory / "mutool.vcxproj").is_file():
        raise ValueError("MuPDF Windows projects not found")
    changes = 0
    for path in projects:
        original = path.read_bytes()
        updated = original.replace(DYNAMIC, STATIC)
        changes += original.count(DYNAMIC)
        root = ET.fromstring(updated)
        for group in root.findall(NAMESPACE + "ItemGroup"):
            for item in group.findall(NAMESPACE + "ClCompile"):
                if item.find(NAMESPACE + "RuntimeLibrary") is not None:
                    raise ValueError(f"{path.name}: per-file runtime override")
        for group in root.findall(NAMESPACE + "ItemDefinitionGroup"):
            condition = group.get("Condition", "").replace(" ", "")
            if condition == "'$(Configuration)|$(Platform)'=='Release|x64'":
                compile_settings = group.find(NAMESPACE + "ClCompile")
                if compile_settings is not None:
                    runtime = compile_settings.find(NAMESPACE + "RuntimeLibrary")
                    if runtime is None or runtime.text != "MultiThreaded":
                        raise ValueError(f"{path.name}: Release|x64 does not select static CRT")
        if DYNAMIC in updated:
            raise ValueError(f"{path.name}: unresolved dynamic release CRT")
        if updated != original:
            path.write_bytes(updated)
    if not changes:
        raise ValueError("no upstream CRT settings were changed")
    print(f"Configured {len(projects)} projects; changed {changes} release CRT settings")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        configure(args.directory)
    except (OSError, ValueError, ET.ParseError) as error:
        print(f"Windows project configuration failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
