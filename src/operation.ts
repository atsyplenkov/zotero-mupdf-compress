/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { CLEAN, documentInfo, extractNative, nativeRun, validate } from "./engine";
import { Feedback, closeFeedbackForWindow } from "./feedback";
import { attachmentPath, checkNoSymlinks, fail, fileHash, join, loadModule, localFile, log, uuid } from "./files";
import { type Lock, cleanSession, initSession, releaseLock } from "./session";
import type { Action, Changed, OperationApi, Outcome, SessionRecord, StartupDiagnostic, UiErrorDiagnostic } from "./types";

export type { OperationApi } from "./types";

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
  stopping: boolean;
  initializationError: string | null;
  initializationDiagnostic: StartupDiagnostic | null;
  uiErrors: UiErrorDiagnostic[];
} = {
  native: {},
  records: new Map(),
  busy: new Map(),
  pathBusy: new Map(),
  lock: null,
  sessionDir: null,
  subprocess: null,
  initialized: false,
  stopping: false,
  initializationError: null,
  initializationDiagnostic: null,
  uiErrors: [],
};

function requireLock(): void {
  if (!state.lock?.alive) fail("lock-unavailable");
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

function finish(feedback: Feedback, code: string, message: string, changed: Changed, stage: string): Outcome {
  const outcome: Outcome = {
    code,
    message,
    changed,
    stage,
  };
  log(stage, code);
  feedback.finish(outcome);
  return outcome;
}

async function currentMatches(item: Zotero.Item, path: string, hash: string): Promise<boolean> {
  try {
    return (await attachmentPath(item)) === path && fileHash(path) === hash;
  } catch {
    return false;
  }
}

async function prepareOutputDirectory(path: string): Promise<string> {
  const outputDir = join(localFile(path).parent.path, ".mupdf-compress-" + uuid());
  checkNoSymlinks(outputDir, true);
  await IOUtils.makeDirectory(outputDir, { permissions: 0o700, ignoreExisting: false });
  return outputDir;
}

async function runOperation(item: Zotero.Item, action: Action): Promise<Outcome> {
  const feedback = new Feedback(item, action, state.uiErrors, () => state.stopping);
  if (!eligible(item)) {
    return finish(feedback, "ineligible", "Select exactly one stored or linked PDF attachment. This action did not change the attachment.", false, "Preparing");
  }
  const id = identity(item);
  if (state.stopping) {
    return finish(feedback, "stopped", "The extension is shutting down. This action did not change the attachment.", false, "Preparing");
  }
  if (state.busy.has(id)) {
    return finish(feedback, "busy", "An operation is already running for this attachment. Wait for it to finish.", null, "Preparing");
  }
  if (state.initializationError) {
    return finish(
      feedback,
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
      return finish(feedback, "alias-busy", `An operation is already running for another attachment (${pathOwner}) referencing this PDF. Wait for it to finish.`, null, stage);
    }
    const recordOwner = [...state.records.values()].find((candidate) => candidate.id !== id && candidate.path === path);
    if (recordOwner) {
      return finish(feedback, "alias-compressed", ownerMessage(recordOwner), false, stage);
    }
    previous = state.records.get(id);
    if (action === "Compress" && previous) {
      return finish(feedback, "repeated", "This attachment is already compressed in this session. Revert before compressing again. This action did not change the attachment.", false, stage);
    }
    if (action === "Revert" && !previous) {
      return finish(feedback, "no-record", "Revert is unavailable: no successful compression is recorded for this attachment in this Zotero session. The attachment was not changed.", false, stage);
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
      feedback.update(stage);
      retryMetadata = true;
      requireLock();
      if (!(await currentMatches(item, path, record.originalHash))) fail("revert-changed");
      await metadata(item);
      retryMetadata = false;
      try {
        await IOUtils.remove(backupPath);
      } catch {
        return finish(feedback, "partial", "The metadata update is complete, but the session backup could not be removed. The recovery record was retained.", false, stage);
      }
      state.records.delete(id);
      return finish(feedback, "success", "Original PDF restored. The remaining metadata update is now complete.", false, stage);
    }
    if (!state.sessionDir) fail("backup");
    const mutool = state.native.mutool;
    if (action === "Compress") {
      stage = "Backing up";
      feedback.update(stage);
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
      feedback.update(stage);
      await documentInfo(state.subprocess, mutool, backupPath);
      outputDir = await prepareOutputDirectory(path);
      output = join(outputDir, "output.pdf");
      stage = "Compressing";
      feedback.update(stage);
      await nativeRun(state.subprocess, mutool, [...CLEAN, backupPath, output]);
      stage = "Validating";
      feedback.update(stage);
      await validate(state.subprocess, mutool, backupPath, output);
      const originalSize = (await IOUtils.stat(backupPath)).size ?? 0;
      const outputSize = (await IOUtils.stat(output)).size ?? 0;
      if (!originalSize || outputSize >= originalSize) {
        return finish(feedback, "no-benefit", "No smaller PDF produced. The attachment was not changed.", false, stage);
      }
      intendedHash = fileHash(output);
      record.compressedHash = intendedHash;
      record.originalSize = originalSize;
      record.compressedSize = outputSize;
    } else if (previous) {
      record = previous;
      backupPath = record.backupPath;
      stage = "Reverting";
      feedback.update(stage);
      try {
        if (fileHash(backupPath) !== record.originalHash) fail("backup-invalid");
      } catch {
        fail("backup-invalid");
      }
      outputDir = await prepareOutputDirectory(path);
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
    feedback.update(stage);
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
        feedback,
        "success",
        `Compressed: ${record.originalSize} bytes to ${record.compressedSize} bytes. Saved ${saved} bytes. Revert is available only during this Zotero session.`,
        true,
        stage,
      );
    }
    await IOUtils.remove(backupPath);
    state.records.delete(id);
    keepBackup = false;
    return finish(feedback, "success", "Original PDF restored.", true, stage);
  } catch (error) {
    const code = (error as { safeCode?: string }).safeCode || "failure";
    if (retryMetadata && code !== "revert-changed" && code !== "lock-unavailable") {
      return finish(feedback, "partial", "The original PDF remains restored, but the remaining metadata update could not be completed. The verified original backup and session recovery record were retained.", false, stage);
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
        return finish(feedback, "partial", `The PDF was ${action === "Compress" ? "replaced" : "restored"}, but the remaining operation failed. The verified original backup and session recovery record were retained.`, true, stage);
      }
      if (currentHash !== beforeHash) {
        keepBackup = true;
        record.partial = "replacement-state-uncertain";
        state.records.set(id, record);
        return finish(feedback, "uncertain", "The operation failed during file replacement. The attachment's current state could not be verified.", null, stage);
      }
      return finish(feedback, "replacement-unchanged", "File replacement failed. The attachment bytes were verified unchanged.", false, stage);
    }
    if (code === "open") {
      return finish(feedback, code, "Close this PDF in the Zotero reader and try again. The attachment was not changed.", false, stage);
    }
    if (["missing", "compress-changed", "revert-changed", "backup", "backup-invalid", "encrypted", "reader-check-unavailable", "lock-unavailable"].includes(code)) {
      return finish(feedback, code, "The action was blocked. The attachment was not changed.", false, stage);
    }
    return finish(feedback, stage === "Validating" || stage === "Inspecting input" ? "validation" : "engine", "The bundled PDF engine could not finish. The attachment was not changed.", false, stage);
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
  state.stopping = true;
  closeFeedbackForWindow();
  await Promise.all(state.busy.values());
  const lock = state.lock;
  const sessionDir = state.sessionDir;
  state.lock = null;
  state.sessionDir = null;
  if (lock?.alive && sessionDir) {
    try {
      await cleanSession(sessionDir, lock);
    } catch {
      log("shutdown", "cleanup-failed");
    }
  }
  await releaseLock(lock);
  closeFeedbackForWindow();
  state.records.clear();
}

