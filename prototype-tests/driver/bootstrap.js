/* SPDX-License-Identifier: AGPL-3.0-or-later
 * THROWAWAY: privileged, disposable-profile-only integration driver.
 */
var { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");
var stopped = false;
var running;
function install() {}
function uninstall() {}
async function startup({ rootURI, resourceURI }) {
  stopped = false;
  running = drive(rootURI || resourceURI.spec);
  running.catch(error => Zotero.debug("MuPDF test driver failed: " + error.name));
}
async function shutdown() {
  stopped = true;
  await running;
}
async function drive(rootURI) {
  await Zotero.initializationPromise;
  var profile = Zotero.Profile.dir;
  if (!profile.endsWith("/.local-test/zotero/profile")) return;
  var local = PathUtils.parent(PathUtils.parent(profile));
  var work = PathUtils.join(local, "prototype");
  var requestPath = PathUtils.join(work, "integration-request.json");
  if (!(await IOUtils.exists(requestPath))) return;
  var request = await IOUtils.readJSON(requestPath);
  if (request.allowDisposableLibraryChanges !== true
      || request.expectedProfile !== profile
      || request.expectedData !== Zotero.DataDirectory.dir
      || !/^[A-Za-z0-9_-]{1,80}$/.test(request.runID || "")) {
    throw new Error("Unsafe test request");
  }
  // Claim a request once. A subsequent launch cannot accidentally repeat it.
  var claimed = PathUtils.join(work, "integration-request-" + request.runID + ".claimed.json");
  await IOUtils.move(requestPath, claimed, { noOverwrite: true });
  var evidencePath = PathUtils.join(work, "integration-" + request.runID + ".json");
  try {
    var api;
    for (var i = 0; i < 120 && !stopped; i++) {
      api = Zotero.getMainWindow()?.MuPDFCompressPrototype;
      if (api) break;
      await Zotero.Promise.delay(500);
    }
    if (stopped) return;
    if (!api) throw new Error("Prototype API was not exposed within 60 seconds");
    await api.ready;
    var scope = { Zotero, IOUtils, PathUtils, ChromeUtils, Components, Services };
    Services.scriptloader.loadSubScript(rootURI + "lifecycle-modes.js", scope);
    Services.scriptloader.loadSubScript(rootURI + "integration.js", scope);
    await scope.runMuPDFIntegration(api, request, {
      work, local, evidencePath, window: Zotero.getMainWindow(),
    });
  } catch (error) {
    await IOUtils.writeJSON(evidencePath, {
      runID: request.runID, status: "driver-failed",
      error: { name: error.name, message: String(error.message) },
      finished: new Date().toISOString(),
    });
  }
}
