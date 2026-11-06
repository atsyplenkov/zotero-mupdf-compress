/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { log } from "./files";
import { hasSessionBackup } from "./operation";
import {
  COMPRESS_STAGES,
  type CompressStage,
  type Phase,
  type RunState,
  barValue,
  canRevert,
  projectRow,
  resultFromOutcome,
  runButton,
  runHeadline,
} from "./queue-view";
import { selectPdfs } from "./target";
import type { OperationReport } from "./types";

interface Row {
  libraryID: number;
  key: string;
  filename: string;
  phase: Phase;
  revertRequested: boolean;
}

interface QueueWindow extends Window {
  MuPDFQueueRender?: () => void;
}

interface DialogModel {
  headline: string;
  bar: number;
  button: "cancel" | "close";
  rows: Array<ReturnType<typeof projectRow> & { canRevert: boolean }>;
  activate(): void;
  revert(index: number): void;
  dismiss(): void;
  reportUIError(stage: string, error: unknown): void;
}

interface Ledger {
  run: RunState;
  rows: Row[];
  win: QueueWindow | null;
  dismissed: boolean;
  model: DialogModel;
}

let ledger: Ledger | null = null;
let pumpTask: Promise<void> | null = null;
let halted = false;

function rowId(row: Row): string {
  return `${row.libraryID}:${row.key}`;
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

function syncModel(current: Ledger): void {
  current.model.headline = runHeadline(current.run, installedCount(current.rows));
  current.model.bar = barValue(current.rows, current.run);
  current.model.button = runButton(current.run);
  current.model.rows = current.rows.map((row) => ({
    ...projectRow(row.filename, row.phase),
    canRevert: canRevert(row.phase, hasSessionBackup(rowId(row))),
  }));
}

function publish(): void {
  if (!ledger || ledger.dismissed || !ledger.win || ledger.win.closed) return;
  syncModel(ledger);
  try {
    ledger.win.MuPDFQueueRender?.();
  } catch (error) {
    ledger.model.reportUIError("window-render", error);
  }
}

function refetch(row: Row): Zotero.Item | null {
  try {
    const item = Zotero.Items.getByLibraryAndKey(row.libraryID, row.key);
    return item || null;
  } catch {
    return null;
  }
}

function isStage(stage: string): stage is CompressStage {
  return (COMPRESS_STAGES as readonly string[]).includes(stage);
}

function reportFor(row: Row): OperationReport {
  return {
    stage(stage: string) {
      if (!ledger || row.phase.kind !== "running" || !isStage(stage)) return;
      row.phase = { kind: "running", stage, before: row.phase.before };
      publish();
    },
    measured(beforeBytes: number) {
      if (!ledger || row.phase.kind !== "running") return;
      row.phase = { kind: "running", stage: row.phase.stage, before: beforeBytes };
      publish();
    },
  };
}

function blocked(before: number | null): Phase {
  return { kind: "done", result: { kind: "blocked", before } };
}

function priorBefore(row: Row): number | null {
  if (row.phase.kind !== "done") return null;
  return row.phase.result.before;
}

async function runOneRevert(row: Row): Promise<void> {
  row.revertRequested = false;
  const operation = addon.operation;
  const item = refetch(row);
  if (!operation || !item || !hasSessionBackup(rowId(row))) return;
  let outcome;
  try {
    outcome = await operation.revert(item, {
      stage() {},
      measured() {},
    });
  } catch {
    log("queue", "revert-failed");
    return;
  }
  const restored = outcome.producedBytes;
  const before = priorBefore(row);
  if (outcome.code !== "success" && outcome.changed !== true) return;
  if (typeof restored !== "number" || typeof before !== "number") return;
  row.phase = {
    kind: "done",
    result: { kind: "reverted", before, after: restored },
  };
}

async function runOneCompress(row: Row): Promise<void> {
  const operation = addon.operation;
  const item = refetch(row);
  if (!operation || !item) {
    row.phase = blocked(null);
    return;
  }
  row.phase = { kind: "running", stage: "Preparing", before: null };
  publish();
  try {
    const outcome = await operation.compress(item, reportFor(row));
    row.phase = { kind: "done", result: resultFromOutcome(outcome) };
  } catch {
    const before = row.phase.kind === "running" ? row.phase.before : null;
    row.phase = blocked(before);
    log("queue", "compress-failed");
  }
}

function settle(): void {
  if (!ledger) return;
  for (const row of ledger.rows) {
    if (row.phase.kind === "waiting") row.phase = blocked(null);
  }
  ledger.run = "finished";
  if (ledger.dismissed || !ledger.win || ledger.win.closed) {
    ledger = null;
    return;
  }
  publish();
}

async function runPump(): Promise<void> {
  try {
    while (ledger && !halted) {
      const revertRow = ledger.rows.find((row) => row.revertRequested);
      if (revertRow && hasSessionBackup(rowId(revertRow))) {
        await runOneRevert(revertRow);
        publish();
        continue;
      }
      if (revertRow) revertRow.revertRequested = false;
      if (ledger.run !== "processing") break;
      const next = ledger.rows.find((row) => row.phase.kind === "waiting");
      if (!next) break;
      await runOneCompress(next);
      publish();
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

function openWindow(model: DialogModel): QueueWindow | null {
  try {
    const parent = Zotero.getMainWindow() as (Window & {
      openDialog?(url: string, name: string, features: string, arg: unknown): Window | null;
    }) | null;
    if (!parent || parent.closed || typeof parent.openDialog !== "function") return null;
    return parent.openDialog(
      "chrome://mupdf-compress/content/queue.xhtml",
      "",
      "chrome,dialog=yes,dependent=yes,modal=no,titlebar=yes,resizable=yes,width=640,height=420",
      model,
    ) as QueueWindow | null;
  } catch (error) {
    model.reportUIError("show", error);
    return null;
  }
}

function createModel(): DialogModel {
  return {
    headline: "Processing",
    bar: 0,
    button: "cancel",
    rows: [],
    activate() {
      if (!ledger) return;
      if (ledger.run === "finished") {
        try {
          ledger.win?.close();
        } catch (error) {
          ledger.model.reportUIError("window-close", error);
        }
        return;
      }
      if (ledger.run === "processing") cancel();
    },
    revert(index: number) {
      const row = ledger?.rows[index];
      if (!row || !canRevert(row.phase, hasSessionBackup(rowId(row)))) return;
      row.revertRequested = true;
      ensurePump();
    },
    dismiss() {
      if (!ledger) return;
      if (ledger.run === "finished") {
        ledger = null;
        return;
      }
      ledger.dismissed = true;
      ledger.win = null;
      if (ledger.run === "processing") ledger.run = "cancel-requested";
    },
    reportUIError(stage: string, error: unknown) {
      const name = String((error as { name?: string })?.name || "Error")
        .replace(/[^A-Za-z0-9_.-]/g, "")
        .slice(0, 64);
      log(stage, name || "ui-error");
    },
  };
}

export function startCompress(items: Zotero.Item[] | null | undefined): void {
  const selected = selectPdfs(items);
  if (!selected.length || !addon.operation || halted) return;
  if (ledger) {
    const win = ledger.win;
    if (win && !win.closed) {
      try {
        win.focus();
      } catch (error) {
        ledger.model.reportUIError("window-focus", error);
      }
    }
    return;
  }
  const model = createModel();
  const next: Ledger = {
    run: "processing",
    rows: selected.map((item) => ({
      libraryID: item.libraryID,
      key: item.key,
      filename: filenameOf(item),
      phase: { kind: "waiting" },
      revertRequested: false,
    })),
    win: null,
    dismissed: false,
    model,
  };
  ledger = next;
  syncModel(next);
  next.win = openWindow(model);
  if (!next.win) {
    ledger = null;
    return;
  }
  publish();
  ensurePump();
}

export function cancel(): void {
  if (ledger?.run === "processing") {
    ledger.run = "cancel-requested";
    publish();
  }
}

export function haltCompress(): Promise<void> {
  halted = true;
  return pumpTask ?? Promise.resolve();
}

export function resumeCompress(): void {
  if (!pumpTask) halted = false;
}
