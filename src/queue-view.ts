/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { formatChangePercent } from "./file-size.ts";
import type { Action, Outcome } from "./types.ts";

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
  | { kind: "recoverable"; before: number; after: number; message: string }
  | { kind: "unverified"; before: number | null; message: string }
  | { kind: "blocked"; before: number | null; code: string };

function counted(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

function withRecovery(completed: string, awaitingRecovery: number, singular: string, plural: string): string {
  if (awaitingRecovery === 0) return completed;
  return `${completed}, ${counted(awaitingRecovery, singular, plural)}`;
}

export function compressedHeadline(installed: number, awaitingRecovery = 0): string {
  return withRecovery(
    counted(installed, "PDF compressed", "PDFs compressed"),
    awaitingRecovery,
    "replacement awaiting recovery",
    "replacements awaiting recovery",
  );
}

export function revertedHeadline(installed: number, awaitingRecovery = 0): string {
  return withRecovery(
    counted(installed, "PDF reverted", "PDFs reverted"),
    awaitingRecovery,
    "restoration awaiting recovery",
    "restorations awaiting recovery",
  );
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
  "revert-changed": "File changed",
  validation: "Not validated",
  backup: "Backup failed",
  "backup-invalid": "Backup unavailable",
  "no-record": "No session backup",
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
  unresolved: "Unverified backup kept",
  engine: "Engine failed",
  "engine-unavailable": "Engine failed",
  "engine-exit": "Engine failed",
  "engine-output-limit": "Engine failed",
  uncertain: "Unverified",
  "replacement-unchanged": "Not replaced",
  "temporary-folder": "Temporary folder",
  failure: "Failed",
};

export function queueMessage(phase: Phase, action: Action = "Compress"): string {
  if (phase.kind !== "done") return "";
  const result = phase.result;
  if (result.kind === "installed" || result.kind === "rejected" || result.kind === "recoverable") {
    // Revert compares both files with the original PDF, matching Compression's percent.
    const base = action === "Revert" ? result.after : result.before;
    const percent = formatChangePercent(result.before, result.after, base);
    if (result.kind === "recoverable") return `${percent} ${result.message}`;
    return percent;
  }
  if (result.kind === "unverified") return result.message;
  return FAILURE_REASONS[result.code] ?? "Failed";
}

export function resultFromOutcome(outcome: Outcome): RowResult {
  switch (outcome.code) {
    case "success":
      return { kind: "installed", before: outcome.beforeBytes, after: outcome.producedBytes };
    case "no-benefit":
      return { kind: "rejected", before: outcome.beforeBytes, after: outcome.producedBytes };
    case "partial":
      return {
        kind: "recoverable",
        before: outcome.beforeBytes,
        after: outcome.producedBytes,
        message: outcome.message,
      };
    case "uncertain":
      return { kind: "unverified", before: outcome.beforeBytes, message: outcome.message };
    default:
      return { kind: "blocked", before: outcome.beforeBytes, code: outcome.code };
  }
}
