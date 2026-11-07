/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { formatChangePercent } from "./file-size.ts";

/** Title and column keys are existing Zotero strings. The dialog looks them up with Zotero.getString. */
export const QUEUE_TITLE = "general.processing";
export const QUEUE_COLUMNS = ["pane.item.attachments.filename", "pdfReader.size"] as const;

export const ROW_QUEUED = 1;
export const ROW_PROCESSING = 2;
export const ROW_FAILED = 3;
export const ROW_SUCCEEDED = 4;

export type RunState = "processing" | "cancel-requested" | "finished";
export type Phase = { kind: "waiting" } | { kind: "running" } | { kind: "done"; result: RowResult };
export type RowResult =
  | { kind: "installed"; before: number; after: number }
  | { kind: "rejected"; before: number; after: number }
  | { kind: "blocked"; before: number | null; code: string };

export interface OutcomeSizes {
  code: string;
  changed: boolean | null;
  beforeBytes: number | null;
  producedBytes: number | null;
}

export function compressedHeadline(installed: number): string {
  return installed === 1 ? "1 PDF compressed" : `${installed} PDFs compressed`;
}

export function queueStatus(phase: Phase): number {
  if (phase.kind === "waiting") return ROW_QUEUED;
  if (phase.kind === "running") return ROW_PROCESSING;
  if (phase.result.kind === "installed") return ROW_SUCCEEDED;
  return ROW_FAILED;
}

const FAILURE_REASONS: Record<string, string> = {
  open: "Open in reader",
  missing: "File not found",
  encrypted: "Encrypted",
  unreadable: "Unreadable",
  "compress-changed": "File changed",
  validation: "Not validated",
  backup: "Backup failed",
  "backup-invalid": "Backup unavailable",
  "reader-check-unavailable": "Reader check failed",
  "lock-unavailable": "Session busy",
  "unsafe-path": "Unsafe path",
  "symlink-path": "Unsafe path",
  "missing-path": "Unsafe path",
  ineligible: "Not a stored PDF",
  stopped: "Shutting down",
  busy: "Already running",
  "alias-busy": "File in use",
  "alias-compressed": "File already compressed",
  repeated: "Already compressed",
  engine: "Engine failed",
  "engine-unavailable": "Engine failed",
  "engine-exit": "Engine failed",
  "engine-output-limit": "Engine failed",
  uncertain: "Unverified",
  "replacement-unchanged": "Not replaced",
  "temporary-folder": "Temporary folder",
  failure: "Failed",
};

export function queueMessage(phase: Phase): string {
  if (phase.kind !== "done") return "";
  const result = phase.result;
  if (result.kind === "installed" || result.kind === "rejected") {
    return formatChangePercent(result.before, result.after);
  }
  return FAILURE_REASONS[result.code] ?? "Failed";
}

export function resultFromOutcome(outcome: OutcomeSizes): RowResult {
  const before = outcome.beforeBytes;
  const after = outcome.producedBytes;
  if (outcome.changed === true && typeof before === "number" && typeof after === "number") {
    return { kind: "installed", before, after };
  }
  if (outcome.code === "no-benefit" && typeof before === "number" && typeof after === "number") {
    return { kind: "rejected", before, after };
  }
  return { kind: "blocked", before: typeof before === "number" ? before : null, code: outcome.code };
}
