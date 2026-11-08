/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal, notEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setupGit } from "./release-test-fixture.mjs";

const script = fileURLToPath(new URL("./refuse-older-update.mjs", import.meta.url));
const addonID = "mupdf-compress@atsyplenkov.github.io";
const feed = (...versions) => JSON.stringify({
  addons: { [addonID]: { updates: versions.map((version) => ({ version })) } },
});

function runGuard(version, body) {
  const directory = mkdtempSync(join(tmpdir(), "mupdf-update-test-"));
  try {
    const args = [script];
    if (version !== undefined) args.push(version);
    if (body !== undefined) {
      const path = join(directory, "update.json");
      writeFileSync(path, body);
      args.push(path);
    }
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    if (result.error) throw result.error;
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function tagFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "mupdf-tag-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "1.0.0" }));
  const git = setupGit(directory);
  const run = (env = {}, version = "1.0.0", cwd = directory) => spawnSync(process.execPath, [script, version, "--check-tag"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.0.0", ...env },
  });
  return { directory, git, run };
}

test("tag guard accepts a matching stable tag in fetched main history", (t) => {
  const fixture = tagFixture(t);
  const result = fixture.run();
  equal(result.status, 0, result.stderr);
});

test("tag guard rejects a tagged commit outside fetched main history", (t) => {
  const fixture = tagFixture(t);
  fixture.git("checkout", "-b", "unmerged");
  fixture.git("commit", "--allow-empty", "-m", "Unmerged change");
  fixture.git("tag", "-f", "v1.0.0");
  const result = fixture.run();
  notEqual(result.status, 0, result.stderr);
});

test("tag guard rejects shallow history even when main and the tag match", (t) => {
  const fixture = tagFixture(t);
  fixture.git("clone", "--depth=1", `file://${fixture.directory}`, "shallow");
  const result = fixture.run({}, "1.0.0", join(fixture.directory, "shallow"));
  notEqual(result.status, 0, result.stderr);
});

test("tag guard requires the candidate to match package.json", (t) => {
  const fixture = tagFixture(t);
  fixture.git("tag", "v2.0.0");
  const result = fixture.run({ GITHUB_REF: "refs/tags/v2.0.0" }, "2.0.0");
  notEqual(result.status, 0, result.stderr);
});

test("tag guard accepts annotated tags at older commits in fetched main", (t) => {
  const fixture = tagFixture(t);
  fixture.git("tag", "-f", "-a", "v1.0.0", "-m", "Stable version");
  const target = fixture.git("rev-parse", "HEAD");
  fixture.git("commit", "--allow-empty", "-m", "Later main change");
  fixture.git("fetch", "origin", "refs/heads/main:refs/remotes/origin/main");
  fixture.git("checkout", "--detach", target);
  for (const event of ["push", "workflow_dispatch"]) {
    const result = fixture.run({ GITHUB_EVENT_NAME: event });
    equal(result.status, 0, result.stderr);
  }
});

test("tag guard rejects missing tags, wrong commits, and missing main for pushes and dispatches", async (t) => {
  for (const problem of ["missing tag", "wrong commit", "missing main", "unmerged", "non-commit tag"]) {
    await t.test(problem, (child) => {
      const fixture = tagFixture(child);
      if (problem === "missing tag") fixture.git("tag", "-d", "v1.0.0");
      if (problem === "wrong commit") fixture.git("commit", "--allow-empty", "-m", "Wrong checkout");
      if (problem === "missing main") fixture.git("update-ref", "-d", "refs/remotes/origin/main");
      if (problem === "unmerged") {
        fixture.git("checkout", "-b", "unmerged");
        fixture.git("commit", "--allow-empty", "-m", "Unmerged change");
        fixture.git("tag", "-f", "v1.0.0");
      }
      if (problem === "non-commit tag") {
        fixture.git("tag", "-f", "v1.0.0", fixture.git("hash-object", "-w", "package.json"));
      }
      for (const event of ["push", "workflow_dispatch"]) {
        const result = fixture.run({ GITHUB_EVENT_NAME: event });
        notEqual(result.status, 0, `${problem} ${event}: ${result.stderr}`);
      }
    });
  }
});

test("tag guard rejects noncanonical package versions during manual dispatch", (t) => {
  const fixture = tagFixture(t);
  for (const version of ["01.0.0", "1.0", "1.0.0-beta.1", "1.0.0+build"]) {
    writeFileSync(join(fixture.directory, "package.json"), JSON.stringify({ version }));
    fixture.git("tag", `v${version}`);
    const result = fixture.run({ GITHUB_EVENT_NAME: "workflow_dispatch" }, version);
    notEqual(result.status, 0, `${version}: ${result.stderr}`);
  }
});

function workflowCommands(name) {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const start = `      - name: ${name}\n        run: |\n`;
  const block = workflow.split(start)[1]?.split("\n      - name: ")[0];
  if (!block) throw new Error(`Release step not found: ${name}`);
  return block.replace(/^ {10}/gm, "");
}

function runWorkflow({ version = "1.0.0", status = "200", body = feed("1.0.0"), exit = "0" }) {
  const commands = workflowCommands("Refuse an older publish");
  const directory = mkdtempSync(join(tmpdir(), "mupdf-workflow-test-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    mkdirSync(join(directory, "scripts"));
    copyFileSync(script, join(directory, "scripts", "refuse-older-update.mjs"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(bin, "curl"), `#!/bin/bash\n
      touch "$MOCK_CALLED"
      while (($#)); do
        if [[ "$1" == "-o" ]]; then
          printf '%s' "$MOCK_BODY" > "$2"
          shift 2
        else
          shift
        fi
      done
      printf '%s' "$MOCK_STATUS"
      exit "$MOCK_EXIT"
    `, { mode: 0o755 });
    const called = join(directory, "curl-called");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", commands], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: directory,
        MOCK_BODY: body,
        MOCK_STATUS: status,
        MOCK_EXIT: exit,
        MOCK_CALLED: called,
      },
    });
    if (result.error) throw result.error;
    return { result, called: existsSync(called) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("rejects prerelease candidates even when the feed has the stable version", () => {
  const result = runGuard("1.0.0-beta.1", feed("1.0.0"));
  notEqual(result.status, 0, "prereleases must not reach the stable update feed");
});

test("accepts stable versions with no feed or with equal and older published versions", () => {
  for (const [candidate, body] of [
    ["1.0.0", undefined],
    ["1.0.0", feed("1.0.0")],
    ["1.10.0", feed("1.9.100", "0.100.100")],
    ["2.0.0", feed("1.999.999")],
    ["9007199254740993.0.0", feed("9007199254740992.999.999")],
  ]) {
    const result = runGuard(candidate, body);
    equal(result.status, 0, result.stderr);
  }
});

test("rejects any newer published version, regardless of feed order or component size", () => {
  for (const [candidate, body] of [
    ["1.9.0", feed("1.8.0", "1.10.0")],
    ["1.0.0", feed("1.0.1")],
    ["9007199254740992.0.0", feed("9007199254740993.0.0")],
  ]) {
    const result = runGuard(candidate, body);
    notEqual(result.status, 0, `accepted downgrade to ${candidate}`);
  }
});

test("rejects missing, prerelease, and noncanonical candidate versions before first publication", () => {
  for (const candidate of [undefined, "", "1.0", "01.0.0", "1.0.0-beta.1", "1.0.0+build", "1.0.0.0"]) {
    const result = runGuard(candidate);
    notEqual(result.status, 0, `accepted invalid version ${candidate}`);
  }
});

test("rejects malformed existing manifests and invalid published versions", () => {
  for (const body of [
    "not json",
    "null",
    "{}",
    JSON.stringify({ addons: { [addonID]: {} } }),
    JSON.stringify({ addons: { [addonID]: { updates: {} } } }),
    JSON.stringify({ addons: { [addonID]: { updates: [] } } }),
    JSON.stringify({ addons: { [addonID]: { updates: [{}] } } }),
    JSON.stringify({ addons: { [addonID]: { updates: [null] } } }),
    feed("1.0.0-beta.1"),
    feed("1.0.0", "2.0"),
  ]) {
    const result = runGuard("2.0.0", body);
    notEqual(result.status, 0, `accepted invalid manifest ${body}`);
  }
});

test("tag guard accepts only a matching push tag or a manual dispatch", (t) => {
  const fixture = tagFixture(t);
  for (const [event, ref, expected] of [
    ["push", "refs/tags/v1.0.0", 0],
    ["push", "refs/tags/v0.9.0", 1],
    ["push", "refs/tags/v01.0.0", 1],
    ["push", "refs/tags/v1.0.0-beta.1", 1],
    ["push", "refs/tags/v1.0.0+build", 1],
    ["push", "refs/heads/main", 1],
    ["workflow_dispatch", "refs/heads/main", 0],
    ["workflow_dispatch", "refs/tags/v1.0.0", 0],
    ["pull_request", "refs/heads/main", 1],
    ["", "", 1],
  ]) {
    const result = fixture.run({ GITHUB_EVENT_NAME: event, GITHUB_REF: ref });
    equal(result.status, expected, `${event} ${ref}: ${result.stderr}`);
  }
});

test("release step checks the existing feed and only accepts a 404 for initial publication", () => {
  for (const [description, input, expected, called] of [
    ["equal published version", { body: feed("1.0.0") }, 0, true],
    ["older published version", { body: feed("0.9.0") }, 0, true],
    ["newer published version", { body: feed("1.0.1") }, 1, true],
    ["malformed manifest", { body: "not json" }, 1, true],
    ["missing manifest", { status: "404" }, 0, true],
    ["prerelease with missing manifest", { version: "1.0.0-beta.1", status: "404" }, 1, false],
    ["server error", { status: "500" }, 1, true],
    ["redirect without location", { status: "302" }, 1, true],
    ["network failure", { status: "000", exit: "7" }, 1, true],
    ["404 plus network failure", { status: "404", exit: "7" }, 1, true],
  ]) {
    const outcome = runWorkflow(input);
    equal(outcome.result.status, expected, `${description}: ${outcome.result.stderr}`);
    equal(outcome.called, called, `${description}: unexpected download behavior`);
  }
});
