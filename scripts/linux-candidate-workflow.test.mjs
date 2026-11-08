/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { doesNotMatch, match, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/linux-candidate.yml", import.meta.url), "utf8");

test("Linux pull requests build and test the candidate before read-only artifact upload", () => {
  match(workflow, /^  pull_request:/m);
  match(workflow, /^  contents: read$/m);
  match(workflow, /^    runs-on: ubuntu-24\.04$/m);
  doesNotMatch(workflow, /contents: write|secrets\.|publish-release|release upload/);
  const build = workflow.indexOf("      - name: Build Linux native programs");
  const checks = workflow.indexOf("      - name: Run project checks");
  const packageCandidate = workflow.indexOf("      - name: Build and inspect the candidate XPI");
  const baseline = workflow.indexOf("      - name: Test the candidate in Ubuntu 22.04");
  const newer = workflow.indexOf("      - name: Test the candidate in Ubuntu 24.04");
  const upload = workflow.indexOf("      - name: Upload the tested candidate");
  ok(build >= 0 && build < checks && checks < packageCandidate && packageCandidate < baseline &&
    baseline < newer && newer < upload);
  match(workflow, /make test/);
  match(workflow, /make build/);
  match(workflow, /extract-linux-candidate\.py/);
  match(workflow, /run-linux-candidate-tests\.sh/);
  const runner = readFileSync(new URL("./run-linux-candidate-tests.sh", import.meta.url), "utf8");
  match(runner, /MUPDF_NATIVE_DIR=\/candidate-native/);
  match(runner, /src\/engine\.test\.ts src\/session-lock\.test\.ts src\/session\.test\.ts/);
});
