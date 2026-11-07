/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { onMainWindowLoad as onWindowMenuLoad, onMainWindowUnload as onWindowMenuUnload, registerMenus, unregisterMenus } from "./menu";
import { createOperation, releaseOperation } from "./operation";
import { dismissQueueDialog, showQueueIfWorking, stopAcceptingWork } from "./queue";

const PANE_ID = "mupdf-compress-preferences";
let shutdownRegistered = false;

async function onStartup(): Promise<void> {
  await Promise.all([Zotero.initializationPromise, Zotero.uiReadyPromise]);
  await releaseOperation();
  unregisterMenus();
  addon.operation = createOperation(rootURI);
  if (!shutdownRegistered) {
    // Zotero awaits these listeners before it closes the database and exits.
    Zotero.addShutdownListener(async () => {
      await stopAcceptingWork();
      await releaseOperation();
    });
    shutdownRegistered = true;
  }
  await addon.operation.ready;

  if (addon.data.paneID) {
    Zotero.PreferencePanes.unregister(addon.data.paneID);
    addon.data.paneID = null;
  }
  addon.data.paneID = await Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    id: PANE_ID,
    label: addon.data.config.addonName,
    src: rootURI + "content/preferences.xhtml",
    scripts: [rootURI + "content/preferences.js"],
  });

  registerMenus();
  for (const win of Zotero.getMainWindows()) {
    onMainWindowLoad(win);
  }

  addon.data.initialized = true;
}

function onMainWindowLoad(win: Window): void {
  if (addon.data.mainWindows.has(win)) return;
  addon.data.mainWindows.add(win);
  onWindowMenuLoad(win);
  showQueueIfWorking();
}

function onMainWindowUnload(win: Window): void {
  onWindowMenuUnload(win);
  addon.data.mainWindows.delete(win);
  if (!addon.data.mainWindows.size) dismissQueueDialog();
}

async function onShutdown(): Promise<void> {
  for (const win of addon.data.mainWindows) {
    onMainWindowUnload(win);
  }
  if (addon.data.paneID) {
    Zotero.PreferencePanes.unregister(addon.data.paneID);
    addon.data.paneID = null;
  }
  unregisterMenus();
  await stopAcceptingWork();
  await releaseOperation();
  addon.operation = null;
  addon.data.mainWindows.clear();
  addon.data.alive = false;
  if (Zotero.MuPDFCompress === addon) {
    delete Zotero.MuPDFCompress;
  }
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};
