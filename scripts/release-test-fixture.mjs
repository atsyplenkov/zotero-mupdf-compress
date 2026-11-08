/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { execFileSync } from "node:child_process";

export function setupGit(directory) {
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=Release Test", "-c", "user.email=release@example.test",
    "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", ...args,
  ], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("add", "package.json");
  git("commit", "-m", "Initial version");
  git("remote", "add", "origin", directory);
  git("fetch", "origin", "refs/heads/main:refs/remotes/origin/main");
  git("tag", "v1.0.0");
  return git;
}
