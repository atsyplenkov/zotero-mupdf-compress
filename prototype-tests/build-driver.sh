#!/usr/bin/env bash
# Build only. Does not install or launch Zotero.
set -euo pipefail
umask 077
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
OUT="$REPO/.local-test/prototype"
mkdir -p "$OUT"
python - "$REPO" "$OUT" <<'PY'
import pathlib, sys, zipfile
repo, out = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(out / "integration-test-driver.xpi", "w", zipfile.ZIP_DEFLATED) as z:
    for name in ("bootstrap.js", "manifest.json"):
        z.write(repo / "prototype-tests" / "driver" / name, name)
    for name in ("integration.js", "lifecycle-modes.js"):
        z.write(repo / "prototype-tests" / name, name)
print(out / "integration-test-driver.xpi")
PY
