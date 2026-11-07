/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { CLEAN, documentInfo, extractNative, nativeRun, validate } from "./engine";
import { formatByteSize, formatSavedPercent } from "./file-size";
import { attachmentPath, checkNoSymlinks, fail, fileHash, join, loadModule, localFile, log, uuid } from "./files";
import { classifyMove, planCompress, planRevert, reconcileUnverified, type LiveHash } from "./recovery";
import { type Lock, cleanSession, initSession, releaseLock } from "./session";
import { eligible } from "./target";
import { RECOVERY_SENTENCE, type Action, type OperationApi, type Outcome, type SessionRecord, type StartupDiagnostic, type UntouchedCode } from "./types";

export type { OperationApi } from "./types";

const ENGINE_FAILURE = "The bundled PDF engine could not run or finish. The attachment was not changed. See the log for technical details.";
const UNKNOWN_FAILURE = "The operation could not finish. The attachment was not changed.";
const UNRESOLVED = "The previous replacement could not be verified. The verified original backup was retained. The attachment was not changed.";
const ENGINE_CODES = ["engine-unavailable", "engine-exit", "engine-output-limit"];
const BLOCKED_MESSAGES: Record<string, string> = {
  open: "Close this PDF in the Zotero reader and try again. The attachment was not changed.",
  missing: "The attachment file could not be found. Locate it in Zotero and try again. The extension did not change the attachment.",
  encrypted: "The PDF is encrypted. The extension does not ask for a password and does not change encrypted attachments.",
  unreadable: "The PDF could not be read by the bundled engine. The attachment was not changed.",
  "compress-changed": "The attachment changed during compression. The extension did not replace it.",
  "revert-changed": "Revert was blocked because the attachment changed after compression. The extension did not overwrite it.",
  validation: "Compressed output could not be validated. The attachment was not changed.",
  backup: "A verified session backup could not be prepared. The attachment was not changed. Check the temporary folder and try again.",
  "backup-invalid": "The session backup is unavailable or could not be verified. The attachment was not changed.",
  "reader-check-unavailable": "The Zotero reader state could not be checked, so the action was blocked. The attachment was not changed.",
  "lock-unavailable": "The extension could not confirm exclusive ownership of its session folder. The attachment was not changed.",
  "unsafe-path": "The attachment path could not be verified safely. The attachment was not changed.",
  "symlink-path": "The attachment path could not be verified safely. The attachment was not changed.",
  "missing-path": "The attachment path could not be verified safely. The attachment was not changed.",
};

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
  ready: Promise<void> | null;
  initialized: boolean;
  stopping: boolean;
  initializationError: string | null;
  checkedTemporaryFolder: string | null;
  initializationDiagnostic: StartupDiagnostic | null;
} = {
  native: {},
  records: new Map(),
  busy: new Map(),
  pathBusy: new Map(),
  lock: null,
  sessionDir: null,
  subprocess: null,
  ready: null,
  initialized: false,
  stopping: false,
  initializationError: null,
  checkedTemporaryFolder: null,
  initializationDiagnostic: null,
};

let releasePromise: Promise<void> | null = null;

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

async function byteSize(path: string): Promise<number | null> {
  try {
    const size = (await IOUtils.stat(path)).size;
    return typeof size === "number" ? size : null;
  } catch {
    return null;
  }
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

function readLive(path: string): LiveHash {
  try {
    return { kind: "read", hash: fileHash(path) };
  } catch {
    return { kind: "unreadable" };
  }
}

function remember(record: SessionRecord): void {
  state.records.set(record.id, record);
}

function dropRecord(id: string): void {
  state.records.delete(id);
}

function untouched(code: UntouchedCode, message: string, changed: false | null, stage: string, beforeBytes: number | null): Outcome {
  return { code, message, changed, stage, beforeBytes, producedBytes: null };
}

function logFailure(error: unknown, code: string): void {
  if (Zotero.Prefs.get("extensions.mupdf-compress.testMode", true) !== true) return;
  const candidate = error as { name?: string; result?: number; errorCode?: number };
  log(
    "operation-error",
    [candidate?.name || "Error", candidate?.result ?? candidate?.errorCode ?? "", code]
      .map((part) => String(part).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64))
      .join(":"),
  );
}

