/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { log } from "./files";
import {
  beginDecision,
  drainLedger,
  markMissing,
  presentStored,
  type Ledger,
  type LedgerRow,
  type RowSink,
} from "./queue-ledger";
import {
  QUEUE_COLUMNS,
  QUEUE_TITLE,
  compressedHeadline,
  revertedHeadline,
  resultFromOutcome,
} from "./queue-view";
import { selectPdfs } from "./target";
import type { Action } from "./types";

interface ProgressQueueRow {
  id: number;
  fileName: string;
  status: number;
  message: string;
}

interface ProgressDialog {
  open(): void;
  close(): void;
  setStatus(message: string): void;
  showMinimizeButton(show: boolean): void;
  isOpen(): boolean;
}

interface ProgressQueueApi {
  addRow(item: Zotero.Item): void;
  updateRow(itemID: number, status: number, message: string): void;
  getRows(): ProgressQueueRow[];
  addListener(name: "cancel", callback: () => void): void;
  cancel(): void;
  getDialog(): ProgressDialog;
}

interface ProgressQueuesApi {
  get(id: string): ProgressQueueApi | undefined;
  create(options: { id: string; title: string; columns: readonly string[] }): ProgressQueueApi;
}

const QUEUE_ID = "mupdf-compress";

let ledger: Ledger | null = null;
let pumpTask: Promise<void> | null = null;
let progressQueue: ProgressQueueApi | null = null;
let suppressCancel = false;

function progressQueues(): ProgressQueuesApi | null {
  const host = Zotero as unknown as { ProgressQueues?: ProgressQueuesApi };
  return host.ProgressQueues ?? null;
}

function onQueueCancel(): void {
  if (suppressCancel || !ledger) return;
  if (ledger.run === "finished") {
    ledger = null;
    return;
  }
  ledger.closedByQueue = true;
  if (ledger.run === "processing") ledger.run = "cancel-requested";
}

function ensureQueue(): ProgressQueueApi | null {
  if (progressQueue) return progressQueue;
  const queues = progressQueues();
  if (!queues) return null;
  progressQueue = queues.get(QUEUE_ID) ?? queues.create({
    id: QUEUE_ID,
    title: QUEUE_TITLE,
    columns: QUEUE_COLUMNS,
  });
  progressQueue.addListener("cancel", onQueueCancel);
  return progressQueue;
}

function filenameOf(item: Zotero.Item): string {
  try {
    const name = item.attachmentFilename;
    if (typeof name === "string" && name.length > 0) return name;
  } catch {
    return "PDF";
  }
  return "PDF";
}

function refetch(row: LedgerRow): Zotero.Item | null {
  try {
    const item = Zotero.Items.get(row.itemID) || Zotero.Items.getByLibraryAndKey(row.libraryID, row.key);
    return item || null;
  } catch {
    return null;
  }
}

function dialogIsOpen(queue: ProgressQueueApi): boolean {
  try {
    return queue.getDialog().isOpen();
  } catch {
    return false;
  }
}

function rowSink(): RowSink {
  return {
    update(itemID, status, message) {
      if (!ledger || ledger.closedByQueue) return;
      const queue = ensureQueue();
      if (!queue) return;
      const row = ledger.rows.find((entry) => entry.itemID === itemID);
      if (!row) return;
      let hostRow = queue.getRows().find((entry) => entry.id === itemID);
      if (!hostRow) {
        const item = refetch(row);
        if (!item) return;
        queue.addRow(item);
        hostRow = queue.getRows().find((entry) => entry.id === itemID);
      }
      // addRow stores the item title. The dialog reads this same row object.
      if (hostRow) hostRow.fileName = row.filename;
      row.listed = true;
      queue.updateRow(itemID, status, message);
    },
  };
}

function countResult(rows: readonly LedgerRow[], kind: "installed" | "recoverable"): number {
  return rows.filter((row) => row.phase.kind === "done" && row.phase.result.kind === kind).length;
}

