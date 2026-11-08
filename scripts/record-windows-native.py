#!/usr/bin/env python3
"""Record the inspected Windows native build and add it to the component manifest."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
NATIVE = ROOT / "addon/native"
PLATFORM = "windows-x86_64"
URL = "https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz"
SHA256 = "98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934"
INPUTS = [
    "addon/native/build-windows.ps1",
    "scripts/configure-windows-native.py",
    "scripts/inspect-windows-native.py",
    "scripts/record-windows-native.py",
]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    revision = os.environ.get("NATIVE_SOURCE_REVISION", "")
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("NATIVE_SOURCE_REVISION must be a commit hash")
    toolchain = {key: os.environ.get("NATIVE_" + key.upper(), "") for key in
                 ("runner", "runner_version", "os_version", "msbuild", "msvc", "sdk")}
    if not all(toolchain.values()):
        raise ValueError("missing Windows runner or toolchain evidence")
    spec = importlib.util.spec_from_file_location("inspect_windows", ROOT / "scripts/inspect-windows-native.py")
    if spec is None or spec.loader is None:
        raise ValueError("missing PE inspector")
    inspector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inspector)
    files = [inspector.inspect(NATIVE / PLATFORM / name) for name in ("mutool.exe", "session-lock.exe")]
    components = json.loads((NATIVE / "components.json").read_text(encoding="utf-8"))
    if components.get("source") != URL or components.get("sourceSha256") != SHA256:
        raise ValueError("Linux and Windows source pins differ")
    entries = [{"name": file["name"], "path": f"{PLATFORM}/{file['name']}",
                "sha256": file["sha256"], "executable": True} for file in files]
    identity = hashlib.sha256(json.dumps(entries, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    components["platforms"][PLATFORM] = {
        "os": "WINNT", "abi": "x86_64-msvc", "artifact": identity, "files": entries,
    }
    record = {
        "schemaVersion": 1,
        "platform": PLATFORM,
        "sourceRevision": revision,
        "source": {"url": URL, "sha256": SHA256},
        "helperSourceSha256": digest(NATIVE / "session-lock-windows.c"),
        "buildInputs": {path: digest(ROOT / path) for path in INPUTS},
        "toolchain": toolchain,
        "target": "Windows 10 x64",
        "runtime": "MSVC static CRT (/MT)",
        "configuration": "Replace MultiThreadedDLL with MultiThreaded in all extracted upstream vcxproj files",
        "commands": [
            "python scripts/configure-windows-native.py <source>/platform/win32",
            "CL=/D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 /DNTDDI_VERSION=0x0A000000",
            "MSBuild mupdf.sln /m:4 /t:mutool /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=v143 "
            f"/p:VCToolsVersion={toolchain['msvc']} /p:WindowsTargetPlatformVersion={toolchain['sdk']}",
            "cl /MT /O2 /W4 /D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 /DNTDDI_VERSION=0x0A000000 "
            "session-lock-windows.c /link Advapi32.lib",
            "python scripts/inspect-windows-native.py addon/native/windows-x86_64",
        ],
        "files": files,
    }
    (NATIVE / PLATFORM / "build-record.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    (NATIVE / "components.json").write_text(json.dumps(components, indent=2) + "\n", encoding="utf-8")
    summary = [
        "", "## Windows x64 candidate", "",
        "The Windows programs target Windows 10 using the Visual Studio 2022",
        "x64 toolchain and static MSVC CRT. The measurements below describe",
        "direct PE imports, not proof of execution on Windows 10. Windows",
        "candidate adapter/native tests are not Zotero integration tests.", "",
        f"- Source revision: `{revision}`",
        f"- Helper source SHA-256: `{record['helperSourceSha256']}`",
        f"- Runner: `{toolchain['runner']}` image `{toolchain['runner_version']}`",
        f"- OS version: `{toolchain['os_version']}`",
        f"- MSBuild: `{toolchain['msbuild']}`; MSVC: `{toolchain['msvc']}`; SDK: `{toolchain['sdk']}`",
        "- MuPDF 1.28.5 source is unpatched; issue #34 is required before release.",
        "- Project compiler settings were transformed to `/MT` across all upstream projects.",
        "- Full build and inspection details: `native/windows-x86_64/build-record.json`.", "",
    ]
    for file in files:
        summary.append(f"- `{file['name']}` SHA-256: `{file['sha256']}`; "
                       f"PE {file['machine']}, OS {file['osVersion']}, subsystem {file['subsystemVersion']}; "
                       f"imports: {', '.join(file['needed']) or 'none'}")
    summary.append("")
    with (ROOT / "addon/BUILD-RECORD.md").open("a", encoding="utf-8", newline="\n") as output:
        output.write("\n".join(summary))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, KeyError, ValueError) as error:
        print(f"Cannot record Windows build: {error}", file=sys.stderr)
        sys.exit(1)