function knownSize(size: number | undefined): number | null {
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
}

async function moveIntoPlace(item: Zotero.Item, path: string, output: string, beforeHash: string, intendedHash: string): Promise<ReturnType<typeof classifyMove>> {
  try {
    await hook("duringReplace", { item, path, output, intendedHash });
    requireLock();
    await IOUtils.move(output, path);
  } catch {
    return classifyMove(beforeHash, intendedHash, readLive(path));
  }
  return classifyMove(beforeHash, intendedHash, readLive(path));
}

async function finishMetadata(
  record: Extract<SessionRecord, { phase: "restored-awaiting-metadata" }>,
  item: Zotero.Item,
  beforeBytes: number | null,
): Promise<Outcome> {
  const stage = "Reverting";
  try {
    if (fileHash(record.backupPath) !== record.originalHash) fail("backup-invalid");
  } catch (error) {
    if (!(error as { safeCode?: string }).safeCode) fail("backup-invalid");
    throw error;
  }
  requireLock();
  if (!(await currentMatches(item, record.path, record.originalHash))) fail("revert-changed");
  try {
    await metadata(item);
  } catch (error) {
    const code = (error as { safeCode?: string }).safeCode || "";
    if (code === "revert-changed" || code === "lock-unavailable") throw error;
    const before = beforeBytes ?? record.originalSize;
    return {
      code: "partial",
      changed: false,
      message: RECOVERY_SENTENCE.restoredMetadataIncomplete,
      stage,
      beforeBytes: before,
      producedBytes: record.originalSize,
    };
  }
  try {
    await IOUtils.remove(record.backupPath);
  } catch {
    const before = beforeBytes ?? record.originalSize;
    return {
      code: "partial",
      changed: false,
      message: RECOVERY_SENTENCE.metadataDoneBackupRemains,
      stage,
      beforeBytes: before,
      producedBytes: record.originalSize,
    };
  }
  dropRecord(record.id);
  return {
    code: "success",
    changed: false,
    message: "Original PDF restored. The remaining metadata update is now complete.",
    stage,
    beforeBytes: beforeBytes ?? record.originalSize,
    producedBytes: (await byteSize(record.path)) ?? record.originalSize,
  };
}

async function applyMove(
  action: Action,
  item: Zotero.Item,
  record: Extract<SessionRecord, { phase: "compressed" | "compressed-awaiting-metadata" }>,
  output: string,
  beforeHash: string,
  intendedHash: string,
  beforeBytes: number | null,
  producedBytes: number,
): Promise<Outcome> {
  const stage = action === "Compress" ? "Replacing" : "Reverting";
  const moved = await moveIntoPlace(item, record.path, output, beforeHash, intendedHash);
  if (moved.kind === "unchanged") {
    return untouched("replacement-unchanged", "File replacement failed. The attachment bytes were verified unchanged.", false, stage, beforeBytes);
  }
  if (moved.kind === "unverified") {
    remember({ ...record, phase: "replacement-unverified", intended: action === "Compress" ? "compressed" : "restored" });
    return {
      code: "uncertain",
      changed: null,
      message: RECOVERY_SENTENCE.unverified,
      stage,
      beforeBytes,
      producedBytes: null,
    };
  }
  if (action === "Compress") {
    const waiting: SessionRecord = { ...record, phase: "compressed-awaiting-metadata" };
    remember(waiting);
    try {
      await metadata(item);
    } catch {
      return {
        code: "partial",
        changed: true,
        message: RECOVERY_SENTENCE.replacedIncomplete,
        stage,
        beforeBytes: record.originalSize,
        producedBytes: record.compressedSize,
      };
    }
    remember({ ...record, phase: "compressed" });
    const saved = record.originalSize - record.compressedSize;
    return {
      code: "success",
      changed: true,
      message: `Compressed: ${formatByteSize(record.originalSize)} to ${formatByteSize(record.compressedSize)}. Saved ${formatByteSize(saved)} (${formatSavedPercent(record.originalSize, record.compressedSize)}). Revert is available only during this Zotero session.`,
      stage,
      beforeBytes: record.originalSize,
      producedBytes: record.compressedSize,
    };
  }
  const restored: SessionRecord = {
    phase: "restored-awaiting-metadata",
    id: record.id,
    libraryID: record.libraryID,
    key: record.key,
    path: record.path,
    backupPath: record.backupPath,
    originalHash: record.originalHash,
    originalSize: record.originalSize,
  };
  remember(restored);
  try {
    await metadata(item);
  } catch {
    return {
      code: "partial",
      changed: true,
      message: RECOVERY_SENTENCE.restoredIncomplete,
      stage,
      beforeBytes: beforeBytes ?? record.compressedSize,
      producedBytes,
    };
  }
  try {
    await IOUtils.remove(record.backupPath);
  } catch {
    return {
      code: "partial",
      changed: true,
      message: RECOVERY_SENTENCE.metadataDoneBackupRemains,
      stage,
      beforeBytes: beforeBytes ?? record.compressedSize,
      producedBytes,
    };
  }
  dropRecord(record.id);
  return {
    code: "success",
    changed: true,
    message: "Original PDF restored.",
    stage,
    beforeBytes: beforeBytes ?? record.compressedSize,
    producedBytes: (await byteSize(record.path)) ?? producedBytes,
  };
}

