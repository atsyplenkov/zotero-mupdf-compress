#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
umask 077
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(cd -- "$HERE/../.." && pwd -P)
OUTPUT="$HERE/linux-x86_64"

# A second invocation captures the complete build, including failed commands.
if [[ ${NATIVE_TRACE_ACTIVE:-} != 1 ]]; then
  mkdir -p "$OUTPUT"
  NATIVE_TRACE_ACTIVE=1 "$0" "$@" 2>&1 | tee "$OUTPUT/build-trace.txt"
  exit
fi
set -x
URL=https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz
SHA256=98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934
BASE=ubuntu:22.04@sha256:076e7bf82319619f28dd0aa9c02ab34b055ad37100395b4f49a2ffba04fb5e11
WORK="$ROOT/.scaffold/native-build"
ARCHIVE="$WORK/downloads/mupdf-1.28.5-source.tar.gz"
SOURCE="$WORK/build/mupdf-1.28.5-source"

[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
  echo "This recipe builds the Linux x86-64 artifact only." >&2; exit 1;
}
# The CI recipe passes the image ID and source revision from the host.
[[ ${NATIVE_BASE_IMAGE:-} == "$BASE" && ${NATIVE_IMAGE_ID:-} =~ ^sha256:[a-f0-9]{64}$ &&
   ${NATIVE_SOURCE_REVISION:-} =~ ^[a-f0-9]{40}$ ]] || {
  echo "The pinned container identity and source revision are required." >&2; exit 1;
}
# shellcheck source=/dev/null
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 22.04 ]] || {
  echo "The native build must run inside Ubuntu 22.04." >&2; exit 1;
}

mkdir -p "$WORK/downloads" "$WORK/build"
if [[ ! -f $ARCHIVE ]]; then
  curl --fail --location --retry 3 "$URL" -o "$ARCHIVE.part"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
printf '%s  %s\n' "$SHA256" "$ARCHIVE" | sha256sum -c -
rm -rf "$SOURCE"
tar -xzf "$ARCHIVE" -C "$WORK/build"
JOBS=${JOBS:-4}
[[ $JOBS =~ ^[1-9][0-9]*$ ]] || { echo "Invalid build parallelism" >&2; exit 1; }
MAKE_ARGS=(-C "$SOURCE" "-j$JOBS" build=release tools HAVE_X11=no HAVE_GLUT=no HAVE_LIBCRYPTO=no HAVE_CURL=no)
CC_ARGS=(-std=c11 -O2 -Wall -Wextra -Werror "$HERE/session-lock.c" -o "$OUTPUT/session-lock")
printf -v MAKE_COMMAND '%q ' make "${MAKE_ARGS[@]}"
printf -v CC_COMMAND '%q ' cc "${CC_ARGS[@]}"
export MAKE_COMMAND CC_COMMAND
make "${MAKE_ARGS[@]}"
install -m 0755 "$SOURCE/build/release/mutool" "$OUTPUT/mutool"
cc "${CC_ARGS[@]}"
chmod 0755 "$OUTPUT/session-lock"
MUTOOL_SHA=$(sha256sum "$OUTPUT/mutool" | cut -d' ' -f1)
LOCK_SHA=$(sha256sum "$OUTPUT/session-lock" | cut -d' ' -f1)
cat > "$HERE/digests.json" <<JSON
{
  "mutool": "$MUTOOL_SHA",
  "session-lock": "$LOCK_SHA",
  "source": "$URL",
  "sourceSha256": "$SHA256"
}
JSON
chmod 0644 "$HERE/digests.json"
python3 - "$HERE" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

