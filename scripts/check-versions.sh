#!/usr/bin/env bash
# Fail when AGENTS.md does not record the pinned tool versions.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$root"

agents=$(sed -n '/^## Versions$/,/^## /p' AGENTS.md)
if [[ -z "$agents" ]]; then
  echo "AGENTS.md has no Versions section." >&2
  exit 1
fi

declare -A expected=()

in_tools=0
while IFS= read -r line; do
  case "$line" in
    "[tools]") in_tools=1; continue ;;
    "["*) in_tools=0; continue ;;
  esac
  [[ "$in_tools" -eq 1 ]] || continue
  [[ "$line" =~ ^([A-Za-z0-9_.:@/-]+|[[:space:]]*\"[^\"]+\")[[:space:]]*=[[:space:]]*\"([^\"]+)\" ]] || continue
  name=${BASH_REMATCH[1]//\"/}
  version=${BASH_REMATCH[2]}
  case "$name" in
    github:agent-sh/agnix) name=agnix ;;
  esac
  expected["$name"]=$version
done < mise.toml

while IFS= read -r pair; do
  name=${pair%% *}
  version=${pair#* }
  case "$name" in
    @commitlint/config-conventional)
      if [[ "${expected[commitlint]:-}" != "$version" ]]; then
        echo "commitlint packages disagree: cli ${expected[commitlint]:-unset}, config $version" >&2
        exit 1
      fi
      ;;
    @commitlint/cli) expected[commitlint]=$version ;;
    *) expected["$name"]=$version ;;
  esac
done < <(python -c 'import json; p=json.load(open("package.json"))["devDependencies"];
[print(k, v) for k, v in p.items()]')

if ! npm_version=$(npm --version 2>/dev/null); then
  echo "npm is not on PATH, so its recorded version cannot be checked." >&2
  exit 1
fi
expected[npm]=$npm_version

declare -A recorded=()
while IFS= read -r line; do
  [[ "$line" =~ ^-\ ([^[:space:]]+)\ ([^[:space:]]+)$ ]] || continue
  recorded["${BASH_REMATCH[1]}"]=${BASH_REMATCH[2]}
done <<< "$agents"

failed=0
for name in "${!expected[@]}"; do
  if [[ -z "${recorded[$name]:-}" ]]; then
    echo "AGENTS.md does not record $name ${expected[$name]}" >&2
    failed=1
  elif [[ "${recorded[$name]}" != "${expected[$name]}" ]]; then
    echo "AGENTS.md records $name ${recorded[$name]}, pin is ${expected[$name]}" >&2
    failed=1
  fi
done
for name in "${!recorded[@]}"; do
  if [[ -z "${expected[$name]:-}" ]]; then
    echo "AGENTS.md records $name ${recorded[$name]}, which is not a current pin" >&2
    failed=1
  fi
done

exit "$failed"
