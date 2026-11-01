/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { createOperation, onWindowClose, releaseOperation } from "./operation";

const PANE_ID = "mupdf-compress-preferences";
const closeHandlers = new Map<Window, () => void>();

async function onStartup(): Promise<void> {
  await Promise.all([Zotero.initializationPromise, Zotero.uiReadyPromise]);
  await releaseOperation();
  addon.operation = createOperation(rootURI);
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
  });

  for (const win of Zotero.getMainWindows()) {
    onMainWindowLoad(win);
  }

  addon.data.initialized = true;
}

function onMainWindowLoad(win: Window): void {
  if (addon.data.mainWindows.has(win)) return;
  addon.data.mainWindows.add(win);
  const handler = () => {
    onWindowClose(win);
  };
  win.addEventListener("close", handler);
  closeHandlers.set(win, handler);
}

function onMainWindowUnload(win: Window): void {
  const handler = closeHandlers.get(win);
  if (handler) {
    win.removeEventListener("close", handler);
    closeHandlers.delete(win);
  }
  onWindowClose(win);
  addon.data.mainWindows.delete(win);
}

async function onShutdown(): Promise<void> {
  for (const win of addon.data.mainWindows) {
    onMainWindowUnload(win);
  }
  if (addon.data.paneID) {
    Zotero.PreferencePanes.unregister(addon.data.paneID);
    addon.data.paneID = null;
  }
  await releaseOperation();
  addon.operation = null;
  addon.data.mainWindows.clear();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  if (Zotero[addon.data.config.addonInstance] === addon) {
    // @ts-expect-error - Plugin instance is not typed
    delete Zotero[addon.data.config.addonInstance];
  }
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};
