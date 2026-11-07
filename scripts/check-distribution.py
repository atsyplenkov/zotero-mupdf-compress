#!/usr/bin/env python3
import hashlib
import json
import pathlib
import re
import sys
import zipfile
from urllib.parse import urlsplit

REPO = pathlib.Path(__file__).resolve().parent.parent
XPI = REPO / ".scaffold/build/mu-pdf-compress.xpi"
MUPDF_SOURCE = "https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz"
MUPDF_SHA256 = "98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934"
UPDATE_JSON = REPO / ".scaffold/build/update.json"
UPDATE_URL = "https://github.com/atsyplenkov/zotero-mupdf-compress/releases/download/release/update.json"
SHA256 = re.compile(r"[a-f0-9]{64}")
REQUIRED = [
    "LICENSE",
    "SOURCE.md",
    "THIRD-PARTY.md",
    "BUILD-RECORD.md",
    "native/build-engine.sh",
    "native/session-lock.c",
    "native/digests.json",
    "native/mutool",
    "native/session-lock",
    "notices/MuPDF-COPYING",
    "notices/Adobe-CMap-NOTICES.md",
    "notices/thirdparty/README",
    "notices/thirdparty/freetype/LICENSE.TXT",
    "notices/thirdparty/libjpeg/README",
    "notices/resources/README",
    "notices/resources/fonts/droid/NOTICE",
    "notices/resources/fonts/han/LICENSE.txt",
    "notices/resources/fonts/noto/COPYING",
    "notices/resources/fonts/sil/OFL.txt",
    "notices/resources/fonts/urw/OFL.txt",
    "notices/resources/hyphen/README",
    "notices/resources/hyphen/license/hyph-en-us.info",
    "notices/license-texts/GPL-3.0.txt",
    "notices/license-texts/LGPL-2.1.txt",
    "notices/license-texts/LGPL-3.0.txt",
    "notices/license-texts/LPPL-1.3c.txt",
    "notices/license-texts/SOURCES.md",
    "source/package.json",
    "source/package-lock.json",
    "source/tsconfig.json",
    "source/zotero-plugin.config.ts",
    "source/typings/global.d.ts",
    "source/LICENSE",
]
SOURCE_FILES = [
    "LICENSE",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "zotero-plugin.config.ts",
    "typings/global.d.ts",
]
AGPL = ("GNU AFFERO GENERAL PUBLIC LICENSE", "Version 3")


def main() -> int:
    if not XPI.is_file():
        print(f"Missing {XPI}; run npm run build first", file=sys.stderr)
        return 1
    package = json.loads((REPO / "package.json").read_text(encoding="utf-8"))
    problems: list[str] = []

    def require(condition: bool, message: str) -> None:
        if not condition:
            problems.append(message)

    with zipfile.ZipFile(XPI) as archive:
        names = set(archive.namelist())
        read = archive.read

        missing = [name for name in REQUIRED if name not in names]
        require(not missing, f"XPI is missing: {', '.join(missing)}")
        if missing:
            for problem in problems:
                print(problem, file=sys.stderr)
            return 1

        manifest = json.loads(read("manifest.json"))
        zotero = manifest.get("applications", {}).get("zotero", {})
        require(manifest.get("manifest_version") == 2, "manifest_version must be 2")
        require(manifest.get("name") == package["config"]["addonName"], "manifest name differs from package config")
        require(manifest.get("version") == package["version"], "manifest version differs from package.json")
        require(zotero.get("id") == package["config"]["addonID"], "manifest add-on ID differs from package config")
        update_url = str(zotero.get("update_url", ""))
        require(bool(update_url), "manifest update_url is empty")
        require(
            urlsplit(update_url).hostname not in (None, "", "localhost"),
            "manifest update_url has no host",
        )
        require(
            update_url == UPDATE_URL,
            "manifest update_url is not the GitHub releases update manifest",
        )
        require(bool(zotero.get("strict_min_version")), "manifest strict_min_version is empty")
        require(bool(zotero.get("strict_max_version")), "manifest strict_max_version is empty")
        require(UPDATE_JSON.is_file(), f"Missing {UPDATE_JSON}")
        if UPDATE_JSON.is_file():
            published = json.loads(UPDATE_JSON.read_text(encoding="utf-8"))
            updates = published.get("addons", {}).get(package["config"]["addonID"], {}).get("updates", [])
            if not isinstance(updates, list):
                updates = []
            version = package["version"]
            link = (
                "https://github.com/atsyplenkov/zotero-mupdf-compress/releases/download/"
                f"v{version}/mu-pdf-compress.xpi"
            )
            entry = next(
                (item for item in updates if isinstance(item, dict) and item.get("version") == version),
                None,
            )
            require(entry is not None, "update.json has no entry for the package version")
            if entry is not None:
                compatibility = (entry.get("applications") or {}).get("zotero") or {}
                require(
                    entry.get("update_link") == link,
                    "update.json update_link is not the GitHub release XPI",
                )
                require(
                    compatibility.get("strict_min_version") == zotero.get("strict_min_version"),
                    "update.json strict_min_version differs from the manifest",
                )
                require(
                    compatibility.get("strict_max_version") == zotero.get("strict_max_version"),
                    "update.json strict_max_version differs from the manifest",
                )

        for name in ("LICENSE", "notices/MuPDF-COPYING"):
            text = read(name).decode("utf-8", errors="replace")
            for phrase in AGPL:
                require(phrase in text, f"{name} does not contain {phrase!r}")

        digests = json.loads(read("native/digests.json"))
        for name in ("mutool", "session-lock"):
            digest = str(digests.get(name, ""))
            require(bool(SHA256.fullmatch(digest)), f"digests.json has no valid {name} digest")
            actual = hashlib.sha256(read("native/" + name)).hexdigest()
            require(actual == digest, f"packaged {name} does not match its recorded digest")
            require(actual in read("BUILD-RECORD.md").decode(), f"BUILD-RECORD.md does not state the {name} digest")
        require(digests.get("source") == MUPDF_SOURCE, "digests.json source URL differs from the pin")
        require(digests.get("sourceSha256") == MUPDF_SHA256, "digests.json source checksum differs from the pin")

        source = read("SOURCE.md").decode()
        require(MUPDF_SOURCE in source, "SOURCE.md does not name the pinned MuPDF source")
        require(MUPDF_SHA256 in source, "SOURCE.md does not state the pinned source checksum")
        record = read("BUILD-RECORD.md").decode()
        require("GLIBC_2.43" in record, "BUILD-RECORD.md does not record the measured runtime symbol requirement")
        require("not" in record.lower(), "BUILD-RECORD.md does not state its limits")

        for name in SOURCE_FILES:
            require(
                read("source/" + name) == (REPO / name).read_bytes(),
                f"source/{name} differs from the repository file",
            )
        for path in sorted((REPO / "src").rglob("*")):
            if not path.is_file():
                continue
            entry = "source/src/" + path.relative_to(REPO / "src").as_posix()
            require(entry in names, f"XPI is missing extension source {entry}")
            if entry in names:
                require(read(entry) == path.read_bytes(), f"{entry} differs from the repository file")

    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1
    print(f"Distribution checks passed for {XPI.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
