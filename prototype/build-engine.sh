#!/usr/bin/env bash
# Throwaway Linux x86_64 prototype for #9. SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
umask 077
REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
WORK="$REPO/.local-test/prototype"
URL=https://casper.mupdf.com/downloads/archive/mupdf-1.28.5-source.tar.gz
HASH=98a5c10cda20c3992cdf76ff6b2a1149c32bd79cc796d3f703230b1185b7e934
ARCHIVE="$WORK/downloads/mupdf-1.28.5-source.tar.gz"
SOURCE="$WORK/build/mupdf-1.28.5-source"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Requires Linux x86_64' >&2; exit 1; }
mkdir -p "$WORK"/{downloads,build,native,logs}
if [[ ! -f "$ARCHIVE" ]]; then
  curl --fail --location "$URL" -o "$ARCHIVE.part"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
printf '%s  %s\n' "$HASH" "$ARCHIVE" | sha256sum -c -
if [[ ! -d "$SOURCE" ]]; then
  tar -xzf "$ARCHIVE" -C "$WORK/build"
fi
# The build tree is disposable; do not patch it.
make -C "$SOURCE" -j"${JOBS:-4}" build=release tools \
  HAVE_X11=no HAVE_GLUT=no HAVE_LIBCRYPTO=no HAVE_CURL=no
install -m 0755 "$SOURCE/build/release/mutool" "$WORK/native/mutool"
"${CC:-cc}" -std=c11 -O2 -Wall -Wextra -Werror \
  "$REPO/prototype/native/session-lock.c" -o "$WORK/native/session-lock"
chmod 0755 "$WORK/native/session-lock"
{
  printf 'Source URL: %s\nSource SHA-256: %s\n' "$URL" "$HASH"
  printf 'Build flags: make -j%s build=release tools HAVE_X11=no HAVE_GLUT=no HAVE_LIBCRYPTO=no HAVE_CURL=no\n' "${JOBS:-4}"
  date -u +'%Y-%m-%dT%H:%M:%SZ'
  "${CC:-cc}" --version
  "${CXX:-c++}" --version
  uname -srmo
  "$WORK/native/mutool" -v 2>&1
  sha256sum "$ARCHIVE" "$WORK/native/mutool" "$WORK/native/session-lock"
  stat -c '%n: %s bytes, mode %a' "$WORK/native/mutool" "$WORK/native/session-lock"
  ldd "$WORK/native/mutool"
  ldd "$WORK/native/session-lock"
  printf '\nMuPDF symbol versions:\n'
  readelf --version-info "$WORK/native/mutool"
  printf '\nSession-lock symbol versions:\n'
  readelf --version-info "$WORK/native/session-lock"
} > "$WORK/logs/native-build.txt"
python "$REPO/prototype/native/collect-notices.py"
echo "Artifacts: $WORK/native"
echo "Build evidence: $WORK/logs/native-build.txt"
