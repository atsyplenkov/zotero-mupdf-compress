/* SPDX-License-Identifier: AGPL-3.0-or-later */

const PREF = "extensions.mupdf-compress.temporaryFolder";
const OWNER_MARKER = "MuPDF Compress session v1\n";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLEAN = [
  "clean", "-ggg", "-z", "-Z", "-f", "-i", "-m", "--structure=keep",
  "--color-image-subsample-dpi=150", "--color-image-recompress-method=jpeg:85",
  "--gray-image-subsample-dpi=150", "--gray-image-recompress-method=jpeg:85",
  "--recompress-images-when=smaller",
];

type Action = "Compress" | "Revert";
type Changed = boolean | null;

interface SessionRecord {
  id: string;
  libraryID: number;
  key: string;
  path: string;
  backupPath: string;
  originalHash: string;
  compressedHash: string | null;
  originalSize?: number;
  compressedSize?: number;
  partial: string | null;
}

interface Outcome {
  code: string;
  message: string;
  changed: Changed;
  stage: string;
}

interface Lock {
  proc: { stdin: { close(): Promise<void> }; wait(): Promise<unknown>; kill(): void };
  alive: boolean;
}

export interface OperationApi {
  ready: Promise<void>;
  hooks: Record<string, (context: Record<string, unknown>) => Promise<void> | void>;
  compress(item: Zotero.Item): Promise<Outcome>;
  revert(item: Zotero.Item): Promise<Outcome>;
  snapshot(): {
    ready: boolean;
    initializationError: string | null;
    records: SessionRecord[];
    busy: string[];
    busyPaths: string[];
    uiErrors: Array<{ stage: string; name: string; code: number | null }>;
  };
}

function fail(code: string): never {
  const error = new Error(code) as Error & { safeCode?: string };
  error.safeCode = code;
  throw error;
}

