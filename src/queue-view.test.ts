/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal } from "node:assert/strict";
import { test } from "node:test";
import { formatChangePercent } from "./file-size.ts";
import {
  QUEUE_COLUMNS,
  QUEUE_TITLE,
  ROW_FAILED,
  ROW_PROCESSING,
  ROW_QUEUED,
  ROW_SUCCEEDED,
  type Phase,
  compressedHeadline,
  queueMessage,
  queueStatus,
  resultFromOutcome,
  revertedHeadline,
} from "./queue-view.ts";
import { RECOVERY_SENTENCE, type Outcome } from "./types.ts";

function sized(code: "success" | "no-benefit" | "partial", changed: boolean, before: number, after: number, message: string): Outcome {
  if (code === "partial") {
    return { code, changed, message: RECOVERY_SENTENCE.replacedIncomplete, stage: "Replacing", beforeBytes: before, producedBytes: after };
  }
  if (code === "no-benefit") {
    return { code, changed: false, message, stage: "Validating", beforeBytes: before, producedBytes: after };
  }
  return { code, changed, message, stage: "Replacing", beforeBytes: before, producedBytes: after };
}

const original = 13266359;
const smaller = 3131680;
const larger = 14300000;

test("the progress dialog title and columns are Zotero strings", () => {
  equal(QUEUE_TITLE, "general.processing");
  equal(QUEUE_COLUMNS[0], "pane.item.attachments.filename");
  equal(QUEUE_COLUMNS[1], "pdfReader.size");
});

test("compressed headline counts installed PDFs", () => {
  equal(compressedHeadline(1), "1 PDF compressed");
  equal(compressedHeadline(0), "0 PDFs compressed");
  equal(compressedHeadline(2), "2 PDFs compressed");
});

test("reverted headline counts installed PDFs", () => {
  equal(revertedHeadline(0), "0 PDFs reverted");
  equal(revertedHeadline(1), "1 PDF reverted");
  equal(revertedHeadline(2), "2 PDFs reverted");
});

test("a headline names replacements that still need recovery", () => {
  equal(compressedHeadline(0, 1), "0 PDFs compressed, 1 replacement awaiting recovery");
  equal(compressedHeadline(1, 1), "1 PDF compressed, 1 replacement awaiting recovery");
  equal(compressedHeadline(2, 3), "2 PDFs compressed, 3 replacements awaiting recovery");
  equal(revertedHeadline(0, 1), "0 PDFs reverted, 1 restoration awaiting recovery");
  equal(revertedHeadline(2, 2), "2 PDFs reverted, 2 restorations awaiting recovery");
});

test("a row shows the saved percent only after Compression produces a PDF", () => {
  const waiting: Phase = { kind: "waiting" };
  equal(queueStatus(waiting), ROW_QUEUED);
  equal(queueMessage(waiting), "");

  const running: Phase = { kind: "running" };
  equal(queueStatus(running), ROW_PROCESSING);
  equal(queueMessage(running), "");

  const installed: Phase = { kind: "done", result: { kind: "installed", before: original, after: smaller } };
  equal(queueStatus(installed), ROW_SUCCEEDED);
  equal(queueMessage(installed), "-76.4%");

  const rejected: Phase = { kind: "done", result: { kind: "rejected", before: original, after: larger } };
  equal(queueStatus(rejected), ROW_FAILED);
  equal(queueMessage(rejected), "+7.8%");

  const restored: Phase = { kind: "done", result: { kind: "installed", before: 18000, after: 100000 } };
  equal(queueStatus(restored), ROW_SUCCEEDED);
  equal(queueMessage(restored, "Revert"), "+82.0%");
  equal(formatChangePercent(100000, 18000), "-82.0%");

  const smallSaving: Phase = { kind: "done", result: { kind: "installed", before: 85200, after: 100000 } };
  equal(queueMessage(smallSaving, "Revert"), "+14.8%");
  equal(formatChangePercent(100000, 85200), "-14.8%");

  const sameSize: Phase = { kind: "done", result: { kind: "rejected", before: original, after: original } };
  equal(queueStatus(sameSize), ROW_FAILED);
  equal(queueMessage(sameSize), "0.0%");

  const blocked: Phase = { kind: "done", result: { kind: "blocked", before: original, code: "repeated" } };
  equal(queueStatus(blocked), ROW_FAILED);
  equal(queueMessage(blocked), "Already compressed");

  const open: Phase = { kind: "done", result: { kind: "blocked", before: null, code: "open" } };
  equal(queueMessage(open), "Open in reader");

  const unknown: Phase = { kind: "done", result: { kind: "blocked", before: null, code: "other" } };
  equal(queueMessage(unknown), "Failed");

  const revertChanged: Phase = { kind: "done", result: { kind: "blocked", before: original, code: "revert-changed" } };
  equal(queueMessage(revertChanged), "File changed");

  const noRecord: Phase = { kind: "done", result: { kind: "blocked", before: null, code: "no-record" } };
  equal(queueMessage(noRecord), "No session backup");
});

test("resultFromOutcome keeps installed, rejected, and blocked apart", () => {
  equal(resultFromOutcome(sized("success", true, original, smaller, "done")).kind, "installed");
  equal(resultFromOutcome(sized("success", false, original, larger, "done")).kind, "installed");
  equal(resultFromOutcome(sized("no-benefit", false, original, larger, "same")).kind, "rejected");
  const blocked = resultFromOutcome({
    code: "repeated",
    changed: false,
    message: "already",
    stage: "Preparing",
    beforeBytes: original,
    producedBytes: null,
  });
  equal(blocked.kind, "blocked");
  if (blocked.kind === "blocked") {
    equal(blocked.before, original);
    equal(blocked.code, "repeated");
  }
});

test("a replaced PDF with recovery left is not shown as Failed", () => {
  const recovered = resultFromOutcome({
    code: "partial",
    changed: true,
    message: RECOVERY_SENTENCE.replacedIncomplete,
    stage: "Replacing",
    beforeBytes: 100000,
    producedBytes: 18000,
  });
  equal(recovered.kind, "recoverable");
  if (recovered.kind !== "recoverable") return;
  equal(recovered.before, 100000);
  equal(recovered.after, 18000);
  const shown = queueMessage({ kind: "done", result: recovered }, "Compress");
  equal(shown.includes("-82.0%"), true);
  equal(shown.includes(RECOVERY_SENTENCE.replacedIncomplete), true);
  equal(shown.includes("Failed"), false);
  equal(queueStatus({ kind: "done", result: recovered }), ROW_FAILED);

  const restored = queueMessage({ kind: "done", result: { ...recovered, before: 18000, after: 100000 } }, "Revert");
  equal(restored.startsWith("+82.0%"), true);
});

test("an unverified replacement names the backup instead of a produced size", () => {
  const unverified = resultFromOutcome({
    code: "uncertain",
    changed: null,
    message: RECOVERY_SENTENCE.unverified,
    stage: "Replacing",
    beforeBytes: 100000,
    producedBytes: null,
  });
  equal(unverified.kind, "unverified");
  equal(queueMessage({ kind: "done", result: unverified }), RECOVERY_SENTENCE.unverified);
});
