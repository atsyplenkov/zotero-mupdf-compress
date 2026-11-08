#!/usr/bin/env python3
"""Extract and verify one platform's components from a candidate XPI for native tests."""

import argparse
import hashlib
import json
import pathlib
import re
import sys
import zipfile


PLATFORMS = {
    "linux-x86_64": ("Linux", "x86_64-gcc3", ("mutool", "session-lock")),
    "windows-x86_64": ("WINNT", "x86_64-msvc", ("mutool.exe", "session-lock.exe")),
}


def extract(
    xpi: pathlib.Path,
    destination: pathlib.Path,
    platform_id: str = "linux-x86_64",
    manifest_output: pathlib.Path | None = None,
) -> None:
    expected_os, expected_abi, required_files = PLATFORMS[platform_id]
    with zipfile.ZipFile(xpi) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("candidate contains duplicate archive entries")
        manifest_bytes = archive.read("native/components.json")
        manifest = json.loads(manifest_bytes)
        if manifest.get("schemaVersion") != 1:
            raise ValueError("unsupported component manifest version")
        platform = manifest["platforms"][platform_id]
        if platform.get("os") != expected_os or platform.get("abi") != expected_abi:
            raise ValueError("invalid platform declaration")
        if not re.fullmatch(r"[0-9a-f]{64}", platform.get("artifact", "")):
            raise ValueError("invalid artifact identity")
        files = platform["files"]
        if not isinstance(files, list):
            raise ValueError("invalid component list")
        identity = hashlib.sha256(json.dumps(files, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if identity != platform["artifact"]:
            raise ValueError("component artifact identity mismatch")
        verified: dict[str, tuple[bytes, bool]] = {}
        normalized_names: set[str] = set()
        for component in files:
            name = component["name"]
            if (not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", name) or
                    (platform_id == "windows-x86_64" and
                     (name.endswith(".") or re.match(r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", name, re.I)))):
                raise ValueError("invalid component name")
            normalized = name.lower() if platform_id == "windows-x86_64" else name
            if component["path"] != f"{platform_id}/{name}" or normalized in normalized_names:
                raise ValueError("invalid component path or duplicate name")
            normalized_names.add(normalized)
            digest = component["sha256"]
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("invalid component digest")
            executable = component["executable"]
            if not isinstance(executable, bool):
                raise ValueError("invalid component mode")
            contents = archive.read("native/" + component["path"])
            if hashlib.sha256(contents).hexdigest() != digest:
                raise ValueError(f"component digest mismatch: {name}")
            verified[name] = (contents, executable)
        for required in required_files:
            if required not in verified or not verified[required][1]:
                raise ValueError(f"missing executable: {required}")

    # Refuse reuse: a previous extraction must never supply an unchecked file.
    if manifest_output is not None and manifest_output.resolve().is_relative_to(destination.resolve()):
        raise ValueError("manifest output must be outside the component directory")
    destination.mkdir(mode=0o700)
    for name, (contents, executable) in verified.items():
        path = destination / name
        path.write_bytes(contents)
        path.chmod(0o700 if executable else 0o600)
    if manifest_output is not None:
        with manifest_output.open("xb") as output:
            output.write(manifest_bytes)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=PLATFORMS, default="linux-x86_64")
    parser.add_argument("--manifest-output", type=pathlib.Path)
    parser.add_argument("xpi", type=pathlib.Path)
    parser.add_argument("destination", type=pathlib.Path)
    args = parser.parse_args()
    try:
        extract(args.xpi, args.destination, args.platform, args.manifest_output)
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"Cannot extract candidate: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
