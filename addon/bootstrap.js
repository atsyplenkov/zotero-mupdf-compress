/* SPDX-License-Identifier: AGPL-3.0-or-later */
var chromeHandle;

function install() {}

async function startup({ rootURI }) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "mupdf-compress", rootURI + "content/"],
  ]);

  const ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}content/scripts/mupdf-compress.js`,
    ctx,
  );
  Zotero.MuPDFCompress.compress = (item) =>
    Zotero.MuPDFCompress.startCompress(item ? [item] : []);
  Zotero.MuPDFCompress.revert = (item) =>
    Zotero.MuPDFCompress.startRevert(item ? [item] : []);
  Zotero.MuPDFCompress.snapshot = () =>
    Zotero.MuPDFCompress.operation.snapshot();
  await Zotero.MuPDFCompress.hooks.onStartup();
}

async function onMainWindowLoad({ window }) {
  await Zotero.MuPDFCompress?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }) {
  await Zotero.MuPDFCompress?.hooks.onMainWindowUnload(window);
}

async function shutdown(_data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.MuPDFCompress?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall() {}

void install;
void startup;
void onMainWindowLoad;
void onMainWindowUnload;
void shutdown;
void uninstall;
