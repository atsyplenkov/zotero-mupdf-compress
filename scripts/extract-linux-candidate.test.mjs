/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal, match } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extractor = fileURLToPath(new URL("./extract-linux-candidate.py", import.meta.url));

function fixture(t, alter = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "mupdf-candidate-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "package");
  const native = join(root, "native", "linux-x86_64");
  mkdirSync(native, { recursive: true });
  const components = {
    schemaVersion: 1,
    platforms: {
      "linux-x86_64": {
        os: "Linux",
        abi: "x86_64-gcc3",
        artifact: "0e48ce3ee872bdd981c7813cd3ed9a46b4fc4ebc9a411a8bea838e5a3b83ebbb",
        files: [
          { name: "mutool", path: "linux-x86_64/mutool", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", executable: true },
          { name: "session-lock", path: "linux-x86_64/session-lock", sha256: "cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34", executable: true },
        ],
      },
    },
  };
  writeFileSync(join(native, "mutool"), "abc");
  writeFileSync(join(native, "session-lock"), "def");
  alter({ components, native, root });
  writeFileSync(join(root, "native", "components.json"), JSON.stringify(components));
  const archive = join(directory, "candidate.xpi");
  execFileSync("zip", ["-qr", archive, "native"], { cwd: root });
  return { archive, destination: join(directory, "extracted") };
}

test("the candidate extractor writes the verified Linux executables from the XPI", (t) => {
  const { archive, destination } = fixture(t);
  const result = spawnSync("python3", [extractor, archive, destination], { encoding: "utf8" });
  equal(result.status, 0, result.stderr);
  equal(readFileSync(join(destination, "mutool"), "utf8"), "abc");
  equal(readFileSync(join(destination, "session-lock"), "utf8"), "def");
});

test("the candidate extractor refuses an incorrect platform artifact identity", (t) => {
  const { archive, destination } = fixture(t, ({ components }) => {
    components.platforms["linux-x86_64"].artifact = "a".repeat(64);
  });
  const result = spawnSync("python3", [extractor, archive, destination], { encoding: "utf8" });
  equal(result.status, 1, result.stderr);
  equal(existsSync(destination), false);
});

test("the candidate extractor refuses an altered executable", (t) => {
  const { archive, destination } = fixture(t, ({ native }) => {
    writeFileSync(join(native, "mutool"), "altered");
  });
  const result = spawnSync("python3", [extractor, archive, destination], { encoding: "utf8" });
  equal(result.status, 1, result.stderr);
  match(result.stderr, /digest mismatch/);
  equal(existsSync(destination), false);
});

test("the candidate extractor refuses an absent executable", (t) => {
  const { archive, destination } = fixture(t, ({ native }) => {
    rmSync(join(native, "session-lock"));
  });
  const result = spawnSync("python3", [extractor, archive, destination], { encoding: "utf8" });
  equal(result.status, 1, result.stderr);
  equal(existsSync(destination), false);
});

test("the candidate extractor verifies declared runtime files too", (t) => {
  const { archive, destination } = fixture(t, ({ components, native }) => {
    const platform = components.platforms["linux-x86_64"];
    platform.files.push({ name: "runtime.dat", path: "linux-x86_64/runtime.dat", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", executable: false });
    platform.artifact = createHash("sha256").update(JSON.stringify(platform.files)).digest("hex");
    writeFileSync(join(native, "runtime.dat"), "altered");
  });
  const result = spawnSync("python3", [extractor, archive, destination], { encoding: "utf8" });
  equal(result.status, 1, result.stderr);
  match(result.stderr, /digest mismatch/);
  equal(existsSync(destination), false);
});

test("the candidate extractor refuses a missing declared runtime file", (t) => {
  const { archive, destination } = fixture(t, ({ components }) => {
    const platform = components.platforms["linux-x86_64"];
    platform.files.push({ name: "runtime.dat", path: "linux-x86_64/runtime.dat", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", executable: false });
    platform.artifact = createHash("sha256").update(JSON.stringify(platform.files)).digest("hex");
  });
  const result = spawnSync("python3", [extractor, archive, destination], { encoding: "utf8" });
  equal(result.status, 1, result.stderr);
  equal(existsSync(destination), false);
});

test("the candidate extractor refuses duplicate XPI entries", (t) => {
  const { archive, destination } = fixture(t);
  execFileSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1], 'a'); z.writestr('native/linux-x86_64/mutool', 'different'); z.close()", archive], { stdio: "ignore" });
  const result = spawnSync("python3", [extractor, archive, destination], { encoding: "utf8" });
  equal(result.status, 1, result.stderr);
  match(result.stderr, /duplicate/);
  equal(existsSync(destination), false);
});
