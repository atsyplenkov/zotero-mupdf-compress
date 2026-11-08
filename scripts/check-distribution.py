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
    "native/linux.Dockerfile",
    "native/session-lock.c",
    "native/build-windows.ps1",
    "native/session-lock-windows.c",
    "native/linux-x86_64/build-record.json",
    "native/linux-x86_64/build-trace.txt",
    "source/scripts/inspect-linux-native.py",
    "source/scripts/extract-linux-candidate.py",
    "source/scripts/run-linux-candidate-tests.sh",
    "source/scripts/configure-windows-native.py",
    "source/scripts/inspect-windows-native.py",
    "source/scripts/record-windows-native.py",
    "source/.github/workflows/linux-candidate.yml",
    "source/.github/workflows/windows-candidate.yml",
    "native/digests.json",
    "native/components.json",
    "native/linux-x86_64/mutool",
    "native/linux-x86_64/session-lock",
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
    "source/Makefile",
    "source/mise.toml",
    "source/mise.lock",
]
SOURCE_FILES = [
    "LICENSE",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "zotero-plugin.config.ts",
    "typings/global.d.ts",
    "Makefile",
    "mise.toml",
    "mise.lock",
    "scripts/inspect-linux-native.py",
    "scripts/extract-linux-candidate.py",
    "scripts/run-linux-candidate-tests.sh",
    "scripts/configure-windows-native.py",
    "scripts/inspect-windows-native.py",
    "scripts/record-windows-native.py",
    ".github/workflows/linux-candidate.yml",
    ".github/workflows/windows-candidate.yml",
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
        require(zotero.get("strict_min_version") == "10.0", "manifest must require Zotero 10")
        require(zotero.get("strict_max_version") == "10.*", "manifest must be limited to Zotero 10")
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
                    entry.get("update_hash") == "sha512:" + hashlib.sha512(XPI.read_bytes()).hexdigest(),
                    "update.json update_hash does not match the built XPI",
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
            actual = hashlib.sha256(read("native/linux-x86_64/" + name)).hexdigest()
            require(actual == digest, f"packaged {name} does not match its recorded digest")
            require(actual in read("BUILD-RECORD.md").decode(), f"BUILD-RECORD.md does not state the {name} digest")
        components = json.loads(read("native/components.json"))
        require(components.get("schemaVersion") == 1, "unsupported component manifest version")
        require(components.get("source") == MUPDF_SOURCE, "components.json source URL differs from the pin")
        require(components.get("sourceSha256") == MUPDF_SHA256, "components.json source checksum differs from the pin")
        platforms = components.get("platforms", {})
        require("linux-x86_64" in platforms, "components.json has no Linux x86-64 set")
        for platform_id, platform in platforms.items():
            files = platform.get("files", [])
            identity = hashlib.sha256(json.dumps(files, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
            require(platform.get("artifact") == identity, f"{platform_id} artifact identity differs from its files")
            if platform_id == "linux-x86_64":
                require(platform.get("os") == "Linux" and platform.get("abi") == "x86_64-gcc3", "incorrect Linux runtime selection")
            if platform_id == "windows-x86_64":
                require(platform.get("os") == "WINNT" and platform.get("abi") == "x86_64-msvc", "incorrect Windows runtime selection")
            required_files = {"mutool.exe", "session-lock.exe"} if platform_id == "windows-x86_64" else {"mutool", "session-lock"}
            seen = set()
            normalized_seen = set()
            for component in files:
                name = component.get("name", "")
                safe_name = bool(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", name))
                if platform_id == "windows-x86_64":
                    safe_name = safe_name and not name.endswith(".") and not re.match(
                        r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", name, re.I,
                    )
                normalized = name.lower() if platform_id == "windows-x86_64" else name
                require(safe_name and normalized not in normalized_seen, f"{platform_id} has an unsafe or duplicate component name")
                normalized_seen.add(normalized)
                seen.add(name)
                path = component.get("path", "")
                require(path == f"{platform_id}/{name}", f"{platform_id} has an unsafe component path")
                entry = "native/" + path
                require(entry in names, f"missing component: {entry}")
                require(isinstance(component.get("executable"), bool), f"{entry} has no executable mode")
                digest = component.get("sha256", "")
                require(bool(SHA256.fullmatch(digest)), f"{entry} has an invalid digest")
                if entry in names:
                    require(hashlib.sha256(read(entry)).hexdigest() == digest, f"component digest mismatch: {entry}")
                if name in required_files:
                    require(component.get("executable") is True, f"{name} must be executable")
                    if platform_id == "linux-x86_64":
                        require(digest == digests.get(name), f"{name} digest records disagree")
            require(required_files <= seen, f"{platform_id} is missing required executables")

        require(digests.get("source") == MUPDF_SOURCE, "digests.json source URL differs from the pin")
        require(digests.get("sourceSha256") == MUPDF_SHA256, "digests.json source checksum differs from the pin")

        source = read("SOURCE.md").decode()
        require(MUPDF_SOURCE in source, "SOURCE.md does not name the pinned MuPDF source")
        require(MUPDF_SHA256 in source, "SOURCE.md does not state the pinned source checksum")
        record = read("BUILD-RECORD.md").decode()
        require("not" in record.lower(), "BUILD-RECORD.md does not state its limits")
        build = json.loads(read("native/linux-x86_64/build-record.json"))
        require(build.get("schemaVersion") == 1 and build.get("platform") == "linux-x86_64", "invalid Linux build record")
        require(bool(re.fullmatch(r"[a-f0-9]{40}", build.get("sourceRevision", ""))), "build record has no source revision")
        require(build.get("source") == {"url": MUPDF_SOURCE, "sha256": MUPDF_SHA256}, "build record source differs from the pin")
        require(build.get("helperSourceSha256") == hashlib.sha256(read("native/session-lock.c")).hexdigest(), "build record helper source mismatch")
        for path, entry in {
            "addon/native/build-engine.sh": "native/build-engine.sh",
            "addon/native/linux.Dockerfile": "native/linux.Dockerfile",
            "scripts/inspect-linux-native.py": "source/scripts/inspect-linux-native.py",
        }.items():
            require(build.get("buildInputs", {}).get(path) == hashlib.sha256(read(entry)).hexdigest(), f"build recipe mismatch: {path}")
            require(read(entry) == (REPO / path).read_bytes(), f"packaged build recipe differs: {path}")
        container = build.get("container", {})
        require(bool(re.fullmatch(r"ubuntu:22\.04@sha256:[a-f0-9]{64}", container.get("base", ""))), "build container must pin Ubuntu 22.04 by digest")
        require(bool(re.fullmatch(r"sha256:[a-f0-9]{64}", container.get("imageId", ""))), "build record has no container image identity")
        require('VERSION_ID="22.04"' in container.get("osRelease", ""), "build record OS is not Ubuntu 22.04")
        require(bool(build.get("commands")), "build record has no commands")
        require(all(build.get("toolchain", {}).get(key) for key in ("cc", "cxx", "make", "binutils", "packages")), "build record has incomplete toolchain evidence")
        measured = {item["name"]: item for item in build.get("files", [])}
        require(set(measured) == {"mutool", "session-lock"}, "build record is missing executable measurements")
        for name, item in measured.items():
            require(item.get("sha256") == digests.get(name), f"{name} build record digest mismatch")
            version = item.get("glibcMax", "")
            valid_version = bool(re.fullmatch(r"[0-9]+\.[0-9]+", version))
            require(valid_version and tuple(map(int, version.split("."))) <= (2, 35), f"{name} exceeds the glibc 2.35 target")
            require(item.get("interpreter") == "/lib64/ld-linux-x86-64.so.2", f"{name} has an unexpected ELF interpreter")
            needed = set(item.get("needed", []))
            require("libc.so.6" in needed and needed <= {"libc.so.6", "libm.so.6"}, f"{name} has unexpected runtime libraries")
            require(f"GLIBC_{version}" in record, f"BUILD-RECORD.md is missing measured {name} requirements")

        if "windows-x86_64" in platforms:
            windows_record = "native/windows-x86_64/build-record.json"
            windows_trace = "native/windows-x86_64/build-trace.txt"
            require(windows_record in names, "missing Windows build record")
            require(windows_trace in names, "missing Windows build trace")
            if windows_record in names:
                win_build = json.loads(read(windows_record))
                require(win_build.get("schemaVersion") == 1 and win_build.get("platform") == "windows-x86_64", "invalid Windows build record")
                require(bool(re.fullmatch(r"[a-f0-9]{40}", win_build.get("sourceRevision", ""))), "Windows build record has no source revision")
                require(win_build.get("source") == {"url": MUPDF_SOURCE, "sha256": MUPDF_SHA256}, "Windows build record source differs from the pin")
                require(win_build.get("helperSourceSha256") == hashlib.sha256(read("native/session-lock-windows.c")).hexdigest(), "Windows helper source mismatch")
                for path, entry in {
                    "addon/native/build-windows.ps1": "native/build-windows.ps1",
                    "scripts/configure-windows-native.py": "source/scripts/configure-windows-native.py",
                    "scripts/inspect-windows-native.py": "source/scripts/inspect-windows-native.py",
                    "scripts/record-windows-native.py": "source/scripts/record-windows-native.py",
                }.items():
                    require(win_build.get("buildInputs", {}).get(path) == hashlib.sha256(read(entry)).hexdigest(), f"Windows build recipe mismatch: {path}")
                    require(read(entry) == (REPO / path).read_bytes(), f"packaged Windows build recipe differs: {path}")
                require(win_build.get("target") == "Windows 10 x64", "invalid Windows target")
                require(win_build.get("runtime") == "MSVC static CRT (/MT)", "Windows build does not select static CRT")
                require(bool(win_build.get("configuration")) and bool(win_build.get("commands")), "Windows build record is incomplete")
                require(all(win_build.get("toolchain", {}).get(key) for key in
                            ("runner", "runner_version", "os_version", "msbuild", "msvc", "sdk")), "Windows toolchain evidence is incomplete")
                measurements = {item["name"]: item for item in win_build.get("files", [])}
                require(set(measurements) == {"mutool.exe", "session-lock.exe"}, "Windows build measurements are incomplete")
                win_files = {item["name"]: item for item in platforms["windows-x86_64"].get("files", [])}
                for name, item in measurements.items():
                    require(item.get("sha256") == win_files.get(name, {}).get("sha256"), f"Windows build record digest mismatch: {name}")
                    require(item.get("machine") == "AMD64", f"Windows build record has wrong architecture: {name}")
                    require(item.get("delayImports") == [], f"Windows build record has delay imports: {name}")
                    require(isinstance(item.get("needed"), list), f"Windows build record lacks imports: {name}")
                    require(item.get("sha256", "") in record, f"BUILD-RECORD.md is missing Windows {name} digest")

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
