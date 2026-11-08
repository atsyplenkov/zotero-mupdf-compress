/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function checkTag(version) {
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  if (version !== packageVersion) throw new Error("Release version must match package.json");
  const tag = `refs/tags/v${version}`;
  const event = process.env.GITHUB_EVENT_NAME;
  if (event === "push") {
    if (process.env.GITHUB_REF !== tag) throw new Error(`Push tag must match ${tag}`);
  } else if (event !== "workflow_dispatch") {
    throw new Error("Release requires a tag push or workflow_dispatch");
  }
  if (git("rev-parse", "--is-shallow-repository") !== "false") {
    throw new Error("Release requires complete fetched Git history (fetch-depth: 0)");
  }
  const head = git("rev-parse", "--verify", "HEAD^{commit}");
  const target = git("rev-parse", "--verify", `${tag}^{commit}`);
  if (head !== target) throw new Error(`${tag} must point to the checked-out commit`);
  const main = git("rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
  try {
    git("merge-base", "--is-ancestor", target, main);
  } catch {
    throw new Error(`${tag} must be in fetched origin/main history`);
  }
}

function stableVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid stable version: ${String(value)}`);
  }
  return value.split(".").map(BigInt);
}

try {
  if (process.argv.length < 3 || process.argv.length > 4) {
    throw new Error("Usage: node scripts/refuse-older-update.mjs VERSION [UPDATE_JSON | --check-tag]");
  }
  const version = process.argv[2];
  const candidate = stableVersion(version);
  const path = process.argv[3];
  if (path === "--check-tag") {
    checkTag(version);
  } else if (path !== undefined) {
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