async function runOne(row: LedgerRow): Promise<void> {
  const operation = addon.operation;
  const item = refetch(row);
  if (!operation || !item) {
    row.phase = item
      ? { kind: "done", result: { kind: "blocked", before: null, code: "failure" } }
      : markMissing(row).phase;
    return;
  }
  const action = ledger?.action ?? "Compress";
  try {
    const outcome = action === "Revert" ? await operation.revert(item) : await operation.compress(item);
    row.phase = { kind: "done", result: resultFromOutcome(outcome) };
  } catch (error) {
    log("queue", action === "Revert" ? "revert-failed" : "compress-failed");
    throw error;
  }
}

function settle(current: Ledger): void {
  if (ledger !== current) return;
  if (current.closedByQueue) {
    ledger = null;
    return;
  }
  const sink = rowSink();
  for (const row of current.rows) {
    if (row.phase.kind !== "waiting") continue;
    row.phase = { kind: "done", result: { kind: "blocked", before: null, code: "stopped" } };
    presentStored(row, current.action, sink);
  }
  current.run = "finished";
  try {
    const headline = current.action === "Revert" ? revertedHeadline : compressedHeadline;
    const installed = countResult(current.rows, "installed");
    const awaitingRecovery = countResult(current.rows, "recoverable");
    ensureQueue()?.getDialog().setStatus(headline(installed, awaitingRecovery));
  } catch {
    log("queue", "status-failed");
  }
}

async function runPump(current: Ledger): Promise<void> {
  try {
    await drainLedger(current, runOne, rowSink());
  } finally {
    settle(current);
  }
}

function ensurePump(): void {
  if (pumpTask || !ledger) return;
  const current = ledger;
  pumpTask = runPump(current).catch((error: unknown) => {
    log("queue", error instanceof Error ? error.message : "pump-failed");
  }).finally(() => {
    pumpTask = null;
  });
}

function openDialog(queue: ProgressQueueApi): boolean {
  try {
    const dialog = queue.getDialog();
    dialog.showMinimizeButton(false);
    dialog.open();
    return true;
  } catch {
    log("queue", "show-failed");
    return false;
  }
}

function begin(action: Action, selected: Zotero.Item[]): void {
  if (!selected.length || !addon.operation) return;
  const queue = ensureQueue();
  if (!queue) {
    log("queue", "show-failed");
    return;
  }
  const decision = beginDecision({
    pumpRunning: pumpTask !== null,
    dialogOpen: dialogIsOpen(queue),
    ledger,
  });
  if (decision === "join") {
    openDialog(queue);
    return;
  }
  if (decision === "restart") {
    openDialog(queue);
    ensurePump();
    return;
  }
  if (ledger) {
    try {
      queue.cancel();
    } catch {
      log("queue", "close-failed");
    }
  }
  ledger = {
    action,
    run: "processing",
    closedByQueue: false,
    rows: selected.map((item) => ({
      itemID: item.id,
      libraryID: item.libraryID,
      key: item.key,
      filename: filenameOf(item),
      phase: { kind: "waiting" },
      listed: false,
    })),
  };
  try {
    queue.getDialog().setStatus("");
  } catch {
    log("queue", "status-failed");
  }
  for (const row of ledger.rows) presentStored(row, action, rowSink());
  if (!openDialog(queue)) {
    ledger = null;
    return;
  }
  ensurePump();
}

export function startCompress(items: Zotero.Item[] | null | undefined): void {
  begin("Compress", selectPdfs(items));
}

export function startRevert(items: Zotero.Item[] | null | undefined): void {
  begin("Revert", selectPdfs(items));
}

export function showQueueIfWorking(): void {
  if (!ledger || (ledger.run !== "processing" && ledger.run !== "cancel-requested")) return;
  const queue = ensureQueue();
  if (!queue) return;
  for (const row of ledger.rows) presentStored(row, ledger.action, rowSink());
  openDialog(queue);
}

export function dismissQueueDialog(): void {
  suppressCancel = true;
  try {
    const dialog = progressQueue?.getDialog();
    if (dialog?.isOpen()) dialog.close();
  } catch {
    log("queue", "close-failed");
  }
  void Promise.resolve().then(() => {
    suppressCancel = false;
  });
}

export function stopAcceptingWork(): Promise<void> {
  if (ledger?.run === "processing") ledger.run = "cancel-requested";
  return pumpTask ?? Promise.resolve();
}