native = Path(sys.argv[1])
digests = json.loads((native / "digests.json").read_text())
files = [
    {"name": name, "path": f"linux-x86_64/{name}", "sha256": digests[name], "executable": True}
    for name in ("mutool", "session-lock")
]
identity = hashlib.sha256(json.dumps(files, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
manifest = {
    "schemaVersion": 1,
    "source": digests["source"],
    "sourceSha256": digests["sourceSha256"],
    "platforms": {"linux-x86_64": {
        "os": "Linux", "abi": "x86_64-gcc3", "artifact": identity, "files": files,
    }},
}
(native / "components.json").write_text(json.dumps(manifest, indent=2) + "\n")
PY
chmod 0644 "$HERE/components.json"

# readelf measures the programs without executing them and enforces the target.
python3 "$ROOT/scripts/inspect-linux-native.py" "$OUTPUT" > "$WORK/inspection.json"
python3 - "$ROOT" "$WORK/inspection.json" <<'PY'
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
native = root / "addon/native"
output = native / "linux-x86_64"
digests = json.loads((native / "digests.json").read_text())
files = json.loads(Path(sys.argv[2]).read_text())

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def first_line(*command):
    return subprocess.check_output(command, text=True).splitlines()[0]

inputs = ["addon/native/build-engine.sh", "addon/native/linux.Dockerfile", "scripts/inspect-linux-native.py"]
packages = subprocess.check_output([
    "dpkg-query", "-W", "-f=${Package}=${Version}\n",
    "binutils", "build-essential", "ca-certificates", "curl", "g++", "gcc", "libc6", "libc6-dev", "make", "python3",
], text=True).strip()
record = {
    "schemaVersion": 1,
    "platform": "linux-x86_64",
    "sourceRevision": os.environ["NATIVE_SOURCE_REVISION"],
    "source": {"url": digests["source"], "sha256": digests["sourceSha256"]},
    "helperSourceSha256": digest(native / "session-lock.c"),
    "buildInputs": {name: digest(root / name) for name in inputs},
    "container": {
        "base": os.environ["NATIVE_BASE_IMAGE"],
        "imageId": os.environ["NATIVE_IMAGE_ID"],
        "osRelease": Path("/etc/os-release").read_text().strip(),
    },
    "toolchain": {
        "cc": first_line("cc", "--version"),
        "cxx": first_line("c++", "--version"),
        "make": first_line("make", "--version"),
        "binutils": first_line("readelf", "--version"),
        "packages": packages,
    },
    "commands": [os.environ["MAKE_COMMAND"].strip(), os.environ["CC_COMMAND"].strip()],
    "files": files,
}
(output / "build-record.json").write_text(json.dumps(record, indent=2) + "\n")
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
lines = [
    "# Native build record", "",
    "This record describes the Linux x86-64 programs in this XPI. The target is",
    "glibc 2.35; the requirements below were measured with readelf on these files.",
    "The final release must rebuild and retest the source agreed in issue #34.",
    "MuPDF 1.28.5 was not patched for this development candidate.", "",
    f"- Source archive: `{record['source']['url']}`",
    f"- Source SHA-256: `{record['source']['sha256']}`",
    f"- Helper source SHA-256: `{record['helperSourceSha256']}`",
    f"- Source revision: `{record['sourceRevision']}`",
    f"- Container base: `{record['container']['base']}`",
    f"- Built container image ID: `{record['container']['imageId']}`",
    f"- Recorded at: {now}", "",
    "## Toolchain", "",
]
lines.extend(f"- {name}: `{value}`" for name, value in record["toolchain"].items() if name != "packages")
lines.extend(["", "Installed package versions:", "", "```", packages, "```", "", "## Build commands", "", "```sh"])
lines.extend(record["commands"])
lines.extend(["```", "", "The full traced output is `native/linux-x86_64/build-trace.txt`.", "", "## Measured runtime requirements", ""])
for entry in files:
    lines.extend([
        f"- `native/linux-x86_64/{entry['name']}` SHA-256: `{entry['sha256']}`",
        f"  - Highest GLIBC version: `GLIBC_{entry['glibcMax']}`",
        f"  - GLIBC versions: {', '.join(entry['glibcVersions'])}",
        f"  - Dynamic loader: `{entry['interpreter']}`",
        f"  - Required libraries: {', '.join(entry['needed'])}",
    ])
lines.extend([
    "", "## Limits", "",
    "These measurements are not a claim of support for every Linux distribution,",
    "non-glibc system, or a successful test inside Zotero. The Linux candidate CI",
    "runs the packaged programs in Ubuntu 22.04 and 24.04; its run logs state",
    "which candidate was tested. A noexec location or absent runtime library",
    "prevents execution; there is no fallback engine.", "",
])
(root / "addon/BUILD-RECORD.md").write_text("\n".join(lines))
PY
chmod 0644 "$OUTPUT/build-record.json" "$HERE/../BUILD-RECORD.md"
echo "Built and recorded $OUTPUT/mutool and $OUTPUT/session-lock"
