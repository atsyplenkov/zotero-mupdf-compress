/* SPDX-License-Identifier: AGPL-3.0-or-later */
"use strict";

const TEMPORARY_FOLDER_PREF = "extensions.mupdf-compress.temporaryFolder";

function browseTemporaryFolder() {
  const input = document.getElementById("mupdf-compress-temporary-folder");
  if (!input) return;
  const nsIFilePicker = Components.interfaces.nsIFilePicker;
  const picker = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
  picker.init(window.browsingContext, "Temporary folder", nsIFilePicker.modeGetFolder);
  picker.open((result) => {
    if (result !== nsIFilePicker.returnOK) return;
    const path = picker.file.path;
    input.value = path;
    Zotero.Prefs.set(TEMPORARY_FOLDER_PREF, path, true);
  });
}

// Pane scripts run in a sandbox, so the button handler has to be on the window.
window.mupdfCompressBrowseTemporaryFolder = browseTemporaryFolder;
