/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { formatByteSize, formatSavedPercent } from "./file-size.ts";

export const COMPRESS_STAGES = [
  "Preparing",
  "Backing up",
  "Inspecting input",
  "Compressing",
  "Validating",
  "Replacing",
] as const;

export type CompressStage = (typeof COMPRESS_STAGES)[number];
export type RunState = "processing" | "cancel-requested" | "finished";
export type Phase =
  | { kind: "waiting" }
  | { kind: "running"; stage: CompressStage; before: number | null }
  | { kind: "done"; result: RowResult };
export type RowResult =
  | { kind: "installed"; before: number; after: number }
  | { kind: "rejected"; before: number; after: number }
  | { kind: "blocked"; before: number | null }
  | { kind: "reverted"; before: number; after: number };

export type RowIcon = "none" | "tick" | "cross";

export interface ProjectedRow {
  icon: RowIcon;
  file: string;
  before: string;
  after: string;
  saved: string;
}

export interface OutcomeSizes {
  code: string;
  changed: boolean | null;
  beforeBytes: number | null;
  producedBytes: number | null;
}

export function compressedHeadline(installed: number): string {
  return installed === 1 ? "1 PDF compressed" : `${installed} PDFs compressed`;
}

export function runHeadline(run: RunState, installed: number): string {
  return run === "finished" ? compressedHeadline(installed) : "Processing";
}

export function runButton(run: RunState): "cancel" | "close" {
  return run === "finished" ? "close" : "cancel";
}

export function barValue(rows: readonly { phase: Phase }[], run: RunState): number {
  if (run === "finished" || rows.length === 0) return 100;
  if (rows.length === 1) {
    const phase = rows[0].phase;
    if (phase.kind === "waiting") return 0;
    if (phase.kind === "done") return 100;
    const index = COMPRESS_STAGES.indexOf(phase.stage);
    if (index < 0) return 0;
    return Math.round((index / (COMPRESS_STAGES.length - 1)) * 100);
  }
  const doneCount = rows.filter((row) => row.phase.kind === "done").length;
  return Math.round((100 * doneCount) / rows.length);
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
  return { kind: "blocked", before: typeof before === "number" ? before : null };
}

export function canRevert(phase: Phase, hasBackup: boolean): boolean {
  return hasBackup && phase.kind === "done" && phase.result.kind !== "reverted";
}

function sized(bytes: number | null): string {
  return typeof bytes === "number" ? formatByteSize(bytes) : "";
}

export function projectRow(filename: string, phase: Phase): ProjectedRow {
  if (phase.kind === "waiting") {
    return { icon: "none", file: filename, before: "", after: "", saved: "" };
  }
  if (phase.kind === "running") {
    return { icon: "none", file: filename, before: sized(phase.before), after: "", saved: "" };
  }
  const result = phase.result;
  if (result.kind === "installed" || result.kind === "rejected") {
    return {
      icon: result.kind === "installed" ? "tick" : "cross",
      file: filename,
      before: formatByteSize(result.before),
      after: formatByteSize(result.after),
      saved: formatSavedPercent(result.before, result.after),
    };
  }
  if (result.kind === "blocked") {
    return { icon: "cross", file: filename, before: sized(result.before), after: "", saved: "" };
  }
  return {
    icon: "none",
    file: filename,
    before: formatByteSize(result.before),
    after: formatByteSize(result.after),
    saved: "",
  };
}
