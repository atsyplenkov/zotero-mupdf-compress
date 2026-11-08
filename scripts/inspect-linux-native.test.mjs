/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { deepEqual, equal, match } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const inspector = fileURLToPath(new URL("./inspect-linux-native.py", import.meta.url));

test("ELF inspection reports x86-64 executables and their measured dependencies", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mupdf-elf-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "program.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  for (const name of ["mutool", "session-lock"]) {
    execFileSync("cc", [source, "-o", join(directory, name)]);
  }
  const result = spawnSync("python3", [inspector, directory], { encoding: "utf8" });
  equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout);
  deepEqual(files.map((file) => file.name), ["mutool", "session-lock"]);
  for (const file of files) {
    deepEqual(file.needed, ["libc.so.6"]);
    equal(file.interpreter, "/lib64/ld-linux-x86-64.so.2");
    match(file.glibcMax, /^2\.(?:[0-9]|[12][0-9]|3[0-5])(?:\.[0-9]+)?$/);
  }
});

test("ELF inspection rejects an embedded library search path", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mupdf-elf-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "program.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  execFileSync("cc", [source, "-Wl,-rpath,/tmp", "-o", join(directory, "mutool")]);
  const result = spawnSync("python3", [inspector, directory], { encoding: "utf8" });
  equal(result.status, 1, result.stderr);
  match(result.stderr, /library search path/);
});

test("ELF inspection rejects a program requiring a newer GLIBC than the 2.35 target", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mupdf-elf-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "newer.c");
  writeFileSync(source, `
    extern long newer(const char *, char **, int);
    __asm__(".symver newer,__isoc23_strtol@GLIBC_2.38");
    int main(int argc, char **argv) { return (int)newer(argv[0], 0, argc); }
  `);
  execFileSync("cc", [source, "-o", join(directory, "mutool")]);
  execFileSync("cc", [source, "-o", join(directory, "session-lock")]);
  const result = spawnSync("python3", [inspector, directory], { encoding: "utf8" });
  equal(result.status, 1, result.stderr);
  match(result.stderr, /GLIBC_2\.38/);
});
