/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { log } from "./files";
import {
  QUEUE_COLUMNS,
  QUEUE_TITLE,
  type Phase,
  type RunState,
  compressedHeadline,
  queueMessage,
  queueStatus,
  resultFromOutcome,
} from "./queue-view";
import { selectPdfs } from "./target";
import type { OperationReport } from "./types";

interface Row {
  libraryID: number;
  key: string;
  filename: string;
  phase: Phase;
}

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

interface Ledger {
  run: RunState;
  rows: Row[];
  closedByQueue: boolean;
}

const QUEUE_ID = "mupdf-compress";
const silentReport: OperationReport = { stage() {}, measured() {} };

let ledger: Ledger | null = null;
let pumpTask: Promise<void> | null = null;
let halted = false;
let progressQueue: ProgressQueueApi | null = null;

function progressQueues(): ProgressQueuesApi | null {
  const host = Zotero as unknown as { ProgressQueues?: ProgressQueuesApi };
  return host.ProgressQueues ?? null;
}

function onQueueCancel(): void {
  if (!ledger) return;
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

function installedCount(rows: readonly Row[]): number {
  return rows.filter((row) => row.phase.kind === "done" && row.phase.result.kind === "installed").length;
}

function refetch(row: Row): Zotero.Item | null {
  try {
    const item = Zotero.Items.getByLibraryAndKey(row.libraryID, row.key);
    return item || null;
  } catch {
    return null;
  }
}

function blocked(code: string): Phase {
  return { kind: "done", result: { kind: "blocked", before: null, code } };
}

function showRow(queue: ProgressQueueApi, row: Row): void {
  const item = refetch(row);
  if (!item) return;
  if (!queue.getRows().some((entry) => entry.id === item.id)) queue.addRow(item);
  const entry = queue.getRows().find((candidate) => candidate.id === item.id);
  // addRow stores the item title. The dialog reads this same row object.
  if (entry) entry.fileName = row.filename;
  queue.updateRow(item.id, queueStatus(row.phase), queueMessage(row.phase));
}

function publishRows(): void {
  if (!ledger || ledger.closedByQueue) return;
  const queue = ensureQueue();
  if (!queue) return;
  for (const row of ledger.rows) showRow(queue, row);
}

async function runOneCompress(row: Row): Promise<void> {
  const operation = addon.operation;
  const item = refetch(row);
  if (!operation || !item) {
    row.phase = blocked(item ? "failure" : "missing");
    publishRows();
    return;
  }
  row.phase = { kind: "running" };
  publishRows();
  try {
    const outcome = await operation.compress(item, silentReport);
    row.phase = { kind: "done", result: resultFromOutcome(outcome) };
  } catch {
    row.phase = blocked("failure");
    log("queue", "compress-failed");
  }
  publishRows();
}

function settle(): void {
  if (!ledger) return;
  if (ledger.closedByQueue || halted) {
    ledger = null;
    return;
  }
  for (const row of ledger.rows) {
    if (row.phase.kind === "waiting") row.phase = blocked("stopped");
  }
  ledger.run = "finished";
  publishRows();
  try {
    ensureQueue()?.getDialog().setStatus(compressedHeadline(installedCount(ledger.rows)));
  } catch {
    log("queue", "status-failed");
  }
}

async function runPump(): Promise<void> {
  try {
    while (ledger && !halted && ledger.run === "processing") {
      const next = ledger.rows.find((row) => row.phase.kind === "waiting");
      if (!next) break;
      await runOneCompress(next);
    }
  } finally {
    settle();
  }
}

function ensurePump(): void {
  if (pumpTask) return;
  pumpTask = runPump().finally(() => {
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

export function startCompress(items: Zotero.Item[] | null | undefined): void {
  const selected = selectPdfs(items);
  if (!selected.length || !addon.operation || halted) return;
  const queue = ensureQueue();
  if (!queue) {
    log("queue", "show-failed");
    return;
  }
  if (ledger) {
    const dialog = queue.getDialog();
    if (ledger.run !== "finished" || dialog.isOpen()) {
      openDialog(queue);
      return;
    }
    queue.cancel();
  }
  const next: Ledger = {
    run: "processing",
    closedByQueue: false,
    rows: selected.map((item) => ({
      libraryID: item.libraryID,
      key: item.key,
      filename: filenameOf(item),
      phase: { kind: "waiting" },
    })),
  };
  ledger = next;
  try {
    queue.getDialog().setStatus("");
  } catch {
    log("queue", "status-failed");
  }
  publishRows();
  if (!openDialog(queue)) {
    ledger = null;
    return;
  }
  ensurePump();
}

export function haltCompress(): Promise<void> {
  halted = true;
  try {
    const dialog = progressQueue?.getDialog();
    if (dialog?.isOpen()) dialog.close();
    else progressQueue?.cancel();
  } catch {
    log("queue", "close-failed");
  }
  return pumpTask ?? Promise.resolve();
}

export function resumeCompress(): void {
  if (!pumpTask) halted = false;
}
