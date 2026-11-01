/* SPDX-License-Identifier: AGPL-3.0-or-later */
"use strict";
let closeTimer;
let resultScheduled = false;

function reportUIError(stage, error) {
  try {
    window.arguments?.[0]?.reportUIError(stage, error);
  } catch {
    // Host reporter is unavailable during teardown.
  }
}

function closeFeedbackWindow() {
  try {
    if (!window.closed) window.close();
  } catch (error) {
    reportUIError("window-close", error);
  }
}

window.MuPDFProgressRender = function () {
  let model;
  try {
    if (window.closed || document.readyState === "loading") return;
    model = window.arguments?.[0];
    if (!model) return;
    const nodes = ["action", "title", "stage", "message"].map((id) =>
      document.getElementById(id),
    );
    if (nodes.some((node) => !node)) return;
    nodes[0].textContent = model.action + " PDF";
    nodes[1].textContent = model.title;
    nodes[2].textContent = model.stage;
    nodes[3].textContent = model.message;
  } catch (error) {
    reportUIError("window-render", error);
    return;
  }
  try {
    window.sizeToContent();
  } catch (error) {
    reportUIError("window-size", error);
  }
  try {
    if (!window.closed && model.result && !resultScheduled) {
      resultScheduled = true;
      model.visibleAt = Date.now();
      if (model.autoDismiss) {
        closeTimer = window.setTimeout(closeFeedbackWindow, 10000);
      }
    }
  } catch (error) {
    reportUIError("window-result-timer", error);
  }
};

window.addEventListener("load", () => {
  try {
    document
      .getElementById("dismiss")
      ?.addEventListener("command", closeFeedbackWindow);
    window.MuPDFProgressRender();
  } catch (error) {
    reportUIError("window-load", error);
  }
});

window.addEventListener("unload", () => {
  try {
    if (closeTimer) window.clearTimeout(closeTimer);
  } catch (error) {
    reportUIError("window-unload", error);
  }
  try {
    const model = window.arguments?.[0];
    if (model?.win === window) model.win = null;
  } catch {
    // Window reference was already detached.
  }
});
