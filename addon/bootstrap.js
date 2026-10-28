/* SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Plugin lifecycle. Adapted from the community zotero-plugin-template v3.1.0
 * addon/bootstrap.js (AGPL-3.0-or-later), which credits Zotero's Make It Red
 * example. Only the lifecycle is reused; the plugin build is our own.
 */
var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
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
  await Zotero.MuPDFCompress.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.MuPDFCompress?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.MuPDFCompress?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.MuPDFCompress?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