async function runOperation(item: Zotero.Item | null, action: Action): Promise<Outcome> {
  let beforeBytes: number | null = null;
  const stage = "Preparing";
  if (!eligible(item)) {
    return untouched("ineligible", "Select exactly one stored or linked PDF attachment. This action did not change the attachment.", false, stage, null);
  }
  const id = identity(item);
  if (state.stopping) {
    return untouched("stopped", "The extension is shutting down. This action did not change the attachment.", false, stage, null);
  }
  if (state.busy.has(id)) {
    return untouched("busy", "An operation is already running for this attachment. Wait for it to finish.", null, stage, null);
  }
  if (state.initializationError) {
    if (state.initializationError === "temporary-folder") {
      const checked = state.checkedTemporaryFolder || "";
      const named = checked ? `: ${checked}` : "";
      return untouched("temporary-folder", `The temporary folder was rejected${named}. The attachment was not changed.`, false, stage, null);
    }
    return untouched(
      state.initializationError === "engine" ? "engine" : "backup",
      state.initializationError === "engine" ? ENGINE_FAILURE : BLOCKED_MESSAGES.backup,
      false,
      stage,
      null,
    );
  }

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  state.busy.set(id, done);
  let path = "";
  let createdBackup = "";
  let output = "";
  let outputDir = "";
  try {
    requireLock();
    path = await attachmentPath(item);
    const measured = await byteSize(path);
    if (measured !== null) beforeBytes = measured;
    const pathOwner = state.pathBusy.get(path);
    if (pathOwner && pathOwner !== id) {
      return untouched("alias-busy", `An operation is already running for another attachment (${pathOwner}) referencing this PDF. Wait for it to finish.`, null, stage, beforeBytes);
    }
    const recordOwner = [...state.records.values()].find((candidate) => candidate.id !== id && candidate.path === path);
    if (recordOwner) return untouched("alias-compressed", ownerMessage(recordOwner), false, stage, beforeBytes);
    let previous = state.records.get(id) ?? null;
    const plan = action === "Compress" ? planCompress(previous) : planRevert(previous);
    if (plan.kind === "stop") {
      const message = plan.code === "repeated"
        ? "This attachment is already compressed in this session. Revert before compressing again. This action did not change the attachment."
        : plan.code === "no-record"
          ? "Revert is unavailable: no successful compression is recorded for this attachment in this Zotero session. The attachment was not changed."
          : plan.code === "unresolved"
            ? UNRESOLVED
            : BLOCKED_MESSAGES[plan.code] ?? UNKNOWN_FAILURE;
      return untouched(plan.code, message, false, stage, beforeBytes);
    }
    state.pathBusy.set(path, id);
    if (sharedReaderOpen(path, item)) fail("open");
    if (!state.sessionDir) fail("backup");
    const mutool = state.native.mutool;

    if (plan.kind === "proceed") {
      createdBackup = join(state.sessionDir, uuid() + ".pdf");
      const beforeHash = fileHash(path);
      try {
        await IOUtils.copy(path, createdBackup, { noOverwrite: true });
        await IOUtils.setPermissions(createdBackup, 0o600);
        if (fileHash(createdBackup) !== beforeHash) fail("backup");
      } catch (error) {
        if (!(error as { safeCode?: string }).safeCode) fail("backup");
        throw error;
      }
      await hook("afterBackup", { action, item, path, backupPath: createdBackup });
      if (fileHash(createdBackup) !== beforeHash) fail("backup");
      await documentInfo(state.subprocess, mutool, createdBackup);
      outputDir = await prepareOutputDirectory(path);
      output = join(outputDir, "output.pdf");
      await nativeRun(state.subprocess, mutool, [...CLEAN, createdBackup, output]);
      await hook("afterCompress", { action, item, path, backupPath: createdBackup, output });
      await validate(state.subprocess, mutool, createdBackup, output);
      const originalSize = knownSize((await IOUtils.stat(createdBackup)).size);
      const compressedSize = knownSize((await IOUtils.stat(output)).size);
      if (originalSize === null || originalSize <= 0 || compressedSize === null) fail("validation");
      if (compressedSize >= originalSize) {
        return {
          code: "no-benefit",
          changed: false,
          message: "No smaller PDF produced. The attachment was not changed.",
          stage: "Validating",
          beforeBytes: originalSize,
          producedBytes: compressedSize,
        };
      }
      const intendedHash = fileHash(output);
      requireLock();
      if (sharedReaderOpen(path, item)) fail("open");
      if (!(await currentMatches(item, path, beforeHash))) fail("compress-changed");
      if (fileHash(createdBackup) !== beforeHash) fail("backup");
      if (fileHash(output) !== intendedHash) fail("validation");
      const record: SessionRecord = {
        phase: "compressed",
        id,
        libraryID: item.libraryID,
        key: item.key,
        path,
        backupPath: createdBackup,
        originalHash: beforeHash,
        originalSize,
        compressedHash: intendedHash,
        compressedSize,
      };
      await IOUtils.setPermissions(output, localFile(path).permissions & 0o777);
      return await applyMove("Compress", item, record, output, beforeHash, intendedHash, beforeBytes, compressedSize);
    }

    if (!previous) return untouched("no-record", "Revert is unavailable: no successful compression is recorded for this attachment in this Zotero session. The attachment was not changed.", false, stage, beforeBytes);

    if (plan.kind === "finish-metadata") {
      if (previous.phase !== "restored-awaiting-metadata") fail("revert-changed");
      if (path !== previous.path) fail("revert-changed");
      return await finishMetadata(previous, item, beforeBytes);
    }

    if (plan.kind === "reconcile") {
      if (previous.phase !== "replacement-unverified") fail("revert-changed");
      const klass = reconcileUnverified(previous, path, readLive);
      if (klass.kind === "path-changed") fail("revert-changed");
      if (klass.kind === "still-unverified") {
        return {
          code: "uncertain",
          changed: null,
          message: RECOVERY_SENTENCE.unverified,
          stage: "Reverting",
          beforeBytes,
          producedBytes: null,
        };
      }
      if (klass.kind === "previous-still-installed" && previous.intended === "compressed") {
        dropRecord(previous.id);
        await tryRemoveOwned(previous.backupPath, true);
        return untouched("replacement-unchanged", "File replacement failed. The attachment bytes were verified unchanged.", false, "Reverting", beforeBytes);
      }
      if (previous.intended === "restored" && klass.kind === "intended-landed") {
        const restored: SessionRecord = {
          phase: "restored-awaiting-metadata",
          id: previous.id,
          libraryID: previous.libraryID,
          key: previous.key,
          path: previous.path,
          backupPath: previous.backupPath,
          originalHash: previous.originalHash,
          originalSize: previous.originalSize,
        };
        remember(restored);
        return await finishMetadata(restored, item, beforeBytes);
      }
      const ready: SessionRecord = { ...previous, phase: "compressed-awaiting-metadata" };
      remember(ready);
      previous = ready;
    }

    if (previous.phase !== "compressed" && previous.phase !== "compressed-awaiting-metadata") fail("revert-changed");
    if (path !== previous.path || fileHash(path) !== previous.compressedHash) fail("revert-changed");
    try {
      if (fileHash(previous.backupPath) !== previous.originalHash) fail("backup-invalid");
    } catch (error) {
      if (!(error as { safeCode?: string }).safeCode) fail("backup-invalid");
      throw error;
    }
    outputDir = await prepareOutputDirectory(path);
    output = join(outputDir, "output.pdf");
    await IOUtils.copy(previous.backupPath, output, { noOverwrite: true });
    if (fileHash(output) !== previous.originalHash) fail("backup-invalid");
    requireLock();
    if (sharedReaderOpen(path, item)) fail("open");
    if (!(await currentMatches(item, path, previous.compressedHash))) fail("revert-changed");
    await IOUtils.setPermissions(output, localFile(path).permissions & 0o777);
    return await applyMove("Revert", item, previous, output, previous.compressedHash, previous.originalHash, beforeBytes, previous.originalSize);
  } catch (error) {
    const code = (error as { safeCode?: string }).safeCode || "";
    logFailure(error, code);
    if (ENGINE_CODES.includes(code)) return untouched("engine", ENGINE_FAILURE, false, stage, beforeBytes);
    const known = BLOCKED_MESSAGES[code];
    if (known) return untouched(code as UntouchedCode, known, false, stage, beforeBytes);
    return untouched("failure", UNKNOWN_FAILURE, false, stage, beforeBytes);
  } finally {
    if (output) await tryRemoveOwned(output, true);
    if (outputDir) await tryRemoveOwned(outputDir);
    if (path && state.pathBusy.get(path) === id) state.pathBusy.delete(path);
    if (createdBackup && ![...state.records.values()].some((record) => record.backupPath === createdBackup)) {
      await tryRemoveOwned(createdBackup, true);
    }
    state.busy.delete(id);
    resolveDone();
  }
}

