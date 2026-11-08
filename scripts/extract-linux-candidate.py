#!/usr/bin/env python3
"""Extract and verify the Linux components from a candidate XPI for native tests."""

import argparse
import hashlib
import json
import pathlib
import re
import sys
import zipfile


def extract(xpi: pathlib.Path, destination: pathlib.Path) -> None:
    with zipfile.ZipFile(xpi) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("candidate contains duplicate archive entries")
        manifest = json.loads(archive.read("native/components.json"))
        if manifest.get("schemaVersion") != 1:
            raise ValueError("unsupported component manifest version")
        platform = manifest["platforms"]["linux-x86_64"]
        if platform.get("os") != "Linux" or platform.get("abi") != "x86_64-gcc3":
            raise ValueError("invalid Linux platform declaration")
        if not re.fullmatch(r"[0-9a-f]{64}", platform.get("artifact", "")):
            raise ValueError("invalid artifact identity")
        files = platform["files"]
        if not isinstance(files, list):
            raise ValueError("invalid component list")
        identity = hashlib.sha256(json.dumps(files, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if identity != platform["artifact"]:
            raise ValueError("component artifact identity mismatch")
        verified: dict[str, tuple[bytes, bool]] = {}
        for component in files:
            name = component["name"]
            if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", name):
                raise ValueError("invalid component name")
            if component["path"] != f"linux-x86_64/{name}" or name in verified:
                raise ValueError("invalid component path")
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
        for required in ("mutool", "session-lock"):
            if required not in verified or not verified[required][1]:
                raise ValueError(f"missing executable: {required}")

    # Refuse reuse: a previous extraction must never supply an unchecked file.
    destination.mkdir(mode=0o700)
    for name, (contents, executable) in verified.items():
        path = destination / name
        path.write_bytes(contents)
        path.chmod(0o700 if executable else 0o600)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xpi", type=pathlib.Path)
    parser.add_argument("destination", type=pathlib.Path)
    args = parser.parse_args()
    try:
        extract(args.xpi, args.destination)
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"Cannot extract candidate: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
