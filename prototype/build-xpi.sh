#!/usr/bin/env bash
# THROWAWAY #9 prototype. No npm install or external PDF-engine installation.
set -euo pipefail
umask 077
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$REPO"
OUT="$REPO/.local-test/prototype"
for name in mutool session-lock; do
  [[ -x "$OUT/native/$name" ]] || { echo "Run prototype/build-engine.sh first; missing $name" >&2; exit 1; }
done
[[ -d prototype/vendor ]] || { echo 'Missing native license notices; build engine first.' >&2; exit 1; }
node --check prototype/bootstrap.js
node --check prototype/content/progress.js
node --check prototype/content/preferences.js
python - "$REPO" <<'PY'
import hashlib, json, pathlib, sys, zipfile
repo = pathlib.Path(sys.argv[1])
out = repo / '.local-test/prototype'
source = repo / 'prototype'
manifest = {name: hashlib.sha256((out / 'native' / name).read_bytes()).hexdigest()
            for name in ('mutool', 'session-lock')}
target = out / 'mupdf-compress-prototype.xpi'
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in ('bootstrap.js', 'manifest.json', 'README.md'):
        z.write(source / name, name)
    for directory in ('content', 'vendor', 'native'):
        for path in sorted((source / directory).rglob('*')):
            if path.is_file():
                z.write(path, str(path.relative_to(source)))
    for name in manifest:
        z.write(out / 'native' / name, 'bin/' + name)
    z.writestr('native-digests.json', json.dumps(manifest, indent=2) + '\n')
    z.write(source / 'build-engine.sh', 'build-engine.sh')
    z.write(source / 'build-xpi.sh', 'build-xpi.sh')
print(target)
print(json.dumps(manifest, indent=2))
print(f'{target.stat().st_size} bytes')
PY
