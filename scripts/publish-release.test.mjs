/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { deepEqual, doesNotMatch, equal, match, notEqual, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const publisher = fileURLToPath(new URL("./publish-release.mjs", import.meta.url));
const guard = fileURLToPath(new URL("./refuse-older-update.mjs", import.meta.url));
const addonID = "mupdf-compress@atsyplenkov.github.io";

// The fake commands model persisted releases across separate workflow attempts.
async function fakeCommand() {
  const { createHash } = await import("node:crypto");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const file = process.env.FAKE_STATE;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  const command = path.basename(process.argv[1]);
  const args = process.argv.slice(2);
  const save = () => fs.writeFileSync(file, JSON.stringify(state));
  const fail = (message) => { console.error(message); save(); process.exit(1); };
  state.log.push([command, ...args]);
  save();
  if (command === "npm") {
    state.builds++;
    const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
    const xpi = Buffer.from(`xpi from build ${state.builds}`);
    const update = { addons: { "mupdf-compress@atsyplenkov.github.io": { updates: [{
      version,
      update_link: `https://github.com/atsyplenkov/zotero-mupdf-compress/releases/download/v${version}/mu-pdf-compress.xpi`,
      update_hash: `sha512:${createHash("sha512").update(xpi).digest("hex")}`,
      applications: { zotero: { strict_min_version: "6.999", strict_max_version: "10.0.*" } },
    }] } } };
    fs.mkdirSync(".scaffold/build", { recursive: true });
    fs.writeFileSync(".scaffold/build/mu-pdf-compress.xpi", xpi);
    fs.writeFileSync(".scaffold/build/update.json", JSON.stringify(update));
  } else if (command === "python3") {
    if (state.failDistribution) fail("distribution check failed");
  } else if (command === "curl") {
    if (state.failSource) fail("source download failed");
    fs.writeFileSync(args[args.indexOf("-o") + 1], state.corruptSource ? "bad source" : state.source);
  } else if (command === "gh" && args[0] === "api") {
    const endpoint = args[1];
    if (endpoint.includes("releases?per_page=100")) {
      if (state.failList) fail("GitHub authentication or network failure");
      const midpoint = Math.ceil(state.releases.length / 2);
      process.stdout.write(JSON.stringify([state.releases.slice(0, midpoint), state.releases.slice(midpoint)]));
    } else {
      const id = Number(endpoint.split("/").at(-1));
      const asset = state.releases.flatMap((release) => release.assets).find((item) => item.id === id);
      if (!asset || state.failDownload) fail("asset download failed");
      process.stdout.write(Buffer.from(asset.data, "base64"));
    }
  } else if (command === "gh" && args[0] === "release") {
    const action = args[1];
    const tag = args[2];
    let release = state.releases.find((item) => item.tag_name === tag);
    if (action === "create") {
      if (release) fail("release already exists");
      release = { tag_name: tag, draft: args.includes("--draft"), prerelease: args.includes("--prerelease"), assets: [] };
      state.releases.push(release);
    } else if (!release) {
      fail("release not found");
    } else if (action === "upload") {
      if (!release.draft && tag !== "release") fail("attempted to change a public version");
      for (const name of args.slice(3, args.indexOf("--repo")).filter((arg) => !arg.startsWith("--"))) {
        const assetName = path.basename(name);
        release.assets = release.assets.filter((asset) => asset.name !== assetName);
        if ((tag === "release" && state.failFeedOnce) || (tag !== "release" && state.failDraftUpload)) {
          state.failFeedOnce = false;
          fail("upload failed after removing the old asset");
        }
        release.assets.push({ id: state.nextID++, name: assetName, state: "uploaded", data: fs.readFileSync(name).toString("base64") });
      }
    } else if (action === "edit") {
      if (!release.draft || !args.includes("--draft=false")) fail("invalid publication");
      release.draft = false;
    } else {
      fail("unexpected release command");
    }
  } else {
    fail("unexpected command");
  }
  save();
}

function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mupdf-publisher-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scripts = join(directory, "scripts");
  const bin = join(directory, "bin");
  mkdirSync(scripts);
  mkdirSync(bin);
  mkdirSync(join(directory, "addon/native"), { recursive: true });
  copyFileSync(guard, join(scripts, "refuse-older-update.mjs"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "1.0.0", config: { addonID } }));
  const source = "verified source archive";
  writeFileSync(join(directory, "addon/native/digests.json"), JSON.stringify({
    source: "https://example.test/mupdf-source.tar.gz",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
  }));
  for (const command of ["gh", "npm", "curl", "python3"]) {
    writeFileSync(join(bin, command), `#!/usr/bin/env node\n(${fakeCommand.toString()})().catch((error) => { console.error(error); process.exit(1); });\n`, { mode: 0o755 });
  }
  const stateFile = join(directory, "state.json");
  const state = { releases: [], log: [], builds: 0, nextID: 1, source, ...overrides };
  const save = (value) => writeFileSync(stateFile, JSON.stringify(value));
  const read = () => JSON.parse(readFileSync(stateFile, "utf8"));
  save(state);
  const run = () => {
    const result = spawnSync(process.execPath, [publisher], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, FAKE_STATE: stateFile, PATH: `${bin}:${process.env.PATH}` },
    });
    if (result.error) throw result.error;
    return result;
  };
  return { run, read, save };
}

