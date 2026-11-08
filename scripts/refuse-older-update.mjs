/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { readFileSync } from "node:fs";

function stableVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid stable version: ${String(value)}`);
  }
  return value.split(".").map(BigInt);
}

try {
  if (process.argv.length < 3 || process.argv.length > 4) {
    throw new Error("Usage: node scripts/refuse-older-update.mjs VERSION [UPDATE_JSON]");
  }
  const version = process.argv[2];
  const candidate = stableVersion(version);
  const path = process.argv[3];
  if (path !== undefined) {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const updates = data?.addons?.["mupdf-compress@atsyplenkov.github.io"]?.updates;
    if (!Array.isArray(updates) || updates.length === 0) {
      throw new Error("update.json must contain updates for the add-on");
    }
    for (const update of updates) {
      const published = stableVersion(update?.version);
      for (let i = 0; i < candidate.length; i++) {
        if (published[i] > candidate[i]) {
          throw new Error(`update.json already offers ${update.version}, which is newer than ${version}`);
        }
        if (published[i] < candidate[i]) break;
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