export function onWindowClose(win: Window): void {
  closeFeedbackForWindow(win);
}

export function createOperation(root: string): OperationApi {
  state.stopping = false;
  state.initialized = false;
  state.initializationError = null;
  state.initializationDiagnostic = null;
  const ready = (async () => {
    try {
      state.subprocess = loadModule(
        "resource://gre/modules/Subprocess.sys.mjs",
        "resource://gre/modules/Subprocess.jsm",
      ).Subprocess;
      try {
        state.initializationDiagnostic = { stage: "read-native-manifest", name: "", code: "" };
        state.native = await extractNative(root);
      } catch (error) {
        state.initializationError = "engine";
        throw error;
      }
      state.initializationDiagnostic = { stage: "session", name: "", code: "" };
      const session = await initSession(state.subprocess, state.native["session-lock"]);
      state.sessionDir = session.sessionDir;
      state.lock = session.lock;
      state.initialized = true;
      state.initializationDiagnostic = null;
    } catch (error) {
      state.initializationError ||= "backup";
      const diagnostic: StartupDiagnostic = {
        stage: state.initializationDiagnostic?.stage || "startup",
        name: String((error as { name?: string }).name || "Error").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64),
        code: String((error as { safeCode?: string }).safeCode || state.initializationError || "startup-failed")
          .replace(/[^A-Za-z0-9_.-]/g, "")
          .slice(0, 64),
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