async function tryRemoveOwned(path: string, ignoreAbsent = false): Promise<void> {
  try {
    checkNoSymlinks(path);
    if (ignoreAbsent) await IOUtils.remove(path, { ignoreAbsent: true });
    else await IOUtils.remove(path);
  } catch {
    return;
  }
}

export function hasSessionBackup(id: string): boolean {
  return state.records.has(id);
}

export function releaseOperation(): Promise<void> {
  state.stopping = true;
  if (!releasePromise) {
    releasePromise = (async () => {
      if (state.ready) await state.ready;
      await Promise.allSettled(state.busy.values());
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
      state.records.clear();
    })();
  }
  return releasePromise;
}

export function createOperation(root: string): OperationApi {
  state.stopping = false;
  state.initialized = false;
  state.initializationError = null;
  state.checkedTemporaryFolder = null;
  state.initializationDiagnostic = null;
  releasePromise = null;
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
      if (!state.initializationError) {
        const code = (error as { safeCode?: string }).safeCode;
        if (code === "temporary-folder") {
          state.initializationError = "temporary-folder";
          const checked = (error as { checkedPath?: string }).checkedPath;
          state.checkedTemporaryFolder = typeof checked === "string" ? checked : "";
        } else {
          state.initializationError = "backup";
        }
      }
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
  state.ready = ready;
  return {
    ready,
    hooks: operationHooks,
    compress: (item) => runOperation(item, "Compress"),
    revert: (item) => runOperation(item, "Revert"),
    snapshot: () => ({
      ready: state.initialized,
      initializationError: state.initializationError,
      initializationDiagnostic: state.initializationDiagnostic,
      lockPid: state.lock?.proc?.pid ?? null,
      lockAlive: state.lock?.alive ?? false,
      records: [...state.records.values()].map((record) => ({ ...record })),
      busy: [...state.busy.keys()],
      busyPaths: [...state.pathBusy.keys()],
    }),
  };
}
