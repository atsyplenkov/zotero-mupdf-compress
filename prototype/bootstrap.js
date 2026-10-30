/* SPDX-License-Identifier: AGPL-3.0-or-later
 * THROWAWAY Linux prototype for #9. Lifecycle adapted from
 * windingwind/zotero-plugin-template v3.1.0 addon/bootstrap.js (AGPL-3.0-or-later).
 */
var chromeHandle;
var app;
var root;
const PLUGIN_ID = "mupdf-compress-prototype@zotero.local";
const PREF = "extensions.mupdf-compress-prototype.";
const MENU_ID = "mupdf-compress-prototype-menu";
const OWNER_MARKER = "MuPDF Compress prototype session v1\n";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLEAN = ["clean", "-ggg", "-z", "-Z", "-f", "-i", "-m", "--structure=keep",
  "--color-image-subsample-dpi=150", "--color-image-recompress-method=jpeg:85",
  "--gray-image-subsample-dpi=150", "--gray-image-recompress-method=jpeg:85",
  "--recompress-images-when=smaller"];

function install() {}
function uninstall() {}

function loadModule(esURI, jsmURI) {
  try { return ChromeUtils.importESModule(esURI); }
  catch (_) { return ChromeUtils.import(jsmURI); }
}
function uuid() { return Services.uuid.generateUUID().toString().slice(1, -1); }
function localFile(path) {
  let file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
  file.initWithPath(path);
  return file;
}
function join(...parts) { return parts.join("/").replace(/\/+/g, "/"); }
function log(stage, code) {
  // Never log exception messages or native output: both can contain PDF content.
  Zotero.debug(`[MuPDF prototype] ${stage}: ${code}`);
}
function fail(code) { let e = new Error(code); e.safeCode = code; throw e; }
function eligible(item) {
  return !!(item && item.isAttachment() && item.attachmentContentType === "application/pdf"
    && (item.isStoredFileAttachment() || item.isLinkedFileAttachment()));
}
function identity(item) { return `${item.libraryID}:${item.key}`; }
function checkNoSymlinks(path, allowMissing = false) {
  if (typeof path !== "string" || !path.startsWith("/") || path.split("/").includes("..")) fail("unsafe-path");
  let current = localFile(path);
  while (current) {
    try {
      if (current.isSymlink()) fail("symlink-path");
    } catch (e) {
      // nsIFile can throw for absent components. lstat still detects broken
      // symlinks; only these explicit not-found errors may be ignored.
      if (!(allowMissing && ["NS_ERROR_FILE_NOT_FOUND", "NS_ERROR_FILE_TARGET_DOES_NOT_EXIST"].includes(e.name))) throw e;
    }
    if (!allowMissing && !current.exists()) fail("missing-path");
    current = current.parent;
  }
}
function fileHash(path) {
  checkNoSymlinks(path);
  let input = Components.classes["@mozilla.org/network/file-input-stream;1"]
    .createInstance(Components.interfaces.nsIFileInputStream);
  let hash = Components.classes["@mozilla.org/security/hash;1"]
    .createInstance(Components.interfaces.nsICryptoHash);
  input.init(localFile(path), 0x01, 0, 0);
  try {
    hash.init(hash.SHA256);
    hash.updateFromStream(input, 0xffffffff);
    return Array.from(hash.finish(false), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } finally { input.close(); }
}
async function readResourceBytes(uri) {
  const { NetUtil } = loadModule("resource://gre/modules/NetUtil.sys.mjs", "resource://gre/modules/NetUtil.jsm");
  let channel = NetUtil.newChannel({ uri, loadUsingSystemPrincipal: true,
    securityFlags: Components.interfaces.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    contentPolicyType: Components.interfaces.nsIContentPolicy.TYPE_OTHER });
  return new Promise((resolve, reject) => {
    NetUtil.asyncFetch(channel, (stream, status) => {
      if (!Components.isSuccessCode(status)) { reject(new Error("resource-read")); return; }
      let binary = Components.classes["@mozilla.org/binaryinputstream;1"]
        .createInstance(Components.interfaces.nsIBinaryInputStream);
      binary.setInputStream(stream);
      try { resolve(Uint8Array.from(binary.readByteArray(binary.available()))); }
      catch (e) { reject(e); }
      finally { binary.close(); }
    });
  });
}
async function extractNative() {
  app.startupStage = "read-native-manifest";
  const native = JSON.parse(new TextDecoder().decode(await readResourceBytes(root + "native-digests.json")));
  app.startupStage = "native-cache-path";
  const profile = typeof Zotero.Profile.dir === "string" ? Zotero.Profile.dir : Zotero.Profile.dir.path;
  const cache = join(profile, "mupdf-compress-prototype", native.mutool.slice(0, 16));
  checkNoSymlinks(cache, true);
  app.startupStage = "create-native-cache";
  await IOUtils.makeDirectory(cache, { createAncestors: true, permissions: 0o700 });
  checkNoSymlinks(cache);
  for (let name of ["mutool", "session-lock"]) {
    let path = join(cache, name);
    app.startupStage = "check-native-" + name;
    if (!/^[a-f0-9]{64}$/.test(native[name])) fail("native-digest-manifest");
    if (!(await IOUtils.exists(path)) || fileHash(path) !== native[name]) {
      checkNoSymlinks(path, true);
      app.startupStage = "read-native-" + name;
      let bytes = await readResourceBytes(root + "bin/" + name);
      app.startupStage = "write-native-" + name;
      await IOUtils.write(path, bytes, { mode: "overwrite" });
    }
    app.startupStage = "verify-native-" + name;
    await IOUtils.setPermissions(path, 0o700);
    if (fileHash(path) !== native[name]) fail("native-digest-mismatch");
    app.native[name] = path;
  }
}
async function drain(pipe, keep = false) {
  let text = "";
  for (;;) {
    let chunk = await pipe.readString();
    if (!chunk) break;
    if (keep) {
      text += chunk;
      if (text.length > 4 * 1024 * 1024) fail("engine-output-limit");
    }
  }
  return text;
}
async function nativeRun(args, capture = false) {
  let proc;
  try {
    proc = await app.Subprocess.call({ command: app.native.mutool, arguments: args,
      stderr: "pipe", environmentAppend: true, environment: { LC_ALL: "C", LANG: "C" } });
    try { await proc.stdin.close(); }
    catch (e) {
      // Firefox automatically closes stdin when a short-lived child exits.
      // A second close can race with that cleanup; only EOF is benign.
      if (e.errorCode !== app.Subprocess.ERROR_END_OF_FILE) throw e;
    }
    let [stdout, , result] = await Promise.all([drain(proc.stdout, capture), drain(proc.stderr), proc.wait()]);
    if (result.exitCode !== 0) fail("engine-exit");
    return stdout;
  } catch (e) {
    if (proc) { try { proc.kill(); } catch (_) {} }
    fail(e.safeCode || "engine-unavailable");
  }
}
async function acquireLock(directory) {
  checkNoSymlinks(directory);
  let lockPath = join(directory, "session.lock");
  checkNoSymlinks(lockPath, true);
  let proc;
  try {
    proc = await app.Subprocess.call({ command: app.native["session-lock"], arguments: [lockPath], stderr: "pipe" });
    let diagnostic = drain(proc.stderr); // discard without forwarding document data
    let hello = await proc.stdout.readString(7);
    if (hello !== "LOCKED\n") fail("lock-unavailable");
    let held = { proc, alive: true, releasing: false, diagnostic };
    proc.wait().then(() => { held.alive = false; });
    return held;
  } catch (_) {
    if (proc) { try { proc.kill(); } catch (_) {} }
    return null;
  }
}
async function releaseLock(lock) {
  if (!lock) return;
  lock.releasing = true;
  try { await lock.proc.stdin.close(); await lock.proc.wait(); await lock.diagnostic; }
  catch (_) { try { lock.proc.kill(); } catch (_) {} }
  lock.alive = false;
}
function requireLock() { if (!app.lock || !app.lock.alive) fail("lock-unavailable"); }
async function recognized(directory) {
  try {
    checkNoSymlinks(directory);
    if (!localFile(directory).isDirectory() || !UUID.test(localFile(directory).leafName)) return false;
    let marker = join(directory, "owner.txt");
    checkNoSymlinks(marker);
    let stat = await IOUtils.stat(marker);
    return stat.type === "regular" && stat.size === OWNER_MARKER.length
      && await IOUtils.readUTF8(marker) === OWNER_MARKER;
  } catch (_) { return false; }
}
async function cleanSession(directory, lock) {
  if (!lock || !lock.alive || !(await recognized(directory))) return false;
  // Sessions are flat. Never recurse, follow a symlink, or delete an unknown file.
  let paths = await IOUtils.getChildren(directory);
  for (let path of paths) {
    checkNoSymlinks(path);
    let name = localFile(path).leafName;
    if (!localFile(path).isFile() || !(name === "owner.txt" || name === "session.lock"
      || /^[a-f0-9-]{36}\.pdf$/.test(name) && UUID.test(name.slice(0, -4)))) return false;
  }
  for (let path of paths.filter(p => !["owner.txt", "session.lock"].includes(localFile(p).leafName))) {
    if (!lock.alive) fail("lock-lost-during-cleanup");
    checkNoSymlinks(path);
    await IOUtils.remove(path);
  }
  // Remove recognition before unlinking the still-locked inode. A concurrent
  // cleanup must not acquire a new inode and regard this directory as owned.
  await IOUtils.remove(join(directory, "owner.txt"));
  await IOUtils.remove(join(directory, "session.lock"));
  await IOUtils.remove(directory);
  return true;
}
async function initSession() {
  let selected = Zotero.Prefs.get(PREF + "temporaryFolder", true) || Zotero.getTempDirectory().path;
  checkNoSymlinks(selected);
  if (!localFile(selected).isDirectory()) fail("temporary-folder");
  app.temporaryRoot = join(selected, "mupdf-compress-prototype-v1");
  checkNoSymlinks(app.temporaryRoot, true);
  await IOUtils.makeDirectory(app.temporaryRoot, { permissions: 0o700 });
  checkNoSymlinks(app.temporaryRoot);
  for (let directory of await IOUtils.getChildren(app.temporaryRoot)) {
    if (!(await recognized(directory))) continue;
    let lock = await acquireLock(directory);
    if (!lock) { app.cleanup.push({ directory, status: "active-or-unlockable" }); continue; }
    try {
      app.cleanup.push({ directory, status: await cleanSession(directory, lock) ? "removed" : "left-unknown-content" });
    } catch (_) { app.cleanup.push({ directory, status: "cleanup-failed" }); }
    finally { await releaseLock(lock); }
  }
  app.sessionDir = join(app.temporaryRoot, uuid());
  await IOUtils.makeDirectory(app.sessionDir, { permissions: 0o700, ignoreExisting: false });
  app.lock = await acquireLock(app.sessionDir);
  if (!app.lock) fail("lock-unavailable");
  await IOUtils.writeUTF8(join(app.sessionDir, "owner.txt"), OWNER_MARKER, { mode: "create" });
}
function readerOpen(item) {
  // Private Zotero field, fail closed if reader access is unavailable.
  if (!Array.isArray(Zotero.Reader?._readers)) fail("reader-check-unavailable");
  return Zotero.Reader._readers.some(reader => reader.itemID === item.id || reader._item?.id === item.id);
}
async function attachmentPath(item) {
  let path = await item.getFilePathAsync();
  if (!path || !(await IOUtils.exists(path))) fail("missing");
  checkNoSymlinks(path);
  if (!localFile(path).isFile()) fail("missing");
  return path;
}
async function hook(name, context) {
  if (Zotero.Prefs.get(PREF + "testMode", true) === true && typeof app.api.hooks[name] === "function") {
    await app.api.hooks[name](context);
  }
}
async function metadata(item) {
  if (item.isStoredFileAttachment()) {
    item.attachmentSyncState = "to_upload";
    await item.saveTx({ skipAll: true });
  }
  await item.getFilePathAsync();
  await Zotero.Notifier.trigger("refresh", "item", item.id);
}
async function documentInfo(path) {
  const text = await nativeRun(["info", path], true);
  if (/Encryption object/i.test(text)) fail("encrypted");
  const match = text.match(/^Pages:\s*(\d+)\s*$/m);
  if (!match || Number(match[1]) < 1) fail("validation");
  return Number(match[1]);
}
async function validate(input, output) {
  if (!(await IOUtils.exists(output)) || !(await IOUtils.stat(output)).size) fail("validation");
  if (await documentInfo(input) !== await documentInfo(output)) fail("validation");
  // Every page is interpreted/rasterized; /dev/null avoids retaining PDF pixels.
  await nativeRun(["draw", "-r", "72", "-F", "ppm", "-o", "/dev/null", input]);
  await nativeRun(["draw", "-r", "72", "-F", "ppm", "-o", "/dev/null", output]);
  // This does not prove visual equivalence or catch all unexpected blank pages.
}
const MESSAGES = {
  missing: "The attachment file could not be found. Locate it in Zotero and try again. The extension did not change the attachment.",
  open: "Close this PDF in the Zotero reader and try again. The attachment was not changed.",
  busy: "An operation is already running for this attachment. Wait for it to finish.",
  repeated: "This attachment is already compressed in this session. Revert before compressing again. This action did not change the attachment.",
  engine: "The bundled PDF engine could not run or finish. The attachment was not changed. See the log for technical details.",
  backup: "A verified session backup could not be prepared. The attachment was not changed. Check the temporary folder and try again.",
  validation: "Compressed output could not be validated. The attachment was not changed.",
  "no-benefit": "No smaller PDF produced. The attachment was not changed.",
  "no-record": "Revert is unavailable: no successful compression is recorded for this attachment in this Zotero session. The attachment was not changed.",
  "backup-invalid": "The session backup is unavailable or could not be verified. The attachment was not changed.",
  "revert-changed": "Revert was blocked because the attachment changed after compression. The extension did not overwrite it.",
  "compress-changed": "The attachment changed during compression. The extension did not replace it.",
  encrypted: "Encrypted PDFs are not supported by this prototype. The attachment was not changed.",
  stopped: "The extension is shutting down. This action did not change the attachment.",
  ineligible: "Select exactly one stored or linked PDF attachment. This action did not change the attachment.",
  "reader-check-unavailable": "The Zotero reader state could not be checked safely. The attachment was not changed.",
  "alias-busy": "An operation is already running for another attachment referencing this PDF. Wait for it to finish.",
  "alias-compressed": "Another attachment referencing this PDF has a session compression record. Revert using that attachment first. This action did not change the attachment.",
  "lock-unavailable": "Exclusive session backup ownership could not be established. The attachment was not changed.",
  uncertain: "The operation failed during file replacement. The attachment's current state could not be verified. See the log for technical details."
};
function uiError(stage, error) {
  // Widget errors are separate from PDF/native errors. Never include messages,
  // document text, paths, or stacks in this diagnostic.
  let name = "Error", code = null;
  try {
    name = String(error?.name || "Error").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64);
    code = Number.isInteger(error?.result) ? error.result
      : Number.isInteger(error?.errorCode) ? error.errorCode : null;
  } catch (_) {} // Even exception properties can be inaccessible after teardown.
  const diagnostic = { stage, name, code, at: Date.now() };
  try { app.uiErrors.push(diagnostic); } catch (_) {}
  try { Zotero.debug(`[MuPDF prototype UI] ${stage}: ${name} code=${code}`); } catch (_) {}
}
function uiOnly(stage, callback) {
  try { return callback(); }
  catch (error) { uiError(stage, error); return undefined; }
}
class Feedback {
  constructor(item, action) {
    this.title = item?.getField("title") || "PDF attachment";
    this.action = action;
    this.stage = "Preparing";
    this.message = "Closing this window does not cancel the operation.";
    this.result = null;
    this.win = null;
    this.show();
    app.feedback.add(this);
  }
  show() {
    uiOnly("show", () => {
      if (app.stopping) return;
      if (this.win && !this.win.closed) return;
      let parent = Zotero.getMainWindow();
      if (!parent || parent.closed || app.closingWindows.has(parent)) return;
      this.parent = parent;
      this.win = parent.openDialog("chrome://mupdf-compress-prototype/content/progress.xhtml", "",
        "chrome,dialog=yes,dependent=yes,modal=no,titlebar=yes,resizable=yes,width=440", this);
    });
  }
  render() {
    uiOnly("render", () => {
      if (app.stopping || !this.win || this.win.closed) return;
      this.win.MuPDFProgressRender?.();
    });
  }
  reportUIError(stage, error) { uiError(stage, error); }
  update(stage) {
    this.stage = stage;
    app.events.push({ type: "stage", action: this.action, stage, at: Date.now() });
    this.render();
  }
  finish(outcome) {
    this.result = outcome;
    this.stage = outcome.code === "success" ? "Complete" : "Result";
    this.message = outcome.message;
    this.show();
    this.render();
  }
  close() {
    const win = this.win;
    this.win = null;
    uiOnly("close", () => { if (win && !win.closed) win.close(); });
  }
}
function finish(feedback, code, message, changed = false, extra = {}) {
  const outcome = { code, message: message || MESSAGES[code] || MESSAGES.validation,
    changed, autoDismiss: code === "success" || code === "no-benefit", stage: feedback.stage, ...extra };
  app.lastOutcome = outcome;
  app.history.push(outcome);
  // File/metadata state decides the outcome. A dead widget cannot turn a
  // completed operation into a partial replacement or consume recovery state.
  uiOnly("result", () => feedback.finish(outcome));
  try { log(outcome.stage, code); } catch (_) {}
  return outcome;
}
async function prepareOutputDirectory(path) {
  let directory = join(localFile(path).parent.path, ".mupdf-compress-" + uuid());
  checkNoSymlinks(directory, true);
  await IOUtils.makeDirectory(directory, { permissions: 0o700, ignoreExisting: false });
  await IOUtils.setPermissions(directory, 0o700);
  checkNoSymlinks(directory);
  return directory;
}
async function currentMatches(item, path, hash) {
  try { return await attachmentPath(item) === path && fileHash(path) === hash; }
  catch (_) { return false; }
}
async function runOperation(item, action) {
  await app.api.ready;
  let feedback = new Feedback(item, action);
  if (!eligible(item)) return finish(feedback, "ineligible");
  let id = identity(item);
  if (app.stopping) return finish(feedback, "stopped");
  if (app.busy.has(id)) return finish(feedback, "busy", null, null);
  if (app.initializationError) return finish(feedback, app.initializationError === "engine" ? "engine" : "backup");
  if (action === "Compress" && app.records.has(id)) return finish(feedback, "repeated");
  let previous = app.records.get(id);
  if (action === "Revert" && !previous) return finish(feedback, "no-record");
  let resolveDone;
  let done = new Promise(resolve => { resolveDone = resolve; });
  app.busy.set(id, done);
  let path, backupPath, output, outputDir, record, beforeHash, intendedHash;
  let stage = "Preparing", attemptedReplacement = false, installed = false, keepBackup = false, retryMetadata = false;
  try {
    requireLock();
    path = await attachmentPath(item);
    if (app.pathBusy.has(path) && app.pathBusy.get(path) !== id) fail("alias-busy");
    if ([...app.records.values()].some(r => r.id !== id && r.path === path)) fail("alias-compressed");
    app.pathBusy.set(path, id);
    if (action === "Revert") {
      let expected = previous.partial === "restored-awaiting-metadata" ? previous.originalHash : previous.compressedHash;
      if (path !== previous.path || fileHash(path) !== expected) fail("revert-changed");
    }
    if (readerOpen(item)) fail("open");
    beforeHash = fileHash(path);
    if (action === "Revert" && previous.partial === "restored-awaiting-metadata") {
      record = previous;
      backupPath = record.backupPath;
      try { if (fileHash(backupPath) !== record.originalHash) fail("backup-invalid"); }
      catch (_) { fail("backup-invalid"); }
      stage = "Reverting"; feedback.update(stage);
      retryMetadata = true;
      requireLock();
      if (!(await currentMatches(item, path, record.originalHash))) fail("revert-changed");
      await metadata(item);
      await IOUtils.remove(backupPath);
      app.records.delete(id);
      return finish(feedback, "success", "Original PDF restored. The remaining metadata update is now complete.", false);
    }
    if (action === "Compress") {
      stage = "Backing up"; feedback.update(stage);
      backupPath = join(app.sessionDir, uuid() + ".pdf");
      await IOUtils.copy(path, backupPath, { noOverwrite: true });
      await IOUtils.setPermissions(backupPath, 0o600);
      if (fileHash(backupPath) !== beforeHash) fail("backup");
      await hook("afterBackup", { action, item, path, backupPath });
      if (fileHash(backupPath) !== beforeHash) fail("backup");
      record = { id, libraryID: item.libraryID, key: item.key, path, backupPath, originalHash: beforeHash,
        compressedHash: null, partial: null };
      // Check input before producing output; unsupported input never reaches replacement.
      stage = "Inspecting input"; feedback.update(stage);
      await documentInfo(backupPath);
      outputDir = await prepareOutputDirectory(path);
      output = join(outputDir, "output.pdf");
      stage = "Compressing"; feedback.update(stage);
      await nativeRun([...CLEAN, backupPath, output]);
      stage = "Validating"; feedback.update(stage);
      await hook("beforeValidate", { action, item, path, output, record });
      await validate(backupPath, output);
      let originalSize = (await IOUtils.stat(backupPath)).size;
      let outputSize = (await IOUtils.stat(output)).size;
      if (outputSize >= originalSize) return finish(feedback, "no-benefit");
      intendedHash = fileHash(output);
      record.compressedHash = intendedHash;
      record.originalSize = originalSize;
      record.compressedSize = outputSize;
    } else {
      record = previous;
      backupPath = record.backupPath;
      stage = "Reverting"; feedback.update(stage);
      try { if (fileHash(backupPath) !== record.originalHash) fail("backup-invalid"); }
      catch (_) { fail("backup-invalid"); }
      outputDir = await prepareOutputDirectory(path);
      output = join(outputDir, "output.pdf");
      await IOUtils.copy(backupPath, output, { noOverwrite: true });
      if (fileHash(output) !== record.originalHash) fail("backup-invalid");
      intendedHash = record.originalHash;
    }
    // Hook runs before the final checks so tests can exercise real races.
    await hook("beforeReplace", { action, item, path, output, record });
    requireLock();
    if (readerOpen(item)) fail("open");
    if (!(await currentMatches(item, path, beforeHash))) fail(action === "Compress" ? "compress-changed" : "revert-changed");
    try {
      if (fileHash(backupPath) !== record.originalHash) fail(action === "Compress" ? "backup" : "backup-invalid");
    } catch (_) { fail(action === "Compress" ? "backup" : "backup-invalid"); }
    if (fileHash(output) !== intendedHash) fail("validation");
    // Keep original permissions. Renaming changes the inode, not the attachment identity.
    await IOUtils.setPermissions(output, localFile(path).permissions & 0o777);
    stage = action === "Compress" ? "Replacing" : "Reverting"; feedback.update(stage);
    attemptedReplacement = true;
    try {
      await IOUtils.move(output, path);
      installed = fileHash(path) === intendedHash;
      if (!installed) fail("uncertain");
    } catch (e) {
      try { installed = fileHash(path) === intendedHash; } catch (_) {}
      if (!installed) throw e;
    }
    keepBackup = true;
    record.partial = action === "Compress" ? "compressed-awaiting-metadata" : "restored-awaiting-metadata";
    app.records.set(id, record);
    await hook("afterReplaceBeforeMetadata", { action, item, path, output, record });
    await metadata(item);
    if (action === "Compress") {
      record.partial = null;
      let saved = record.originalSize - record.compressedSize;
      return finish(feedback, "success", `Compressed: ${record.originalSize.toLocaleString()} bytes to ${record.compressedSize.toLocaleString()} bytes. Saved ${saved.toLocaleString()} bytes (${(100 * saved / record.originalSize).toFixed(1)}%). Revert is available only during this Zotero session.`, true,
        { originalSize: record.originalSize, finalSize: record.compressedSize, savedBytes: saved });
    }
    await IOUtils.remove(backupPath);
    app.records.delete(id);
    keepBackup = false;
    return finish(feedback, "success", "Original PDF restored.", true);
  } catch (e) {
    let code = e.safeCode || "failure";
    log(stage, code);
    if (retryMetadata && code !== "revert-changed" && code !== "lock-unavailable") {
      return finish(feedback, "partial", "The original PDF remains restored, but the remaining metadata update could not be completed. The verified original backup and session recovery record were retained.", false);
    }
    if (attemptedReplacement) {
      // Classify by verified bytes, never infer unchanged state from a thrown move.
      let currentHash;
      try { currentHash = fileHash(path); } catch (_) {}
      if (currentHash === intendedHash) {
        keepBackup = true;
        record.partial = action === "Compress" ? "compressed-awaiting-metadata" : "restored-awaiting-metadata";
        app.records.set(id, record);
        return finish(feedback, "partial", `The PDF was ${action === "Compress" ? "replaced" : "restored"}, but the remaining operation failed. The verified original backup and session recovery record were retained. See the log for technical details.`, true);
      }
      if (currentHash !== beforeHash) {
        keepBackup = true;
        if (record) { record.partial = "replacement-state-uncertain"; app.records.set(id, record); }
        return finish(feedback, "uncertain", null, null);
      }
    }
    if (["missing", "open", "compress-changed", "revert-changed", "backup", "backup-invalid", "encrypted", "reader-check-unavailable", "lock-unavailable", "alias-busy", "alias-compressed"].includes(code)) {
      return finish(feedback, code, null, code === "alias-busy" ? null : false);
    }
    if (code === "engine-unavailable") return finish(feedback, "engine");
    if (action === "Revert" && stage === "Reverting") return finish(feedback, "backup-invalid");
    if (stage === "Backing up") return finish(feedback, "backup");
    return finish(feedback, stage === "Validating" || stage === "Inspecting input" ? "validation" : "engine");
  } finally {
    if (output) { try { checkNoSymlinks(output); await IOUtils.remove(output, { ignoreAbsent: true }); } catch (_) {} }
    // No recursion: leave unexpected contents instead of broadening cleanup.
    if (outputDir) { try { checkNoSymlinks(outputDir); await IOUtils.remove(outputDir); } catch (_) {} }
    if (path && app.pathBusy.get(path) === id) app.pathBusy.delete(path);
    if (action === "Compress" && backupPath && !keepBackup) {
      try { checkNoSymlinks(backupPath); await IOUtils.remove(backupPath, { ignoreAbsent: true }); } catch (_) {}
    }
    app.busy.delete(id);
    resolveDone();
  }
}
function snapshot() {
  return { ready: app.initialized, initializationError: app.initializationError,
    startupStage: app.startupStage, initializationDiagnostic: app.initializationDiagnostic || null,
    stopping: app.stopping, sessionDir: app.sessionDir, temporaryRoot: app.temporaryRoot,
    lockAlive: !!app.lock?.alive, cleanup: app.cleanup.map(x => ({ ...x })),
    records: [...app.records.values()].map(x => ({ ...x })), busy: [...app.busy.keys()],
    busyPaths: [...app.pathBusy.keys()],
    lastOutcome: app.lastOutcome, history: app.history.map(x => ({ ...x })), events: app.events.map(x => ({ ...x })),
    uiErrors: app.uiErrors.map(x => ({ ...x })) };
}
function addWindow(window) {
  if (!app || app.windows.has(window)) return;
  app.windows.add(window);
  const closeFeedback = () => {
    app.closingWindows.add(window);
    for (let feedback of app.feedback) if (feedback.parent === window) feedback.close();
  };
  window.addEventListener("close", closeFeedback);
  app.windowCloseHandlers.set(window, closeFeedback);
  window.MuPDFCompressPrototype = app.api;
  if (app.menuManager) return;
  let popup = window.document.getElementById("zotero-itemmenu");
  if (!popup) return;
  let menu = window.document.createXULElement("menu");
  menu.id = MENU_ID;
  menu.setAttribute("label", "Compress PDF");
  let children = window.document.createXULElement("menupopup");
  for (let action of ["Compress", "Revert"]) {
    let entry = window.document.createXULElement("menuitem");
    entry.setAttribute("label", action);
    entry.addEventListener("command", () => {
      let items = window.ZoteroPane.getSelectedItems();
      if (items.length === 1) void runOperation(items[0], action);
    });
    children.appendChild(entry);
  }
  menu.appendChild(children);
  let show = event => {
    if (event.target !== popup) return;
    let items = window.ZoteroPane.getSelectedItems();
    menu.hidden = items.length !== 1 || !eligible(items[0]);
  };
  popup.addEventListener("popupshowing", show);
  popup.appendChild(menu);
  app.windowMenus.set(window, { popup, menu, show });
}
function removeWindow(window) {
  let closeHandler = app?.windowCloseHandlers.get(window);
  if (closeHandler) {
    window.removeEventListener("close", closeHandler);
    app.windowCloseHandlers.delete(window);
  }
  for (let feedback of app?.feedback || []) if (feedback.parent === window) feedback.close();
  let info = app?.windowMenus.get(window);
  if (info) { info.popup.removeEventListener("popupshowing", info.show); info.menu.remove(); app.windowMenus.delete(window); }
  if (window.MuPDFCompressPrototype === app?.api) delete window.MuPDFCompressPrototype;
  app?.windows.delete(window);
}
function registerMenu() {
  app.menuManager = typeof Zotero.MenuManager?.registerMenu === "function";
  if (!app.menuManager) return;
  app.registeredMenuID = Zotero.MenuManager.registerMenu({ menuID: MENU_ID, pluginID: PLUGIN_ID, target: "main/library/item",
    menus: [{ menuType: "submenu", onShowing(_event, context) {
      context.menuElem.setAttribute("label", "Compress PDF");
      context.setVisible(context.items.length === 1 && eligible(context.items[0]));
    }, menus: ["Compress", "Revert"].map(action => ({ menuType: "menuitem",
      onShowing(_event, context) { context.menuElem.setAttribute("label", action); },
      onCommand(_event, context) { if (context.items.length === 1) void runOperation(context.items[0], action); }
    })) }] });
}
async function stop() {
  if (app.stopPromise) return app.stopPromise;
  app.stopping = true;
  // Close dependent result windows immediately; they must not keep the app alive
  // while shutdown waits for a running operation and then cleans its backup.
  for (let feedback of app.feedback) feedback.close();
  app.stopPromise = (async () => {
    await app.api.ready;
    await Promise.all([...app.busy.values()]);
    if (app.lock?.alive && app.sessionDir) {
      try { await cleanSession(app.sessionDir, app.lock); }
      catch (_) { log("shutdown", "cleanup-failed"); }
    }
    await releaseLock(app.lock);
    for (let feedback of app.feedback) feedback.close();
    app.records.clear();
  })();
  return app.stopPromise;
}
async function startup({ resourceURI, rootURI }, reason) {
  await Zotero.initializationPromise;
  root = rootURI || resourceURI.spec;
  if (!root.endsWith("/")) root += "/";
  let aom = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = aom.registerChrome(Services.io.newURI(root + "manifest.json"), [
    ["content", "mupdf-compress-prototype", root + "content/"]
  ]);
  app = { native: {}, records: new Map(), busy: new Map(), pathBusy: new Map(), windows: new Set(),
    closingWindows: new WeakSet(), windowCloseHandlers: new Map(), windowMenus: new Map(),
    feedback: new Set(), history: [], events: [], uiErrors: [], cleanup: [], initialized: false, stopping: false,
    initializationError: null, initializationDiagnostic: null, startupStage: "modules",
    sessionDir: null, temporaryRoot: null, lastOutcome: null };
  app.api = { hooks: {}, compress: item => runOperation(item, "Compress"), revert: item => runOperation(item, "Revert"),
    snapshot, closeProgress: () => { for (let feedback of app.feedback) feedback.close(); },
    // Test-only orderly shutdown is exposed for lifecycle checking, not crash recovery.
    testStop: () => { if (Zotero.Prefs.get(PREF + "testMode", true) !== true) fail("test-mode-required"); return stop(); } };
  app.api.ready = (async () => {
    try {
      app.Subprocess = loadModule("resource://gre/modules/Subprocess.sys.mjs", "resource://gre/modules/Subprocess.jsm").Subprocess;
      try { await extractNative(); } catch (e) { app.initializationError = "engine"; throw e; }
      app.startupStage = "session";
      await initSession();
      app.initialized = true;
      app.startupStage = "ready";
    } catch (e) {
      app.initializationError ||= "backup";
      log("startup", app.initializationError);
      // Only resource/session initialization errors, before any PDF operation.
      if (Zotero.Prefs.get(PREF + "testMode", true) === true) {
        app.initializationDiagnostic = { stage: app.startupStage,
          name: String(e.name || "Error"), message: String(e.message || e.safeCode || "unknown") };
        Zotero.debug("[MuPDF prototype startup diagnostic] " + JSON.stringify(app.initializationDiagnostic));
      }
    }
  })();
  registerMenu();
  await Zotero.PreferencePanes.register({ pluginID: PLUGIN_ID, id: "mupdf-compress-prototype-preferences",
    label: "MuPDF Compress prototype", src: root + "content/preferences.xhtml", scripts: [root + "content/preferences.js"] });
  for (let window of Zotero.getMainWindows()) addWindow(window);
  // Zotero awaits these promises before closing the database and exiting.
  Zotero.addShutdownListener(stop);
}
async function onMainWindowLoad({ window }) { if (app) addWindow(window); }
async function onMainWindowUnload({ window }) {
  if (!app) return;
  removeWindow(window);
  if (![...app.windows].some(other => !other.closed)) await stop();
}
async function shutdown(data, reason) {
  if (!app) return;
  await stop();
  for (let window of [...app.windows]) removeWindow(window);
  if (app.registeredMenuID) Zotero.MenuManager.unregisterMenu(app.registeredMenuID);
  Zotero.PreferencePanes.unregister("mupdf-compress-prototype-preferences");
  if (chromeHandle) { chromeHandle.destruct(); chromeHandle = null; }
}