function uuid(): string {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

function component(contract: string): any {
  return (Components.classes as unknown as Record<string, { createInstance(iface: unknown): any }>)[contract];
}

function localFile(path: string): nsIFile {
  const file = component("@mozilla.org/file/local;1").createInstance(Components.interfaces.nsIFile);
  file.initWithPath(path);
  return file;
}

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

function log(stage: string, code: string): void {
  Zotero.debug(`[MuPDF Compress] ${stage}: ${code}`);
}

function eligible(item: Zotero.Item): boolean {
  return !!(
    item &&
    item.isAttachment() &&
    item.attachmentContentType === "application/pdf" &&
    (item.isStoredFileAttachment() || item.isLinkedFileAttachment())
  );
}

function identity(item: Zotero.Item): string {
  return `${item.libraryID}:${item.key}`;
}

function checkNoSymlinks(path: string, allowMissing = false): void {
  if (typeof path !== "string" || !path.startsWith("/") || path.split("/").includes("..")) {
    fail("unsafe-path");
  }
  let current: nsIFile | null = localFile(path);
  while (current) {
    try {
      if (current.isSymlink()) fail("symlink-path");
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (
        !(allowMissing &&
          ["NS_ERROR_FILE_NOT_FOUND", "NS_ERROR_FILE_TARGET_DOES_NOT_EXIST"].includes(name || ""))
      ) {
        throw error;
      }
    }
    if (!allowMissing && !current.exists()) fail("missing-path");
    current = current.parent;
  }
}

function fileHash(path: string): string {
  checkNoSymlinks(path);
  const input = component("@mozilla.org/network/file-input-stream;1").createInstance(
    Components.interfaces.nsIFileInputStream,
  );
  const hash = component("@mozilla.org/security/hash;1").createInstance(
    Components.interfaces.nsICryptoHash,
  );
  input.init(localFile(path), 0x01, 0, 0);
  try {
    hash.init(hash.SHA256);
    hash.updateFromStream(input, 0xffffffff);
    return Array.from(hash.finish(false), (byte: string) => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } finally {
    input.close();
  }
}

function loadModule(esURI: string, jsmURI: string): any {
  try {
    return ChromeUtils.importESModule(esURI);
  } catch {
    return ChromeUtils.import(jsmURI);
  }
}

async function readResourceBytes(uri: string): Promise<Uint8Array> {
  const { NetUtil } = loadModule(
    "resource://gre/modules/NetUtil.sys.mjs",
    "resource://gre/modules/NetUtil.jsm",
  );
  const channel = NetUtil.newChannel({
    uri,
    loadUsingSystemPrincipal: true,
    securityFlags: Components.interfaces.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    contentPolicyType: Components.interfaces.nsIContentPolicy.TYPE_OTHER,
  });
  return new Promise((resolve, reject) => {
    NetUtil.asyncFetch(channel, (stream: any, status: number) => {
      if (!Components.isSuccessCode(status)) {
        reject(new Error("resource-read"));
        return;
      }
      const binary = component("@mozilla.org/binaryinputstream;1").createInstance(
        Components.interfaces.nsIBinaryInputStream,
      );
      binary.setInputStream(stream);
      try {
        resolve(Uint8Array.from(binary.readByteArray(binary.available())));
      } catch (error) {
        reject(error);
      } finally {
        binary.close();
      }
    });
  });
}

const operationHooks: Record<string, (context: Record<string, unknown>) => Promise<void> | void> = {};

const state: {
  native: Record<string, string>;
  records: Map<string, SessionRecord>;
  busy: Map<string, Promise<void>>;
  pathBusy: Map<string, string>;
  lock: Lock | null;
  sessionDir: string | null;
  subprocess: any;
  initialized: boolean;
  initializationError: string | null;
  initializationDiagnostic: { stage: string; name: string; message: string } | null;
  uiErrors: Array<{ stage: string; name: string; code: number | null }>;
} = {
  native: {},
  records: new Map(),
  busy: new Map(),
  pathBusy: new Map(),
  lock: null,
  sessionDir: null,
  subprocess: null,
  initialized: false,
  initializationError: null,
  initializationDiagnostic: null,
  uiErrors: [],
};

async function extractNative(root: string): Promise<void> {
  state.initializationDiagnostic = { stage: "read-native-manifest", name: "", message: "" };
  const native = JSON.parse(new TextDecoder().decode(await readResourceBytes(root + "native/digests.json")));
  const profile = Zotero.getProfileDirectory().path;
  const cache = join(profile, "mupdf-compress", native.mutool.slice(0, 16));
  checkNoSymlinks(cache, true);
  await IOUtils.makeDirectory(cache, { createAncestors: true, permissions: 0o700 });
  checkNoSymlinks(cache);
  for (const name of ["mutool", "session-lock"]) {
    if (!/^[a-f0-9]{64}$/.test(native[name])) fail("native-digest-manifest");
    const path = join(cache, name);
    if (!(await IOUtils.exists(path)) || fileHash(path) !== native[name]) {
      checkNoSymlinks(path, true);
      await IOUtils.write(path, await readResourceBytes(root + "native/" + name), { mode: "overwrite" });
    }
    await IOUtils.setPermissions(path, 0o700);
    if (fileHash(path) !== native[name]) fail("native-digest-mismatch");
    state.native[name] = path;
  }
}

async function drain(pipe: { readString(): Promise<string | undefined> }, keep = false): Promise<string> {
  let text = "";
  for (;;) {
    const chunk = await pipe.readString();
    if (!chunk) break;
    if (keep) {
      text += chunk;
      if (text.length > 4 * 1024 * 1024) fail("engine-output-limit");
    }
  }
  return text;
}

async function nativeRun(args: string[], capture = false): Promise<string> {
  let proc: any;
  try {
    proc = await state.subprocess.call({
      command: state.native.mutool,
      arguments: args,
      stderr: "pipe",
      environmentAppend: true,
      environment: { LC_ALL: "C", LANG: "C" },
    });
    try {
      await proc.stdin.close();
    } catch (error) {
      if ((error as { errorCode?: number }).errorCode !== state.subprocess.ERROR_END_OF_FILE) throw error;
    }
    const [stdout, , result] = await Promise.all([
      drain(proc.stdout, capture),
      drain(proc.stderr),
      proc.wait(),
    ]);
    if (result.exitCode !== 0) fail("engine-exit");
    return stdout;
  } catch (error) {
    if (proc) {
      try {
        proc.kill();
      } catch {
        // The child is already gone.
      }
    }
    fail((error as { safeCode?: string }).safeCode || "engine-unavailable");
  }
}

async function acquireLock(directory: string): Promise<Lock | null> {
  checkNoSymlinks(directory);
  const lockPath = join(directory, "session.lock");
  checkNoSymlinks(lockPath, true);
  let proc: any;
  try {
    proc = await state.subprocess.call({
      command: state.native["session-lock"],
      arguments: [lockPath],
      stderr: "pipe",
    });
    const diagnostic = drain(proc.stderr);
    if ((await proc.stdout.readString(7)) !== "LOCKED\n") fail("lock-unavailable");
    const held: Lock = { proc, alive: true };
    proc.wait().then(() => {
      held.alive = false;
    });
    void diagnostic;
    return held;
  } catch {
    if (proc) {
      try {
        proc.kill();
      } catch {
        // The helper is already gone.
      }
    }
    return null;
  }
}

function requireLock(): void {
  if (!state.lock?.alive) fail("lock-unavailable");
}

async function recognized(directory: string): Promise<boolean> {
  try {
    checkNoSymlinks(directory);
    if (!localFile(directory).isDirectory() || !UUID.test(localFile(directory).leafName)) return false;
    const marker = join(directory, "owner.txt");
    checkNoSymlinks(marker);
    const stat = await IOUtils.stat(marker);
    return stat.type === "regular" && stat.size === OWNER_MARKER.length &&
      (await IOUtils.readUTF8(marker)) === OWNER_MARKER;
  } catch {
    return false;
  }
}

async function cleanSession(directory: string, lock: Lock): Promise<boolean> {
  if (!lock.alive || !(await recognized(directory))) return false;
  const paths = await IOUtils.getChildren(directory);
  for (const path of paths) {
    checkNoSymlinks(path);
    const name = localFile(path).leafName;
    if (
      !localFile(path).isFile() ||
      !(name === "owner.txt" || name === "session.lock" ||
        (/^[a-f0-9-]{36}\.pdf$/.test(name) && UUID.test(name.slice(0, -4))))
    ) {
      return false;
    }
  }
  for (const path of paths.filter((candidate) => !["owner.txt", "session.lock"].includes(localFile(candidate).leafName))) {
    if (!lock.alive) fail("lock-lost-during-cleanup");
    checkNoSymlinks(path);
    await IOUtils.remove(path);
  }
  await IOUtils.remove(join(directory, "owner.txt"));
  await IOUtils.remove(join(directory, "session.lock"));
  await IOUtils.remove(directory);
  return true;
}

function temporaryFolder(): string {
  const selected = Zotero.Prefs.get(PREF, true);
  return typeof selected === "string" && selected ? selected : Zotero.getTempDirectory().path;
}

async function initSession(): Promise<void> {
  const selected = temporaryFolder();
  checkNoSymlinks(selected);
  if (!localFile(selected).isDirectory()) fail("temporary-folder");
  const root = join(selected, "mupdf-compress-v1");
  checkNoSymlinks(root, true);
  await IOUtils.makeDirectory(root, { permissions: 0o700 });
  checkNoSymlinks(root);
  for (const directory of await IOUtils.getChildren(root)) {
    if (!(await recognized(directory))) continue;
    const lock = await acquireLock(directory);
    if (!lock) continue;
    try {
      await cleanSession(directory, lock);
    } catch {
      log("startup", "cleanup-failed");
    } finally {
      try {
        await lock.proc.stdin.close();
        await lock.proc.wait();
      } catch {
        try {
          lock.proc.kill();
        } catch {
          // The helper is already gone.
        }
      }
    }
  }
  state.sessionDir = join(root, uuid());
  await IOUtils.makeDirectory(state.sessionDir, { permissions: 0o700, ignoreExisting: false });
  state.lock = await acquireLock(state.sessionDir);
  if (!state.lock) fail("lock-unavailable");
  await IOUtils.writeUTF8(join(state.sessionDir, "owner.txt"), OWNER_MARKER, { mode: "create" });
}

function sharedReaderOpen(path: string, item: Zotero.Item): boolean {
  const readers = (Zotero.Reader as { _readers?: Array<{ itemID?: number; _item?: Zotero.Item }> } | undefined)
    ?._readers;
  if (!Array.isArray(readers)) fail("reader-check-unavailable");
  return readers.some((reader) => {
    if (reader.itemID === item.id || reader._item?.id === item.id) return true;
    if (!reader._item) return false;
    let otherPath: string | false;
    try {
      otherPath = reader._item.getFilePath();
    } catch {
      fail("reader-check-unavailable");
    }
    return otherPath === path;
  });
}

async function attachmentPath(item: Zotero.Item): Promise<string> {
  const path = await item.getFilePathAsync();
  if (!path || !(await IOUtils.exists(path))) fail("missing");
  checkNoSymlinks(path);
  if (!localFile(path).isFile()) fail("missing");
  return path;
}

async function documentInfo(path: string): Promise<number> {
  const text = await nativeRun(["info", path], true);
  if (/Encryption object/i.test(text)) fail("encrypted");
  const match = text.match(/^Pages:\s*(\d+)\s*$/m);
  if (!match || Number(match[1]) < 1) fail("validation");
  return Number(match[1]);
}

async function validate(input: string, output: string): Promise<void> {
  if (!(await IOUtils.exists(output)) || !(await IOUtils.stat(output)).size) fail("validation");
  if ((await documentInfo(input)) !== (await documentInfo(output))) fail("validation");
  await nativeRun(["draw", "-r", "72", "-F", "ppm", "-o", "/dev/null", input]);
  await nativeRun(["draw", "-r", "72", "-F", "ppm", "-o", "/dev/null", output]);
}

async function hook(name: string, context: Record<string, unknown>): Promise<void> {
  const callback = operationHooks[name];
  if (Zotero.Prefs.get("extensions.mupdf-compress.testMode", true) === true && typeof callback === "function") {
    await callback(context);
  }
}

async function metadata(item: Zotero.Item): Promise<void> {
  if (item.isStoredFileAttachment()) {
    item.attachmentSyncState = "to_upload";
    await item.saveTx({ skipNotifier: true, skipSelect: true, skipDateModifiedUpdate: true });
  }
  await item.getFilePathAsync();
  await Zotero.Notifier.trigger("refresh", "item", item.id);
}

function ownerMessage(owner: SessionRecord): string {
  return `Another attachment (${owner.libraryID}:${owner.key}) referencing this PDF has a session compression record. Revert using that attachment first. This action did not change the attachment.`;
}

function reportUiError(stage: string, error: unknown): void {
  let name = "Error";
  let code: number | null = null;
  try {
    const candidate = error as { name?: string; result?: number; errorCode?: number };
    name = String(candidate?.name || "Error").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64);
    code = Number.isInteger(candidate?.result)
      ? candidate.result!
      : Number.isInteger(candidate?.errorCode)
        ? candidate.errorCode!
        : null;
  } catch {
    // Exception properties can be inaccessible after teardown.
  }
  state.uiErrors.push({ stage, name, code });
  try {
    Zotero.debug(`[MuPDF Compress UI] ${stage}: ${name} code=${code}`);
  } catch {
    // Logging itself can fail during teardown.
  }
}

function finish(code: string, message: string, changed: Changed, stage: string): Outcome {
  const outcome = { code, message, changed, stage };
  log(stage, code);
  try {
    const callback = operationHooks.reportResult;
    if (Zotero.Prefs.get("extensions.mupdf-compress.testMode", true) === true && typeof callback === "function") {
      callback(outcome);
    }
  } catch (error) {
    reportUiError("result", error);
  }
  return outcome;
}

async function currentMatches(item: Zotero.Item, path: string, hash: string): Promise<boolean> {
  try {
    return (await attachmentPath(item)) === path && fileHash(path) === hash;
  } catch {
    return false;
  }
}

async function runOperation(item: Zotero.Item, action: Action): Promise<Outcome> {
  if (!eligible(item)) {
    return finish("ineligible", "Select exactly one stored or linked PDF attachment. This action did not change the attachment.", false, "Preparing");
  }
  const id = identity(item);
  if (state.busy.has(id)) {
    return finish("busy", "An operation is already running for this attachment. Wait for it to finish.", null, "Preparing");
  }
  if (state.initializationError) {
    return finish(
      state.initializationError === "engine" ? "engine" : "backup",
      "The operation could not start. The attachment was not changed.",
      false,
      "Preparing",
    );
  }

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  state.busy.set(id, done);
  let path = "";
  let backupPath = "";
  let output = "";
  let outputDir = "";
  let previous: SessionRecord | undefined;
  let record: SessionRecord | undefined;
  let beforeHash = "";
  let intendedHash = "";
  let stage = "Preparing";
  let attemptedReplacement = false;
  let keepBackup = false;
  let retryMetadata = false;
  try {
    requireLock();
    path = await attachmentPath(item);
    const pathOwner = state.pathBusy.get(path);
    if (pathOwner && pathOwner !== id) {
      return finish("alias-busy", `An operation is already running for another attachment (${pathOwner}) referencing this PDF. Wait for it to finish.`, null, stage);
    }
    const recordOwner = [...state.records.values()].find((candidate) => candidate.id !== id && candidate.path === path);
    if (recordOwner) {
      return finish("alias-compressed", ownerMessage(recordOwner), false, stage);
    }
    previous = state.records.get(id);
    if (action === "Compress" && previous) {
      return finish("repeated", "This attachment is already compressed in this session. Revert before compressing again. This action did not change the attachment.", false, stage);
    }
    if (action === "Revert" && !previous) {
      return finish("no-record", "Revert is unavailable: no successful compression is recorded for this attachment in this Zotero session. The attachment was not changed.", false, stage);
    }
    state.pathBusy.set(path, id);
    if (action === "Revert" && previous) {
      const expected = previous.partial === "restored-awaiting-metadata" ? previous.originalHash : previous.compressedHash;
      if (path !== previous.path || fileHash(path) !== expected) fail("revert-changed");
    }
    if (sharedReaderOpen(path, item)) fail("open");
    beforeHash = fileHash(path);
    if (action === "Revert" && previous?.partial === "restored-awaiting-metadata") {
      record = previous;
      backupPath = record.backupPath;
      try {
        if (fileHash(backupPath) !== record.originalHash) fail("backup-invalid");
      } catch {
        fail("backup-invalid");
      }
      stage = "Reverting";
      retryMetadata = true;
      requireLock();
      if (!(await currentMatches(item, path, record.originalHash))) fail("revert-changed");
      await metadata(item);
      retryMetadata = false;
      try {
        await IOUtils.remove(backupPath);
      } catch {
        return finish("partial", "The metadata update is complete, but the session backup could not be removed. The recovery record was retained.", false, stage);
      }
      state.records.delete(id);
      return finish("success", "Original PDF restored. The remaining metadata update is now complete.", false, stage);
    }
    if (!state.sessionDir) fail("backup");
    if (action === "Compress") {
      stage = "Backing up";
      backupPath = join(state.sessionDir, uuid() + ".pdf");
      await IOUtils.copy(path, backupPath, { noOverwrite: true });
      await IOUtils.setPermissions(backupPath, 0o600);
      if (fileHash(backupPath) !== beforeHash) fail("backup");
      await hook("afterBackup", { action, item, path, backupPath });
      if (fileHash(backupPath) !== beforeHash) fail("backup");
      record = {
        id,
        libraryID: item.libraryID,
        key: item.key,
        path,
        backupPath,
        originalHash: beforeHash,
        compressedHash: null,
        partial: null,
      };
      stage = "Inspecting input";
      await documentInfo(backupPath);
      outputDir = join(localFile(path).parent.path, ".mupdf-compress-" + uuid());
      checkNoSymlinks(outputDir, true);
      await IOUtils.makeDirectory(outputDir, { permissions: 0o700, ignoreExisting: false });
      output = join(outputDir, "output.pdf");
      stage = "Compressing";
      await nativeRun([...CLEAN, backupPath, output]);
      stage = "Validating";
      await validate(backupPath, output);
      const originalSize = (await IOUtils.stat(backupPath)).size ?? 0;
      const outputSize = (await IOUtils.stat(output)).size ?? 0;
      if (!originalSize || outputSize >= originalSize) {
        return finish("no-benefit", "No smaller PDF produced. The attachment was not changed.", false, stage);
      }
      intendedHash = fileHash(output);
      record.compressedHash = intendedHash;
      record.originalSize = originalSize;
      record.compressedSize = outputSize;
    } else if (previous) {
      record = previous;
      backupPath = record.backupPath;
      stage = "Reverting";
      try {
        if (fileHash(backupPath) !== record.originalHash) fail("backup-invalid");
      } catch {
        fail("backup-invalid");
      }
      outputDir = join(localFile(path).parent.path, ".mupdf-compress-" + uuid());
      checkNoSymlinks(outputDir, true);
      await IOUtils.makeDirectory(outputDir, { permissions: 0o700, ignoreExisting: false });
      output = join(outputDir, "output.pdf");
      await IOUtils.copy(backupPath, output, { noOverwrite: true });
      if (fileHash(output) !== record.originalHash) fail("backup-invalid");
      intendedHash = record.originalHash;
    }
    requireLock();
    if (sharedReaderOpen(path, item)) fail("open");
    if (!(await currentMatches(item, path, beforeHash))) fail(action === "Compress" ? "compress-changed" : "revert-changed");
    if (!record || fileHash(output) !== intendedHash) fail("validation");
    await IOUtils.setPermissions(output, localFile(path).permissions & 0o777);
    stage = action === "Compress" ? "Replacing" : "Reverting";
    attemptedReplacement = true;
    try {
      await hook("duringReplace", { action, item, path, output, intendedHash });
      await IOUtils.move(output, path);
      if (fileHash(path) !== intendedHash) fail("uncertain");
    } catch (error) {
      let installed = false;
      try {
        installed = fileHash(path) === intendedHash;
      } catch {
        installed = false;
      }
      if (!installed) throw error;
    }
    keepBackup = true;
    record.partial = action === "Compress" ? "compressed-awaiting-metadata" : "restored-awaiting-metadata";
    state.records.set(id, record);
    await metadata(item);
    if (action === "Compress") {
      record.partial = null;
      const saved = (record.originalSize || 0) - (record.compressedSize || 0);
      return finish(
        "success",
        `Compressed: ${record.originalSize} bytes to ${record.compressedSize} bytes. Saved ${saved} bytes. Revert is available only during this Zotero session.`,
        true,
        stage,
      );
    }
    await IOUtils.remove(backupPath);
    state.records.delete(id);
    keepBackup = false;
    return finish("success", "Original PDF restored.", true, stage);
  } catch (error) {
    const code = (error as { safeCode?: string }).safeCode || "failure";
    if (retryMetadata && code !== "revert-changed" && code !== "lock-unavailable") {
      return finish("partial", "The original PDF remains restored, but the remaining metadata update could not be completed. The verified original backup and session recovery record were retained.", false, stage);
    }
    if (attemptedReplacement && record) {
      let currentHash: string | undefined;
      try {
        currentHash = fileHash(path);
      } catch {
        currentHash = undefined;
      }
      if (currentHash === intendedHash) {
        keepBackup = true;
        record.partial = action === "Compress" ? "compressed-awaiting-metadata" : "restored-awaiting-metadata";
        state.records.set(id, record);
        return finish("partial", `The PDF was ${action === "Compress" ? "replaced" : "restored"}, but the remaining operation failed. The verified original backup and session recovery record were retained.`, true, stage);
      }
      if (currentHash !== beforeHash) {
        keepBackup = true;
        record.partial = "replacement-state-uncertain";
        state.records.set(id, record);
        return finish("uncertain", "The operation failed during file replacement. The attachment's current state could not be verified.", null, stage);
      }
      return finish("replacement-unchanged", "File replacement failed. The attachment bytes were verified unchanged.", false, stage);
    }
    if (code === "open") {
      return finish(code, "Close this PDF in the Zotero reader and try again. The attachment was not changed.", false, stage);
    }
    if (["missing", "compress-changed", "revert-changed", "backup", "backup-invalid", "encrypted", "reader-check-unavailable", "lock-unavailable"].includes(code)) {
      return finish(code, "The action was blocked. The attachment was not changed.", false, stage);
    }
    return finish(stage === "Validating" || stage === "Inspecting input" ? "validation" : "engine", "The bundled PDF engine could not finish. The attachment was not changed.", false, stage);
  } finally {
    if (output) {
      try {
        checkNoSymlinks(output);
        await IOUtils.remove(output, { ignoreAbsent: true });
      } catch {
        // Leave an unexpected output path instead of widening cleanup.
      }
    }
    if (outputDir) {
      try {
        checkNoSymlinks(outputDir);
        await IOUtils.remove(outputDir);
      } catch {
        // Leave unexpected directory contents in place.
      }
    }
    if (path && state.pathBusy.get(path) === id) state.pathBusy.delete(path);
    if (action === "Compress" && backupPath && !keepBackup) {
      try {
        checkNoSymlinks(backupPath);
        await IOUtils.remove(backupPath, { ignoreAbsent: true });
      } catch {
        // A failed backup cleanup must not hide the operation result.
      }
    }
    state.busy.delete(id);
    resolveDone();
  }
}

export async function releaseOperation(): Promise<void> {
  const lock = state.lock;
  state.lock = null;
  if (!lock) return;
  try {
    await lock.proc.stdin.close();
    await lock.proc.wait();
  } catch {
    try {
      lock.proc.kill();
    } catch {
      // The helper is already gone.
    }
  }
  lock.alive = false;
}

export function createOperation(root: string): OperationApi {
  const ready = (async () => {
    try {
      state.subprocess = loadModule(
        "resource://gre/modules/Subprocess.sys.mjs",
        "resource://gre/modules/Subprocess.jsm",
      ).Subprocess;
      try {
        await extractNative(root);
      } catch (error) {
        state.initializationError = "engine";
        throw error;
      }
      await initSession();
      state.initialized = true;
    } catch (error) {
      state.initializationError ||= "backup";
      const diagnostic = {
        stage: state.initializationDiagnostic?.stage || "startup",
        name: String((error as { name?: string }).name || "Error"),
        message: String((error as { message?: string }).message || (error as { safeCode?: string }).safeCode || "unknown"),
      };
      state.initializationDiagnostic = diagnostic;
      log("startup", state.initializationError);
      if (Zotero.Prefs.get("extensions.mupdf-compress.testMode", true) === true) {
        Zotero.debug("[MuPDF Compress startup diagnostic] " + JSON.stringify(diagnostic));
      }
    }
  })();
  return {
    ready,
    hooks: operationHooks,
    compress: (item) => runOperation(item, "Compress"),
    revert: (item) => runOperation(item, "Revert"),
    snapshot: () => ({
      ready: state.initialized,
      initializationError: state.initializationError,
      initializationDiagnostic: state.initializationDiagnostic,
      records: [...state.records.values()].map((record) => ({ ...record })),
      busy: [...state.busy.keys()],
      busyPaths: [...state.pathBusy.keys()],
      uiErrors: state.uiErrors.map((entry) => ({ ...entry })),
    }),
  };
}
