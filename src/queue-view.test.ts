/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal } from "node:assert/strict";
import { test } from "node:test";
import {
  type CompressStage,
  type Phase,
  barValue,
  canRevert,
  compressedHeadline,
  projectRow,
  resultFromOutcome,
  runButton,
  runHeadline,
} from "./queue-view.ts";

const original = 13266359;
const smaller = 3131680;
const larger = 14300000;

test("compressed headline counts installed PDFs", () => {
  equal(compressedHeadline(1), "1 PDF compressed");
  equal(compressedHeadline(0), "0 PDFs compressed");
  equal(compressedHeadline(2), "2 PDFs compressed");
});

test("unfinished runs say Processing and offer cancel", () => {
  equal(runHeadline("processing", 3), "Processing");
  equal(runHeadline("cancel-requested", 3), "Processing");
  equal(runButton("processing"), "cancel");
  equal(runButton("cancel-requested"), "cancel");
  equal(runHeadline("finished", 1), "1 PDF compressed");
  equal(runHeadline("finished", 0), "0 PDFs compressed");
  equal(runButton("finished"), "close");
});

test("bar follows one row's stage and several rows' done count", () => {
  const waiting: Phase = { kind: "waiting" };
  const replacing: Phase = { kind: "running", stage: "Replacing", before: original };
  const preparing: Phase = { kind: "running", stage: "Preparing", before: null };
  const done: Phase = { kind: "done", result: { kind: "blocked", before: null } };
  equal(barValue([], "processing"), 100);
  equal(barValue([{ phase: waiting }], "finished"), 100);
  equal(barValue([{ phase: waiting }], "processing"), 0);
  equal(barValue([{ phase: preparing }], "processing"), 0);
  equal(barValue([{ phase: replacing }], "processing"), 100);
  equal(barValue([{ phase: { kind: "running", stage: "Nope" as CompressStage, before: null } }], "processing"), 0);
  equal(barValue([{ phase: done }], "processing"), 100);
  equal(
    barValue(
      [
        { phase: done },
        { phase: replacing },
      ],
      "processing",
    ),
    50,
  );
  equal(
    barValue(
      [
        { phase: done },
        { phase: waiting },
        { phase: waiting },
      ],
      "cancel-requested",
    ),
    33,
  );
});

test("projectRow renders the locked size examples", () => {
  const installed = projectRow("paper.pdf", {
    kind: "done",
    result: { kind: "installed", before: original, after: smaller },
  });
  equal(installed.icon, "tick");
  equal(installed.file, "paper.pdf");
  equal(installed.before, "13.3 MB");
  equal(installed.after, "3.1 MB");
  equal(installed.saved, "76.4%");

  const rejected = projectRow("paper.pdf", {
    kind: "done",
    result: { kind: "rejected", before: original, after: larger },
  });
  equal(rejected.icon, "cross");
  equal(rejected.before, "13.3 MB");
  equal(rejected.after, "14.3 MB");
  equal(rejected.saved, "-7.8%");

  const equalSizes = projectRow("paper.pdf", {
    kind: "done",
    result: { kind: "rejected", before: original, after: original },
  });
  equal(equalSizes.icon, "cross");
  equal(equalSizes.saved, "0.0%");
});

test("projectRow keeps empty cells until a PDF is produced", () => {
  equal(projectRow("notes.pdf", { kind: "waiting" }).icon, "none");
  equal(projectRow("notes.pdf", { kind: "waiting" }).before, "");
  equal(projectRow("notes.pdf", { kind: "waiting" }).after, "");
  equal(projectRow("notes.pdf", { kind: "waiting" }).saved, "");

  const running = projectRow("notes.pdf", { kind: "running", stage: "Compressing", before: original });
  equal(running.icon, "none");
  equal(running.before, "13.3 MB");
  equal(running.after, "");
  equal(running.saved, "");

  const unknownBefore = projectRow("notes.pdf", { kind: "running", stage: "Preparing", before: null });
  equal(unknownBefore.before, "");

  const blocked = projectRow("notes.pdf", { kind: "done", result: { kind: "blocked", before: original } });
  equal(blocked.icon, "cross");
  equal(blocked.before, "13.3 MB");
  equal(blocked.after, "");
  equal(blocked.saved, "");

  const blockedUnknown = projectRow("notes.pdf", { kind: "done", result: { kind: "blocked", before: null } });
  equal(blockedUnknown.before, "");

  const reverted = projectRow("notes.pdf", {
    kind: "done",
    result: { kind: "reverted", before: smaller, after: original },
  });
  equal(reverted.icon, "none");
  equal(reverted.before, "3.1 MB");
  equal(reverted.after, "13.3 MB");
  equal(reverted.saved, "");
});

test("resultFromOutcome keeps installed, rejected, and blocked apart", () => {
  equal(
    resultFromOutcome({ code: "success", changed: true, beforeBytes: original, producedBytes: smaller }).kind,
    "installed",
  );
  equal(
    resultFromOutcome({ code: "no-benefit", changed: false, beforeBytes: original, producedBytes: larger }).kind,
    "rejected",
  );
  const blocked = resultFromOutcome({ code: "repeated", changed: false, beforeBytes: original, producedBytes: null });
  equal(blocked.kind, "blocked");
  if (blocked.kind === "blocked") equal(blocked.before, original);
  const missing = resultFromOutcome({ code: "success", changed: true, beforeBytes: null, producedBytes: null });
  equal(missing.kind, "blocked");
});

test("canRevert follows the backup and a finished row that is not reverted", () => {
  const installed: Phase = { kind: "done", result: { kind: "installed", before: original, after: smaller } };
  const reverted: Phase = { kind: "done", result: { kind: "reverted", before: smaller, after: original } };
  const waiting: Phase = { kind: "waiting" };
  equal(canRevert(installed, true), true);
  equal(canRevert(installed, false), false);
  equal(canRevert(reverted, true), false);
  equal(canRevert(waiting, true), false);
});
