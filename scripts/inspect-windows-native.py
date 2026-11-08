#!/usr/bin/env python3
"""Inspect x64 PE candidates and reject non-Windows runtime dependencies.

The Windows candidate uses the static MSVC CRT. Only direct Windows system DLL
imports listed below are accepted; delay imports are refused. This inspection
measures the files, but cannot prove execution on every Windows 10 build.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import sys
import zipfile

# Windows 10 inbox libraries used by console programs and the session helper.
# A new import must be reviewed, not silently assumed to be part of Windows.
SYSTEM_DLLS = frozenset({
    "advapi32.dll", "bcrypt.dll", "comctl32.dll", "comdlg32.dll", "crypt32.dll",
    "gdi32.dll", "imm32.dll", "kernel32.dll", "normaliz.dll", "odbc32.dll", "odbccp32.dll",
    "ole32.dll", "oleaut32.dll", "psapi.dll", "rpcrt4.dll", "se" + "cur32.dll",
    "shell32.dll", "shlwapi.dll", "user32.dll", "version.dll", "winmm.dll", "winspool.drv", "ws2_32.dll",
})


def inspect(path: Path) -> dict:
    data = path.read_bytes()

    def span(offset: int, size: int) -> bytes:
        if offset < 0 or size < 0 or offset + size > len(data):
            raise ValueError(f"{path.name}: truncated PE structure")
        return data[offset:offset + size]

    def word(offset: int) -> int:
        return struct.unpack("<H", span(offset, 2))[0]

    def dword(offset: int) -> int:
        return struct.unpack("<I", span(offset, 4))[0]

    if span(0, 2) != b"MZ":
        raise ValueError(f"{path.name}: missing DOS header")
    pe = dword(0x3c)
    if span(pe, 4) != b"PE\0\0":
        raise ValueError(f"{path.name}: missing PE signature")
    coff = pe + 4
    if word(coff) != 0x8664:
        raise ValueError(f"{path.name}: unexpected PE architecture")
    count = word(coff + 2)
    if not 1 <= count <= 96:
        raise ValueError(f"{path.name}: invalid PE section count")
    size = word(coff + 16)
    if size < 112 or word(coff + 18) & 0x2000:
        raise ValueError(f"{path.name}: not an executable PE32+ image")
    opt = coff + 20
    span(opt, size)
    if word(opt) != 0x20b or word(opt + 68) != 3:
        raise ValueError(f"{path.name}: expected PE32+ console executable")
    os_version = (word(opt + 40), word(opt + 42))
    subsystem_version = (word(opt + 48), word(opt + 50))
    if os_version > (10, 0) or subsystem_version > (10, 0):
        raise ValueError(f"{path.name}: PE version exceeds Windows 10 target")
    directories = dword(opt + 108)
    if directories < 2 or size < 112 + 8 * min(directories, 16):
        raise ValueError(f"{path.name}: invalid data directory")
    if directories > 13 and (dword(opt + 112 + 13 * 8) or dword(opt + 116 + 13 * 8)):
        raise ValueError(f"{path.name}: delay imports are not supported")

    sections = []
    for index in range(count):
        section = opt + size + index * 40
        span(section, 40)
        virtual_size = dword(section + 8)
        virtual_address = dword(section + 12)
        raw_size = dword(section + 16)
        raw_offset = dword(section + 20)
        span(raw_offset, raw_size)
        sections.append((virtual_address, min(virtual_size, raw_size), raw_offset))

    def file_offset(rva: int, length: int) -> int:
        matches = [start + rva - address for address, size, start in sections
                   if address <= rva and rva + length <= address + size]
        if len(matches) != 1:
            raise ValueError(f"{path.name}: invalid PE virtual address")
        return matches[0]

    needed = []
    import_rva, import_size = dword(opt + 120), dword(opt + 124)
    if bool(import_rva) != bool(import_size):
        raise ValueError(f"{path.name}: invalid import directory")
    if import_rva:
        if import_size < 20 or import_size > 20 * 1024:
            raise ValueError(f"{path.name}: invalid import table length")
        offset = file_offset(import_rva, import_size)
        terminated = False
        for pos in range(offset, offset + import_size - 19, 20):
            descriptor = span(pos, 20)
            if descriptor == bytes(20):
                terminated = True
                break
            name_rva = dword(pos + 12)
            # The import name must be within one section, including its NUL.
            chars = bytearray()
            for index in range(256):
                char = span(file_offset(name_rva + index, 1), 1)[0]
                if not char:
                    break
                chars.append(char)
            else:
                raise ValueError(f"{path.name}: unterminated DLL name")
            try:
                name = chars.decode("ascii").lower()
            except UnicodeDecodeError as error:
                raise ValueError(f"{path.name}: invalid DLL name") from error
            if not re.fullmatch(r"[a-z0-9._-]+\.(?:dll|drv)", name) or name not in SYSTEM_DLLS:
                raise ValueError(f"{path.name}: unexpected runtime dependency {name}")
            needed.append(name)
        if not terminated:
            raise ValueError(f"{path.name}: unterminated import table")

    return {
        "name": path.name,
        "sha256": hashlib.sha256(data).hexdigest(),
        "machine": "AMD64",
        "osVersion": ".".join(map(str, os_version)),
        "subsystemVersion": ".".join(map(str, subsystem_version)),
        "needed": sorted(set(needed)),
        "delayImports": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--source-revision")
    args = parser.parse_args()
    try:
        if (args.candidate is None) != (args.source_revision is None):
            raise ValueError("candidate and source revision must be provided together")
        files = [inspect(args.directory / name) for name in ("mutool.exe", "session-lock.exe")]
        if args.candidate is not None:
            with zipfile.ZipFile(args.candidate) as candidate:
                record = json.loads(candidate.read("native/windows-x86_64/build-record.json"))
            if record.get("sourceRevision") != args.source_revision:
                raise ValueError("candidate source revision mismatch")
            if record.get("platform") != "windows-x86_64" or record.get("files") != files:
                raise ValueError("candidate PE measurements do not match its build record")
    except (OSError, ValueError, KeyError, struct.error, zipfile.BadZipFile) as error:
        print(f"Windows PE inspection failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(files, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
