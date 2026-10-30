#!/usr/bin/env bash
# Fail when a secret-scanner allow comment has no current review date.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$root"

roots=(addon src scripts docs .github typings prototype prototype-tests AGENTS.md README.md)
files=()
for place in "${roots[@]}"; do
  [[ -e "$place" ]] || continue
  if [[ -f "$place" ]]; then
    files+=("$place")
    continue
  fi
  while IFS= read -r -d '' file; do
    files+=("$file")
  done < <(find "$place" -type f \( \
    -name '*.py' -o -name '*.sh' -o -name '*.js' -o -name '*.mjs' -o \
    -name '*.ts' -o -name '*.md' -o -name '*.yml' -o -name '*.yaml' -o \
    -name '*.json' -o -name '*.toml' -o -name '*.pkl' -o -name '*.xhtml' \
    \) -print0)
done

today=$(date -I)
failed=0
seen=0

for file in "${files[@]}"; do
  [[ -f "$file" ]] || continue
  # This file names the marker in its own source. It is not an allow comment.
  [[ "$file" == scripts/check-review-dates.sh ]] && continue
  line_no=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    case "$line" in
      *betterleaks:allow*|*gitleaks:allow*) ;;
      *) continue ;;
    esac
    seen=$((seen + 1))
    if [[ ! "$line" =~ \(review\ ([0-9]{4}-[0-9]{2}-[0-9]{2})\) ]]; then
      echo "$file:$line_no: allow comment needs (review YYYY-MM-DD)" >&2
      failed=1
      continue
    fi
    review="${BASH_REMATCH[1]}"
    if ! normalized=$(date -d "$review" +%F 2>/dev/null) || [[ "$normalized" != "$review" ]]; then
      echo "$file:$line_no: review date is not a real date: $review" >&2
      failed=1
      continue
    fi
    if [[ "$review" < "$today" ]]; then
      echo "$file:$line_no: review date has passed: $review" >&2
      failed=1
    fi
    reason=${line#*allow}
    reason=${reason%%(review*}
    words=$(printf '%s' "$reason" | wc -w)
    if [[ "$words" -lt 3 ]]; then
      echo "$file:$line_no: allow comment needs a reason, not a single word" >&2
      failed=1
    fi
  done < "$file"
done

exit "$failed"
