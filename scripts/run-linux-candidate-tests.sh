#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
IMAGE=${1:?Usage: run-linux-candidate-tests.sh IMAGE EXTRACTED_NATIVE_DIR}
NATIVE=$(cd -- "${2:?Usage: run-linux-candidate-tests.sh IMAGE EXTRACTED_NATIVE_DIR}" && pwd -P)
NODE=$(readlink -f -- "$(node -p 'process.execPath')")
docker image inspect --format 'Test image ID: {{.Id}}' "$IMAGE"
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$ROOT,target=/work,readonly" \
  --mount "type=bind,source=$NATIVE,target=/candidate-native,readonly" \
  --mount "type=bind,source=$NODE,target=/usr/local/bin/node,readonly" \
  --workdir /work --env MUPDF_NATIVE_DIR=/candidate-native "$IMAGE" \
  bash -euo pipefail -c '
    cat /etc/os-release
    getconf GNU_LIBC_VERSION
    ldd /usr/local/bin/node
    node --version
    node --test src/engine.test.ts src/session-lock.test.ts src/session.test.ts
  '
