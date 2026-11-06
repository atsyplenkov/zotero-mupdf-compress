/* SPDX-License-Identifier: AGPL-3.0-or-later */
"use strict";

const HTML = "http://www.w3.org/1999/xhtml";
const ICONS = {
  tick: { src: "chrome://zotero/skin/tick.png", alt: "Compressed" },
  cross: { src: "chrome://zotero/skin/cross.png", alt: "Not replaced" },
};
let revertIndex = -1;

function reportUIError(stage, error) {
  try {
    window.arguments?.[0]?.reportUIError(stage, error);
  } catch {}
}

function model() {
  return window.arguments?.[0];
}

function cell(text) {
  const node = document.createElementNS(HTML, "td");
  node.textContent = text;
  node.style.padding = "4px 8px";
  return node;
}

window.MuPDFQueueRender = function () {
  let view;
  try {
    if (window.closed || document.readyState === "loading") return;
    view = model();
    if (!view) return;
    const headline = document.getElementById("headline");
    const bar = document.getElementById("bar");
    const button = document.getElementById("action");
    const tbody = document.getElementById("tbody");
    if (!headline || !bar || !button || !tbody) return;
    headline.textContent = view.headline;
    bar.value = view.bar;
    button.label = view.button === "close" ? "Close" : "Cancel";
    tbody.textContent = "";
    view.rows.forEach((row, index) => {
      const line = document.createElementNS(HTML, "tr");
      const iconCell = document.createElementNS(HTML, "td");
      const icon = ICONS[row.icon];
      if (icon) {
        const image = document.createElementNS(HTML, "img");
        image.src = icon.src;
        image.alt = icon.alt;
        iconCell.appendChild(image);
      }
      line.appendChild(iconCell);
      line.appendChild(cell(row.file));
      line.appendChild(cell(row.before));
      line.appendChild(cell(row.after));
      line.appendChild(cell(row.saved));
      line.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (!row.canRevert) return;
        revertIndex = index;
        document.getElementById("revert-popup")?.openPopupAtScreen(event.screenX, event.screenY, true);
      });
      tbody.appendChild(line);
    });
  } catch (error) {
    reportUIError("window-render", error);
    return;
  }
  try {
    window.sizeToContent();
  } catch (error) {
    reportUIError("window-size", error);
  }
};

window.addEventListener("load", () => {
  try {
    document.getElementById("action")?.addEventListener("command", () => {
      try {
        model()?.activate();
      } catch (error) {
        reportUIError("window-command", error);
      }
    });
    document.getElementById("revert-item")?.addEventListener("command", () => {
      try {
        if (revertIndex < 0) return;
        model()?.revert(revertIndex);
      } catch (error) {
        reportUIError("window-revert", error);
      }
    });
    window.MuPDFQueueRender();
  } catch (error) {
    reportUIError("window-load", error);
  }
});

window.addEventListener("unload", () => {
  try {
    model()?.dismiss();
  } catch (error) {
    reportUIError("window-unload", error);
  }
});
