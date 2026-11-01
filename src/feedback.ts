/* SPDX-License-Identifier: AGPL-3.0-or-later */

import type { Action, Outcome, UiErrorDiagnostic } from "./types";

type DialogWindow = {
  closed?: boolean;
  close(): void;
  openDialog?(url: string, name: string, features: string, arg: unknown): unknown;
  MuPDFProgressRender?(): void;
};

const activeFeedback = new Set<Feedback>();

export function recordUiError(
  uiErrors: UiErrorDiagnostic[],
  stage: string,
  error: unknown,
): void {
  let name = "Error";
  let code: number | null = null;
  try {
    const candidate = error as { name?: string; result?: number; errorCode?: number };
    name = String(candidate?.name || "Error").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64);
    code = Number.isInteger(candidate?.result)
      ? candidate.result!
      : Number.isInteger(candidate?.errorCode)
        ? candidate.errorCode!
        : null;
  } catch {
    // Exception properties can be inaccessible after teardown.
  }
  try {
    uiErrors.push({ stage, name, code });
  } catch {
    // Diagnostic buffer unavailable.
  }
  try {
    Zotero.debug(`[MuPDF Compress UI] ${stage}: ${name} code=${code}`);
  } catch {
    // Logging itself can fail during teardown.
  }
}

export class Feedback {
  public title: string;
  public action: Action;
  public stage: string;
  public message: string;
  public result: Outcome | null;
  public autoDismiss: boolean;
  public visibleAt: number | null;
  public win: DialogWindow | null;
  public parent: DialogWindow | null;
  private uiErrors: UiErrorDiagnostic[];
  private isStopping: () => boolean;

  constructor(
    item: Zotero.Item | null | undefined,
    action: Action,
    uiErrors: UiErrorDiagnostic[],
    isStopping: () => boolean,
  ) {
    let title = "PDF attachment";
    try {
      const candidate = item?.getField("title");
      if (typeof candidate === "string" && candidate) title = candidate;
    } catch {
      title = "PDF attachment";
    }
    this.title = title;
    this.action = action;
    this.stage = "Preparing";
    this.message = "Closing this window does not cancel the operation.";
    this.result = null;
    this.autoDismiss = false;
    this.visibleAt = null;
    this.win = null;
    this.parent = null;
    this.uiErrors = uiErrors;
    this.isStopping = isStopping;
    activeFeedback.add(this);
    this.show();
  }

  public reportUIError(stage: string, error: unknown): void {
    recordUiError(this.uiErrors, stage, error);
  }

  private uiOnly(stage: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.reportUIError(stage, error);
    }
  }

  public show(): void {
    this.uiOnly("show", () => {
      if (this.isStopping()) return;
      if (this.win && !this.win.closed) return;
      const parent = Zotero.getMainWindow() as unknown as DialogWindow | null;
      if (!parent || parent.closed || typeof parent.openDialog !== "function") return;
      this.parent = parent;
      this.win = parent.openDialog(
        "chrome://mupdf-compress/content/progress.xhtml",
        "",
        "chrome,dialog=yes,dependent=yes,modal=no,titlebar=yes,resizable=yes,width=440",
        this,
      ) as DialogWindow | null;
    });
  }

  public render(): void {
    this.uiOnly("render", () => {
      if (this.isStopping() || !this.win || this.win.closed) return;
      this.win.MuPDFProgressRender?.();
    });
  }

  public update(stage: string): void {
    this.stage = stage;
    this.render();
  }

  public finish(outcome: Outcome): void {
    this.result = outcome;
    this.autoDismiss = outcome.code === "success" || outcome.code === "no-benefit";
    this.stage = outcome.code === "success" ? "Complete" : "Result";
    this.message = outcome.message;
    this.show();
    this.render();
  }

  public close(): void {
    const win = this.win;
    this.win = null;
    activeFeedback.delete(this);
    this.uiOnly("close", () => {
      if (win && !win.closed) win.close();
    });
  }
}

export function closeFeedbackForWindow(win?: Window): void {
  for (const feedback of activeFeedback) {
    if (!win || feedback.parent === win) {
      feedback.close();
    }
  }
}
