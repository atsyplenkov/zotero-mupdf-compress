/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { queueMessage, queueStatus, type Phase, type RunState } from "./queue-view.ts";
import type { Action } from "./types.ts";

export interface LedgerRow {
  itemID: number;
  libraryID: number;
  key: string;
  filename: string;
  phase: Phase;
  listed: boolean;
}

export interface Ledger {
  action: Action;
  run: RunState;
  rows: LedgerRow[];
  closedByQueue: boolean;
}

export interface RowSink {
  update(itemID: number, status: number, message: string): void;
}

export function presentStored(row: LedgerRow, action: Action, sink: RowSink): void {
  try {
    sink.update(row.itemID, queueStatus(row.phase), queueMessage(row.phase, action));
  } catch {
    return;
  }
}

export function markMissing(row: LedgerRow): LedgerRow {
  return {
    ...row,
    phase: { kind: "done", result: { kind: "blocked", before: null, code: "missing" } },
  };
}

export function beginDecision(input: {
  pumpRunning: boolean;
  dialogOpen: boolean;
  ledger: { run: RunState } | null;
}): "join" | "restart" | "replace" {
  if (input.pumpRunning) return "join";
  if (input.ledger && (input.ledger.run === "processing" || input.ledger.run === "cancel-requested")) return "restart";
  if (input.dialogOpen && input.ledger) return "join";
  return "replace";
}

export async function drainLedger(
  ledger: Ledger,
  runOne: (row: LedgerRow) => Promise<void>,
  sink: RowSink,
): Promise<void> {
  while (ledger.run === "processing") {
    const next = ledger.rows.find((row) => row.phase.kind === "waiting");
    if (!next) break;
    next.phase = { kind: "running" };
    presentStored(next, ledger.action, sink);
    try {
      await runOne(next);
    } catch {
      next.phase = { kind: "done", result: { kind: "blocked", before: null, code: "failure" } };
    }
    presentStored(next, ledger.action, sink);
  }
}
