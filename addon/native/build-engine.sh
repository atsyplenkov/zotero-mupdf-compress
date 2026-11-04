#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
umask 077
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
ROOT=$(cd -- "$HERE/../.." && pwd -P)
URL=https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz
SHA256=98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934
WORK="$ROOT/.scaffold/native-build"
ARCHIVE="$WORK/downloads/mupdf-1.28.5-source.tar.gz"
SOURCE="$WORK/build/mupdf-1.28.5-source"
LOG="$WORK/native-build.txt"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
  echo "This recipe builds the Linux x86_64 artifact only." >&2
  exit 1
}
mkdir -p "$WORK/downloads" "$WORK/build"
if [[ ! -f $ARCHIVE ]]; then
  curl --fail --location "$URL" -o "$ARCHIVE.part"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
printf '%s  %s\n' "$SHA256" "$ARCHIVE" | sha256sum -c -
rm -rf "$SOURCE"
tar -xzf "$ARCHIVE" -C "$WORK/build"
make -C "$SOURCE" -j"${JOBS:-4}" build=release tools \
  HAVE_X11=no HAVE_GLUT=no HAVE_LIBCRYPTO=no HAVE_CURL=no
install -m 0755 "$SOURCE/build/release/mutool" "$HERE/mutool"
"${CC:-cc}" -std=c11 -O2 -Wall -Wextra -Werror \
  "$HERE/session-lock.c" -o "$HERE/session-lock"
chmod 0755 "$HERE/session-lock"
MUTOOL_SHA=$(sha256sum "$HERE/mutool" | cut -d' ' -f1)
LOCK_SHA=$(sha256sum "$HERE/session-lock" | cut -d' ' -f1)
cat > "$HERE/digests.json" <<JSON
{
  "mutool": "$MUTOOL_SHA",
  "session-lock": "$LOCK_SHA",
  "source": "$URL",
  "sourceSha256": "$SHA256"
}
JSON
chmod 0644 "$HERE/digests.json"
{
  printf 'Source URL: %s\nSource SHA-256: %s\n' "$URL" "$SHA256"
  printf 'Build flags: make -j%s build=release tools HAVE_X11=no HAVE_GLUT=no HAVE_LIBCRYPTO=no HAVE_CURL=no\n' "${JOBS:-4}"
  date -u +'%Y-%m-%dT%H:%M:%SZ'
  "${CC:-cc}" --version
  "${CXX:-c++}" --version
  uname -srmo
  "$HERE/mutool" -v 2>&1
  printf '%s  %s\n%s  %s\n' "$MUTOOL_SHA" "$HERE/mutool" "$LOCK_SHA" "$HERE/session-lock"
  stat -c '%n: %s bytes, mode %a' "$HERE/mutool" "$HERE/session-lock"
  ldd "$HERE/mutool"
  ldd "$HERE/session-lock"
  printf '\nMuPDF symbol versions:\n'
  readelf --version-info "$HERE/mutool"
  printf '\nSession-lock symbol versions:\n'
  readelf --version-info "$HERE/session-lock"
} > "$LOG"
echo "Built $HERE/mutool and $HERE/session-lock"
echo "Wrote $HERE/digests.json"
echo "Build log: $LOG"
echo "Record the measured values in BUILD-RECORD.md before distributing."