function release(state, tag) {
  return state.releases.find((item) => item.tag_name === tag);
}

function asset(releaseInfo, name) {
  const data = releaseInfo.assets.find((item) => item.name === name)?.data;
  return data && Buffer.from(data, "base64").toString();
}

test("the release workflow uses the retry-safe publisher", () => {
  doesNotMatch(workflow, /npx zotero-plugin release/);
  match(workflow, /node scripts\/publish-release\.mjs/);
});

test("a failed feed upload can be retried without rebuilding or changing a public version", (t) => {
  const fixture = setup(t, { failFeedOnce: true, releases: [{
    tag_name: "release", draft: false, prerelease: true,
    assets: [{ id: 1000, name: "update.json", state: "uploaded", data: Buffer.from("old feed").toString("base64") }],
  }] });
  const first = fixture.run();
  notEqual(first.status, 0);
  const published = fixture.read();
  const version = release(published, "v1.0.0");
  equal(version.draft, false);
  equal(published.builds, 1);
  const saved = structuredClone(version.assets);
  equal(release(published, "release").assets.length, 0);
  const retry = fixture.run();
  equal(retry.status, 0, retry.stderr);
  const after = fixture.read();
  equal(after.builds, 1);
  deepEqual(release(after, "v1.0.0").assets, saved);
  equal(asset(release(after, "release"), "update.json"), asset(version, "update.json"));
  const commands = after.log.map((entry) => entry.slice(0, 4).join(" "));
  const publishedAt = commands.findIndex((line) => line.startsWith("gh release edit v1.0.0"));
  const feedAt = commands.findIndex((line) => line.startsWith("gh release upload release"));
  ok(publishedAt >= 0 && feedAt > publishedAt, "feed must follow version publication");
});

test("a missing feed cannot bypass a newer public version, including on a later API page", (t) => {
  const fixture = setup(t, { releases: [
    { tag_name: "v0.9.0", draft: false, prerelease: false, assets: [] },
    { tag_name: "v2.0.0", draft: false, prerelease: false, assets: [] },
  ] });
  const result = fixture.run();
  notEqual(result.status, 0);
  match(result.stderr, /2\.0\.0.*newer/);
  const state = fixture.read();
  equal(state.builds, 0);
  equal(release(state, "release"), undefined);
});

test("source and GitHub failures leave the version and feed unpublished", async (t) => {
  for (const key of ["failList", "failDistribution", "failSource", "corruptSource", "failDraftUpload"]) {
    await t.test(key, (child) => {
      const fixture = setup(child, { [key]: true });
      const result = fixture.run();
      notEqual(result.status, 0);
      const state = fixture.read();
      ok(!release(state, "v1.0.0") || release(state, "v1.0.0").draft);
      equal(release(state, "release"), undefined);
    });
  }
});

test("an asset download failure leaves the published release and stable feed unchanged", (t) => {
  const fixture = setup(t);
  const first = fixture.run();
  equal(first.status, 0, first.stderr);
  const before = fixture.read();
  before.failDownload = true;
  fixture.save(before);
  const failed = fixture.run();
  notEqual(failed.status, 0);
  const after = fixture.read();
  equal(after.builds, 1);
  deepEqual(after.releases, before.releases);
  equal(after.log.filter((entry) => entry[1] === "release" && entry[2] === "upload" && entry[3] === "release").length, 1);
});

test("a partial draft is safely replaced before publication", (t) => {
  const fixture = setup(t, { releases: [{
    tag_name: "v1.0.0", draft: true, prerelease: false,
    assets: [{ id: 99, name: "mu-pdf-compress.xpi", state: "uploaded", data: Buffer.from("old").toString("base64") }],
  }] });
  const result = fixture.run();
  equal(result.status, 0, result.stderr);
  const state = fixture.read();
  equal(release(state, "v1.0.0").draft, false);
  equal(asset(release(state, "v1.0.0"), "mu-pdf-compress.xpi"), "xpi from build 1");
  ok(asset(release(state, "release"), "update.json"));
});

test("an incomplete or corrupt public version fails without rebuilding or changing its assets", async (t) => {
  for (const corruption of ["missing", "mismatched XPI", "mismatched source", "invalid update"]) {
    await t.test(corruption, (child) => {
      const fixture = setup(child);
      equal(fixture.run().status, 0);
      const state = fixture.read();
      const published = release(state, "v1.0.0");
      if (corruption === "missing") published.assets = published.assets.filter((item) => item.name !== "update.json");
      else {
        const name = corruption === "mismatched XPI" ? "mu-pdf-compress.xpi"
          : corruption === "mismatched source" ? "mupdf-source.tar.gz" : "update.json";
        published.assets.find((item) => item.name === name).data = Buffer.from("bad bytes").toString("base64");
      }
      const before = structuredClone(published.assets);
      fixture.save(state);
      const result = fixture.run();
      notEqual(result.status, 0);
      const after = fixture.read();
      equal(after.builds, 1);
      deepEqual(release(after, "v1.0.0").assets, before);
    });
  }
});
