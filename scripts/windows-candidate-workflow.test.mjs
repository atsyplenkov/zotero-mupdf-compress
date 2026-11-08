/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { doesNotMatch, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/windows-candidate.yml", import.meta.url), "utf8");

test("Windows PR verification tests the extracted XPI without publication permission", () => {
  match(workflow, /^  pull_request:/m);
  match(workflow, /^  contents: read$/m);
  match(workflow, /^    runs-on: windows-2022$/m);
  doesNotMatch(workflow, /contents: write|secrets\.|publish-release|release upload/);
  const build = workflow.indexOf("      - name: Build Windows native programs");
  const candidate = workflow.indexOf("      - name: Build and inspect the candidate XPI");
  const nativeTests = workflow.indexOf("      - name: Test extracted candidate programs and host adapters");
  const upload = workflow.indexOf("      - name: Upload the tested candidate");
  ok(build >= 0 && build < candidate && candidate < nativeTests && nativeTests < upload);
  match(workflow, /--platform windows-x86_64/);
  match(workflow, /inspect-windows-native\.py.+--candidate/);
  match(workflow, /MUPDF_NATIVE_DIR/);
  match(workflow, /MUPDF_NATIVE_MANIFEST/);
  match(workflow, /MUPDF_WINDOWS_TEST_HOST.+mupdf-windows-native\/windows-test-host\.exe/);
  const recipe = readFileSync(new URL("../addon/native/build-windows.ps1", import.meta.url), "utf8");
  match(recipe, /Join-Path \$work 'windows-test-host\.exe'/);
  match(recipe, /\/DMUPDF_TEST_HOST/);
  for (const name of ["engine", "session-lock", "session", "native-extraction", "files"]) {
    ok(workflow.includes(`src/${name}.test.ts`), name);
  }
});
