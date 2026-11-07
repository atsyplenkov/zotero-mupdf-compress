/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal } from "node:assert/strict";
import { test } from "node:test";
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
} from "./queue-view.ts";

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
  if (blocked.kind === "blocked") {
    equal(blocked.before, original);
    equal(blocked.code, "repeated");
  }
  const missing = resultFromOutcome({ code: "success", changed: true, beforeBytes: null, producedBytes: null });
  equal(missing.kind, "blocked");
});
