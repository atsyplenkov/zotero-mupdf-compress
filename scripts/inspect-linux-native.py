#!/usr/bin/env python3
"""Inspect the Linux candidate's ABI without executing its programs."""

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

TARGET = (2, 35)
LOADER = "/lib64/ld-linux-x86-64.so.2"
ALLOWED_LIBRARIES = {"libc.so.6", "libm.so.6"}


def readelf(path: pathlib.Path, option: str) -> str:
    return subprocess.run(
        ["readelf", option, str(path)], check=True, text=True, capture_output=True,
        env={**os.environ, "LC_ALL": "C"},
    ).stdout


def inspect(path: pathlib.Path) -> dict:
    header = readelf(path, "-h")
    for pattern in (
        r"Class:\s+ELF64\b",
        r"Data:\s+2's complement, little endian",
        r"Machine:\s+Advanced Micro Devices X86-64\b",
        r"Type:\s+(?:DYN|EXEC)\b",
    ):
        if not re.search(pattern, header):
            raise ValueError(f"{path.name}: not a Linux x86-64 executable ({pattern})")
    program_headers = readelf(path, "-l")
    interpreters = re.findall(r"Requesting program interpreter: ([^\]]+)\]", program_headers)
    if interpreters != [LOADER]:
        raise ValueError(f"{path.name}: unexpected dynamic interpreter {interpreters}")
    dynamic = readelf(path, "-d")
    if re.search(r"\((?:RPATH|RUNPATH)\)", dynamic):
        raise ValueError(f"{path.name}: embedded library search path is not allowed")
    needed = re.findall(r"\(NEEDED\).*?\[([^\]]+)\]", dynamic)
    if "libc.so.6" not in needed or not set(needed) <= ALLOWED_LIBRARIES:
        raise ValueError(f"{path.name}: unexpected runtime dependencies {needed}")
    versions = re.findall(r"Name:\s+(\S+)", readelf(path, "--version-info"))
    if not versions or any(not re.fullmatch(r"GLIBC_\d+(?:\.\d+)+", version) for version in versions):
        raise ValueError(f"{path.name}: unsupported symbol requirements {versions}")
    versions = sorted(set(versions), key=lambda value: tuple(map(int, value.removeprefix("GLIBC_").split("."))))
    highest = versions[-1].removeprefix("GLIBC_")
    if tuple(map(int, highest.split("."))) > TARGET:
        raise ValueError(f"{path.name}: requires GLIBC_{highest}, exceeding GLIBC_2.35")
    return {
        "name": path.name,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "glibcMax": highest,
        "glibcVersions": versions,
        "needed": needed,
        "interpreter": interpreters[0],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    try:
        files = [inspect(args.directory / name) for name in ("mutool", "session-lock")]
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Linux ABI inspection failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(files, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
