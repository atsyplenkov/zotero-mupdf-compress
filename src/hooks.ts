/* SPDX-License-Identifier: AGPL-3.0-or-later */
const PANE_ID = "mupdf-compress-preferences";

async function onStartup(): Promise<void> {
  await Promise.all([Zotero.initializationPromise, Zotero.uiReadyPromise]);

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
  addon.data.mainWindows.add(win);
}

function onMainWindowUnload(win: Window): void {
  addon.data.mainWindows.delete(win);
}

function onShutdown(): void {
  if (addon.data.paneID) {
    Zotero.PreferencePanes.unregister(addon.data.paneID);
    addon.data.paneID = null;
  }
  addon.data.mainWindows.clear();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};
