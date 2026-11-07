#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$root"

expected_npm=$(python - <<'PY'
import json
import sys

with open("package.json", encoding="utf-8") as file:
    package = json.load(file)

dependencies = package["devDependencies"]
cli = dependencies.get("@commitlint/cli")
config = dependencies.get("@commitlint/config-conventional")
if not cli or not config or cli != config:
    print(f"commitlint packages disagree: cli {cli or 'unset'}, config {config or 'unset'}", file=sys.stderr)
    sys.exit(1)

manager = package.get("packageManager", "")
if not isinstance(manager, str) or not manager.startswith("npm@") or not manager[4:]:
    print("package.json must pin npm in packageManager as npm@<version>", file=sys.stderr)
    sys.exit(1)
print(manager[4:])
PY
)

if ! npm_version=$(npm --version 2>/dev/null); then
  echo "npm is not on PATH, so its recorded version cannot be checked." >&2
  exit 1
fi
if [[ "$npm_version" != "$expected_npm" ]]; then
  echo "npm is $npm_version, package.json pins $expected_npm" >&2
  exit 1
fi
