/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const repository = "atsyplenkov/zotero-mupdf-compress";
const packageInfo = JSON.parse(readFileSync("package.json", "utf8"));
const { version } = packageInfo;
const addonID = packageInfo.config.addonID;
const digests = JSON.parse(readFileSync("addon/native/digests.json", "utf8"));
const tag = `v${version}`;
const xpiName = "mu-pdf-compress.xpi";
const sourceName = basename(new URL(digests.source).pathname);
const temporary = mkdtempSync(join(tmpdir(), "mupdf-release-"));

function run(command, args, output = "inherit") {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", output, "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit status ${result.status}`);
  return result.stdout;
}

function gh(...args) {
  return run("gh", [...args, "--repo", repository]);
}

function releases() {
  const output = run("gh", ["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"], "pipe");
  const pages = JSON.parse(output);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error("GitHub release listing is invalid");
  }
  const items = pages.flat();
  if (items.some((item) => typeof item?.tag_name !== "string" || typeof item.draft !== "boolean")) {
    throw new Error("GitHub release listing is invalid");
  }
  return items;
}

function findRelease(items, name) {
  const matches = items.filter((item) => item.tag_name === name);
  if (matches.length > 1) throw new Error(`Multiple releases found for ${name}`);
  return matches[0];
}

function checkHistory(items) {
  const updates = items
    .filter((item) => !item.draft && /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.tag_name))
    .map((item) => ({ version: item.tag_name.slice(1) }));
  if (updates.length === 0) return;
  const path = join(temporary, "history.json");
  writeFileSync(path, JSON.stringify({ addons: { [addonID]: { updates } } }));
  run(process.execPath, ["scripts/refuse-older-update.mjs", version, path]);
}

async function digest(path, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function validateAssets(directory) {
  const xpi = join(directory, xpiName);
  const source = join(directory, sourceName);
  const update = JSON.parse(readFileSync(join(directory, "update.json"), "utf8"));
  const updates = update?.addons?.[addonID]?.updates;
  if (!Array.isArray(updates) || updates.length !== 1 || updates[0]?.version !== version) {
    throw new Error("Version release update.json does not offer the package version");
  }
  const entry = updates[0];
  const zotero = entry.applications?.zotero;
  if (entry.update_link !== `https://github.com/${repository}/releases/download/${tag}/${xpiName}` ||
      entry.update_hash !== `sha512:${await digest(xpi, "sha512")}` ||
      typeof zotero?.strict_min_version !== "string" || !zotero.strict_min_version ||
      typeof zotero.strict_max_version !== "string" || !zotero.strict_max_version) {
    throw new Error("Version release update.json does not match its XPI or compatibility bounds");
  }
  if (await digest(source, "sha256") !== digests.sourceSha256) {
    throw new Error("MuPDF source archive checksum does not match digests.json");
  }
}

function downloadAssets(release) {
  if (!Array.isArray(release.assets)) throw new Error(`${tag} release assets are missing`);
  for (const name of [xpiName, sourceName, "update.json"]) {
    const matches = release.assets.filter((asset) => asset.name === name && asset.state === "uploaded");
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id)) {
      throw new Error(`${tag} release is missing the uploaded ${name} asset`);
    }
    const fd = openSync(join(temporary, name), "w");
    try {
      run("gh", ["api", `repos/${repository}/releases/assets/${matches[0].id}`,
        "--header", "Accept: application/octet-stream"], fd);
    } finally {
      closeSync(fd);
    }
  }
}

try {
  const components = JSON.parse(readFileSync("addon/native/components.json", "utf8"));
  const required = ["linux-x86_64", "windows-x86_64", "macos-x86_64", "macos-arm64"];
  if (!required.every((platform) => components.platforms?.[platform])) {
    throw new Error("Stable publication requires all four native platforms; this candidate is development-only");
  }
  run(process.execPath, ["scripts/refuse-older-update.mjs", version, "--check-tag"]);
  let items = releases();
  checkHistory(items);
  let release = findRelease(items, tag);
  if (release && release.prerelease !== false) throw new Error(`${tag} is a prerelease`);

  if (!release || release.draft) {
    run("npm", ["run", "build"]);
    run("python3", ["scripts/check-distribution.py"]);
    run("curl", ["-fsSL", digests.source, "-o", join(temporary, sourceName)]);
    const build = ".scaffold/build";
    copyFileSync(join(build, xpiName), join(temporary, xpiName));
    copyFileSync(join(build, "update.json"), join(temporary, "update.json"));
    await validateAssets(temporary);

    if (!release) {
      gh("release", "create", tag, "--draft", "--verify-tag", "--title", `Release ${tag}`, "--generate-notes");
    }
    release = findRelease(releases(), tag);
    if (!release?.draft || release.prerelease !== false) throw new Error(`${tag} is not a stable draft`);
    gh("release", "upload", tag, join(temporary, xpiName), join(temporary, sourceName),
      join(temporary, "update.json"), "--clobber");
    release = findRelease(releases(), tag);
    if (!release?.draft || release.prerelease !== false) throw new Error(`${tag} is not a stable draft`);
    downloadAssets(release);
    await validateAssets(temporary);
    gh("release", "edit", tag, "--draft=false");
  } else {
    downloadAssets(release);
    await validateAssets(temporary);
  }

  items = releases();
  release = findRelease(items, tag);
  if (!release || release.draft || release.prerelease !== false) throw new Error(`${tag} is not published`);
  checkHistory(items);
  const feedRelease = findRelease(items, "release");
  if (feedRelease?.draft) throw new Error("The update feed release is still a draft");
  if (!feedRelease) {
    gh("release", "create", "release", "--prerelease", "--latest=false", "--title", "Release Manifest",
      "--notes", "This release hosts the Zotero update manifest.");
  }
  gh("release", "upload", "release", join(temporary, "update.json"), "--clobber");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
