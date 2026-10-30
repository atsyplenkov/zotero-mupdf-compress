/* SPDX-License-Identifier: AGPL-3.0-or-later
 * THROWAWAY: execute only through the disposable-profile test driver.
 * All file writes are to new fixture copies, imported storage, or known backups.
 */
async function runMuPDFIntegration(api, request, env) {
  const { work, local, evidencePath, window: win } = env;
  const fixtures = PathUtils.join(local, "fixtures");
  const runDir = PathUtils.join(work, "integration-files-" + request.runID);
  await IOUtils.makeDirectory(runDir, { ignoreExisting: false, permissions: 0o700 });
  const report = {
    runID: request.runID, mode: request.mode, started: new Date().toISOString(),
    zoteroVersion: Zotero.version, profile: Zotero.Profile.dir,
    data: Zotero.DataDirectory.dir, status: "running", checks: [], items: [], actions: [],
    limits: [
      "Synthetic PDFs do not establish visual quality on real papers.",
      "No live sync/network test; only local stored-file upload state is checked.",
      "No Zotero 7 compatibility check.",
      "No visual-equivalence or unexpected-blank threshold check; invalid PDF output injection is available with --faults.",
      "Shutdown, crash and concurrent-session cleanup require separate host checks.",
    ],
  };
  const save = () => IOUtils.writeJSON(evidencePath, report);
  await save();
  const ascii = value => Uint8Array.from(value, character => character.charCodeAt(0));
  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }
  async function check(name, fn) {
    const entry = { name, started: new Date().toISOString() };
    report.checks.push(entry);
    await save();
    try {
      entry.details = await fn();
      entry.status = "pass";
    } catch (error) {
      entry.status = error.name === "HarnessSkip" ? "skipped" : "fail";
      entry.error = { name: error.name, message: String(error.message) };
    }
    entry.finished = new Date().toISOString();
    await save();
    return entry.status === "pass";
  }
  function skip(message) {
    const error = new Error(message);
    error.name = "HarnessSkip";
    throw error;
  }
  async function hash(path) {
    const bytes = await IOUtils.read(path);
    const digest = Components.classes["@mozilla.org/security/hash;1"]
      .createInstance(Components.interfaces.nsICryptoHash);
    digest.init(digest.SHA256);
    digest.update(bytes, bytes.length);
    return Array.from(digest.finish(false), x => x.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  }
  function state() {
    const value = typeof api.snapshot === "function" ? api.snapshot()
      : typeof api.state === "function" ? api.state() : api.state;
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  }
  function records() {
    const snapshot = state();
    const value = snapshot?.records ?? snapshot?.reverts ?? [];
    return Array.isArray(value) ? value : Object.values(value);
  }
  function record(item) {
    return records().find(r => r.itemID === item.id || r.id === item.id
      || r.key === item.key || r.attachmentKey === item.key
      || r.identity === item.libraryID + ":" + item.key);
  }
  function backupPath(item) {
    const found = record(item);
    const path = found?.backupPath ?? found?.backup;
    if (!path) skip("API state does not expose this attachment's backup path");
    assert(path.startsWith(local + "/"), "Refusing backup mutation outside .local-test");
    return path;
  }
  async function action(kind, item) {
    let result;
    try { result = { resolved: true, value: await api[kind](item) }; }
    catch (error) { result = { resolved: false, error: { name: error.name, message: String(error.message) } }; }
    report.actions.push({ kind, itemID: item.id, key: item.key,
      finished: new Date().toISOString(), ...result });
    await save();
    return result;
  }
  function outcome(result, code) {
    assert(result.resolved && result.value?.code === code,
      "Expected outcome " + code + ", received " + JSON.stringify(result));
  }
  async function withHook(name, callback, fn) {
    if (!api.hooks) skip("Prototype has no test-hook interface");
    const pref = "extensions.mupdf-compress-prototype.testMode";
    const oldPref = Zotero.Prefs.get(pref, true);
    const oldHook = api.hooks[name];
    Zotero.Prefs.set(pref, true, true);
    api.hooks[name] = callback;
    try { return await fn(); }
    finally {
      if (oldHook === undefined) delete api.hooks[name];
      else api.hooks[name] = oldHook;
      if (oldPref === undefined) Zotero.Prefs.clear(pref, true);
      else Zotero.Prefs.set(pref, oldPref, true);
    }
  }
  async function attachment(mode, fixture = "image-heavy.pdf", label = mode, collectionID) {
    const file = PathUtils.join(runDir, Zotero.Utilities.randomString(12) + "-" + fixture);
    await IOUtils.copy(PathUtils.join(fixtures, fixture), file, { noOverwrite: true });
    const options = { file, title: "PROTOTYPE #9 " + request.runID + " " + label,
      contentType: "application/pdf", libraryID: Zotero.Libraries.userLibraryID,
      ...(collectionID ? { collections: [collectionID] } : {}) };
    const item = mode === "stored"
      ? await Zotero.Attachments.importFromFile(options)
      : await Zotero.Attachments.linkFromFile(options);
    const path = await item.getFilePathAsync();
    const info = {
      id: item.id, key: item.key, libraryID: item.libraryID, mode, fixture,
      path, attachmentPath: item.attachmentPath, originalHash: await hash(path),
      originalSize: (await IOUtils.stat(path)).size,
    };
    report.items.push(info);
    await save();
    return { item, info };
  }
  async function aliasOf(item, info, label) {
    const alias = await Zotero.Attachments.linkFromFile({ file: info.path,
      title: "PROTOTYPE #9 " + request.runID + " " + label,
      contentType: "application/pdf", libraryID: Zotero.Libraries.userLibraryID });
    const aliasInfo = { ...info, id: alias.id, key: alias.key, mode: "linked",
      attachmentPath: alias.attachmentPath, aliasOf: item.id };
    report.items.push(aliasInfo);
    await save();
    assert(alias.id !== item.id, "Alias reused the original attachment item");
    assert(await alias.getFilePathAsync() === info.path, "Alias does not reference the same resolved path");
    return { item: alias, info: aliasInfo };
  }
  async function identity(item, info) {
    assert(item.id === info.id && item.key === info.key, "Attachment identity changed");
    assert(item.attachmentPath === info.attachmentPath, "Stored attachmentPath changed");
    assert(await item.getFilePathAsync() === info.path, "Resolved file path changed");
    assert(Zotero.Items.get(item.id) === item, "Attachment item was replaced");
  }
  async function compressed(item, info) {
    await identity(item, info);
    const latest = report.actions.filter(x => x.itemID === item.id).at(-1);
    assert(await hash(info.path) !== info.originalHash,
      "Expected smaller compressed bytes; latest action: " + JSON.stringify(latest));
    assert((await IOUtils.stat(info.path)).size < info.originalSize, "Output is not smaller");
    assert(record(item), "Successful compression has no session Revert record");
  }
  async function original(item, info) {
    await identity(item, info);
    assert(await hash(info.path) === info.originalHash, "Original bytes were not restored");
  }

  // These preconditions prevent accidental execution against a personal library.
  assert(Zotero.Profile.dir === request.expectedProfile, "Profile mismatch");
  assert(Zotero.DataDirectory.dir === request.expectedData, "Data directory mismatch");
  assert(!Zotero.Prefs.get("sync.autoSync"), "Auto-sync must be disabled");
  assert(!Zotero.Prefs.get("sync.storage.enabled"), "File sync must be disabled");
  assert(state()?.ready === true, "Prototype startup did not finish successfully: " + state()?.initializationError);

  if (request.mode === "restart-check") {
    assert(/^[A-Za-z0-9_-]{1,80}$/.test(request.previousRun || ""), "Invalid previous run ID");
    const previous = await IOUtils.readJSON(PathUtils.join(work, "integration-" + request.previousRun + ".json"));
    await check("restart has no cross-session Revert", async () => {
      const seed = previous.sessionSeed;
      assert(seed, "Previous evidence has no sessionSeed");
      const item = Zotero.Items.getByLibraryAndKey(seed.libraryID, seed.key);
      assert(item, "Seed attachment missing");
      const before = await hash(seed.path);
      assert(before === seed.compressedHash, "Seed compressed bytes changed between launches");
      const result = await action("revert", item);
      outcome(result, "no-record");
      assert(await hash(seed.path) === before, "Cross-session Revert changed attachment");
      assert(!record(item), "Old session record survived restart");
      return { result, hash: before, oldSession: previous.finalState };
    });
    await check("restart removes previous session directory in the selected temporary root", async () => {
      const old = previous.finalState;
      const current = state();
      assert(old?.sessionDir && current?.sessionDir, "Missing session directories in snapshots");
      assert(old.sessionDir !== current.sessionDir, "Restart reused an earlier session directory");
      if (old.temporaryRoot !== current.temporaryRoot) {
        skip("Temporary root changed; old-root cleanup is intentionally out of scope");
      }
      assert(old.sessionDir.startsWith(local + "/"), "Refusing old-session inspection outside .local-test");
      assert(!(await IOUtils.exists(old.sessionDir)), "Previous owned session directory remains");
      const backup = previous.sessionSeed?.record?.backupPath;
      assert(backup && backup.startsWith(old.sessionDir + "/"), "Missing prior seed backup path");
      assert(!(await IOUtils.exists(backup)), "Previous seed backup remains");
      return { previousSession: old.sessionDir, currentSession: current.sessionDir,
        cleanup: current.cleanup };
    });
  } else if (request.mode === "seed-session") {
    await check("leave successful compression for shutdown/crash check", async () => {
      const { item, info } = await attachment("stored", "image-heavy.pdf", "session seed");
      const result = await action("compress", item);
      await compressed(item, info);
      report.sessionSeed = { ...info, compressedHash: await hash(info.path), record: record(item) };
      return result;
    });
  } else if (["review-session", "shutdown-busy"].includes(request.mode)) {
    await runMuPDFLifecycleMode(request.mode, { api, request, report, env, runDir,
      state, save, check, assert, skip, action, outcome, attachment, compressed,
      original, record, hash, withHook });
  } else {
    for (const mode of ["stored", "linked"]) {
      await check(mode + ": Compress, repeated Compress, Revert, timestamp-only Revert", async () => {
        const { item, info } = await attachment(mode);
        if (mode === "stored") {
          // Synthetic last-synced metadata proves compression does not erase preconditions.
          item.attachmentSyncedHash = "0123456789abcdef0123456789abcdef";
          item.attachmentSyncedModificationTime = 1234567890000;
          item.attachmentSyncState = "in_sync";
          await item.saveTx({ skipAll: true });
        }
        const syncBefore = {
          state: item.attachmentSyncState, hash: item.attachmentSyncedHash,
          mtime: item.attachmentSyncedModificationTime,
        };
        const first = await action("compress", item);
        await compressed(item, info);
        const installedHash = await hash(info.path);
        const firstRecord = JSON.stringify(record(item));
        if (mode === "stored") {
          assert(item.attachmentSyncState === Zotero.Sync.Storage.Local.SYNC_STATE_TO_UPLOAD, "Stored PDF not marked to_upload");
          assert(item.attachmentSyncedHash === syncBefore.hash, "Last-synced hash changed");
          assert(item.attachmentSyncedModificationTime === syncBefore.mtime, "Last-synced mtime changed");
        } else {
          assert(item.attachmentSyncState === syncBefore.state, "Linked sync state changed");
          assert(item.attachmentSyncedHash === syncBefore.hash, "Linked synced hash changed");
          assert(item.attachmentSyncedModificationTime === syncBefore.mtime, "Linked synced mtime changed");
        }
        const repeated = await action("compress", item);
        outcome(repeated, "repeated");
        assert(await hash(info.path) === installedHash, "Repeated Compress modified attachment");
        assert(JSON.stringify(record(item)) === firstRecord, "Repeated Compress changed backup record");
        const reverted = await action("revert", item);
        await original(item, info);
        assert(!record(item), "Successful Revert did not consume record");
        const again = await action("compress", item);
        await compressed(item, info);
        const compressedHash = await hash(info.path);
        await IOUtils.setModificationTime(info.path, Date.now() + 120000);
        assert(await hash(info.path) === compressedHash, "Timestamp test changed content");
        const timestampRevert = await action("revert", item);
        await original(item, info);
        return { first, repeated, reverted, again, timestampRevert, syncBefore };
      });
    }

    await check("linked aliases share one compression owner per resolved path", async () => {
      const { item, info } = await attachment("linked", "image-heavy.pdf", "alias owner");
      const alias = await aliasOf(item, info, "alias duplicate");
      const first = await action("compress", item);
      outcome(first, "success");
      await compressed(item, info);
      const installedHash = await hash(info.path);
      const ownerRecord = JSON.stringify(record(item));
      const blocked = await action("compress", alias.item);
      outcome(blocked, "alias-compressed");
      assert(blocked.value.changed === false, "Blocked alias action reports a replacement");
      assert(await hash(info.path) === installedHash, "Alias Compress changed shared bytes");
      assert(!record(alias.item), "Alias Compress created a second recovery record");
      assert(JSON.stringify(record(item)) === ownerRecord, "Alias Compress replaced the owner's record");
      const unavailable = await action("revert", alias.item);
      outcome(unavailable, "no-record");
      assert(await hash(info.path) === installedHash, "Alias Revert overwrote shared bytes");
      outcome(await action("revert", item), "success");
      await original(item, info);
      await original(alias.item, alias.info);
      const aliasFirst = await action("compress", alias.item);
      outcome(aliasFirst, "success");
      await compressed(alias.item, alias.info);
      outcome(await action("compress", item), "alias-compressed");
      outcome(await action("revert", alias.item), "success");
      await original(item, info);
      assert(!record(item) && !record(alias.item), "Alias workflow left recovery records behind");
      return { first, blocked, unavailable, aliasFirst };
    });

    await check("changed bytes block Revert without overwrite", async () => {
      const { item, info } = await attachment("linked", "image-heavy.pdf", "changed bytes");
      await action("compress", item);
      await compressed(item, info);
      const installed = await IOUtils.read(info.path);
      const changed = new Uint8Array(installed.length + 16);
      changed.set(installed);
      changed.set(ascii("\n% changed test\n"), installed.length);
      await IOUtils.write(info.path, changed);
      const changedHash = await hash(info.path);
      const result = await action("revert", item);
      outcome(result, "revert-changed");
      assert(await hash(info.path) === changedHash, "Changed file was overwritten");
      assert(record(item), "Blocked Revert consumed its record");
      // Return only the synthetic modification to the known installed bytes for cleanup.
      await IOUtils.write(info.path, installed);
      const retry = await action("revert", item);
      await original(item, info);
      return { result, retry };
    });

    await check("missing, corrupt, then restored backup permits retry", async () => {
      const { item, info } = await attachment("linked", "image-heavy.pdf", "backup protection");
      await action("compress", item);
      await compressed(item, info);
      const installedHash = await hash(info.path);
      const backup = backupPath(item);
      const held = PathUtils.join(runDir, "held-original.pdf");
      await IOUtils.move(backup, held, { noOverwrite: true });
      let missing, corrupt;
      try {
        missing = await action("revert", item);
        assert(await hash(info.path) === installedHash, "Missing-backup Revert changed attachment");
        assert(record(item), "Missing-backup Revert consumed record");
        await IOUtils.write(backup, ascii("corrupt test backup"));
        corrupt = await action("revert", item);
        assert(await hash(info.path) === installedHash, "Corrupt-backup Revert changed attachment");
        assert(record(item), "Corrupt-backup Revert consumed record");
      } finally {
        await IOUtils.move(held, backup);
      }
      const retry = await action("revert", item);
      await original(item, info);
      return { missing, corrupt, retry };
    });

    await check("missing attachment blocks Revert", async () => {
      const { item, info } = await attachment("linked", "image-heavy.pdf", "missing attachment");
      await action("compress", item);
      await compressed(item, info);
      const held = PathUtils.join(runDir, "held-compressed.pdf");
      await IOUtils.move(info.path, held, { noOverwrite: true });
      let result;
      try {
        result = await action("revert", item);
        assert(!(await IOUtils.exists(info.path)), "Missing attachment was recreated by Revert");
        assert(record(item), "Missing-file Revert consumed record");
      } finally {
        await IOUtils.move(held, info.path, { noOverwrite: true });
      }
      await action("revert", item);
      await original(item, info);
      return result;
    });

    await check("changed resolved path blocks Revert", async () => {
      const { item, info } = await attachment("linked", "image-heavy.pdf", "changed path");
      await action("compress", item);
      await compressed(item, info);
      const newPath = PathUtils.join(runDir, "relocated.pdf");
      await IOUtils.copy(info.path, newPath, { noOverwrite: true });
      item.attachmentPath = newPath;
      await item.saveTx();
      const before = await hash(newPath);
      let result;
      try {
        result = await action("revert", item);
        assert(await hash(newPath) === before, "Changed-path Revert overwrote file");
        assert(record(item), "Changed-path Revert consumed record");
      } finally {
        item.attachmentPath = info.attachmentPath;
        await item.saveTx();
      }
      await action("revert", item);
      await original(item, info);
      return result;
    });

    await check("open reader blocks Compress and Revert", async () => {
      const { item, info } = await attachment("stored", "image-heavy.pdf", "reader guard");
      let reader = await Zotero.Reader.open(item.id, undefined, { openInBackground: true });
      assert(reader && reader.tabID, "Reader did not open a test tab");
      let compressBlocked, revertBlocked;
      try {
        assert(Zotero.Reader._readers.some(r => r.itemID === item.id), "Reader not registered");
        compressBlocked = await action("compress", item);
        outcome(compressBlocked, "open");
        await original(item, info);
        assert(!record(item), "Open-reader Compress created Revert state");
      } finally {
        reader.close();
        await Zotero.Promise.delay(300);
      }
      await action("compress", item);
      await compressed(item, info);
      const installedHash = await hash(info.path);
      reader = await Zotero.Reader.open(item.id, undefined, { openInBackground: true });
      assert(reader && reader.tabID, "Reader did not reopen test tab");
      try {
        revertBlocked = await action("revert", item);
        outcome(revertBlocked, "open");
        assert(await hash(info.path) === installedHash, "Open-reader Revert changed attachment");
        assert(record(item), "Open-reader Revert consumed record");
      } finally {
        reader.close();
        await Zotero.Promise.delay(300);
      }
      await action("revert", item);
      await original(item, info);
      return { compressBlocked, revertBlocked, readerTabOpened: true };
    });

    await check("native Zotero highlight and note retain identity and positions", async () => {
      const { item, info } = await attachment("stored", "annotated.pdf", "annotations");
      const annotations = [];
      for (const type of ["highlight", "note"]) {
        const annotation = await Zotero.Annotations.saveFromJSON(item, {
          key: Zotero.DataObjectUtilities.generateKey(), type,
          text: type === "highlight" ? "Synthetic highlight" : undefined,
          comment: "PROTOTYPE synthetic " + type, color: "#ffd400",
          pageLabel: "1", sortIndex: "00000|000000|00000",
          position: { pageIndex: 0, rects: type === "highlight"
            ? [[72, 700, 180, 714]] : [[190, 700, 210, 720]] },
        });
        annotations.push({ id: annotation.id, key: annotation.key,
          position: annotation.annotationPosition, sortIndex: annotation.annotationSortIndex });
      }
      const verify = () => {
        for (const before of annotations) {
          const after = Zotero.Items.get(before.id);
          assert(after && after.key === before.key && after.parentID === item.id, "Native annotation identity changed");
          assert(after.annotationPosition === before.position, "Native annotation position changed");
          assert(after.annotationSortIndex === before.sortIndex, "Native annotation order changed");
        }
      };
      const result = await action("compress", item);
      assert(result.resolved && ["success", "no-benefit"].includes(result.value?.code),
        "Readable annotated fixture failed: " + JSON.stringify(result));
      await identity(item, info);
      verify();
      const changed = await hash(info.path) !== info.originalHash;
      if (changed) {
        await compressed(item, info);
        await action("revert", item);
      }
      await original(item, info);
      verify();
      return { result, changed, annotations };
    });

    for (const fixture of ["text-vector.pdf", "blank.pdf", "damaged-recoverable.pdf",
      "encrypted.pdf", "damaged-unreadable.pdf"]) {
      await check("corpus: " + fixture, async () => {
        const { item, info } = await attachment("linked", fixture, "corpus " + fixture);
        const result = await action("compress", item);
        await identity(item, info);
        const changed = await hash(info.path) !== info.originalHash;
        if (["encrypted.pdf", "damaged-unreadable.pdf"].includes(fixture)) {
          assert(!changed, "Unsupported input was replaced");
          assert(!record(item), "Unsupported input gained Revert state");
        } else if (changed) {
          outcome(result, "success");
          await compressed(item, info);
          await action("revert", item);
          await original(item, info);
        } else {
          outcome(result, "no-benefit");
          assert(!record(item), "Unchanged input gained Revert state");
        }
        return { result, changed };
      });
    }

    if (request.faults) {
      await check("validated equal-size output reports no benefit without replacement", async () => {
        const { item, info } = await attachment("linked", "image-heavy.pdf", "no benefit");
        const result = await withHook("beforeValidate", async context => {
          if (context.item.id === item.id) await IOUtils.copy(context.record.backupPath, context.output);
        }, () => action("compress", item));
        outcome(result, "no-benefit");
        await original(item, info);
        assert(!record(item), "No-benefit result gained a Revert record");
        return result;
      });
      await check("invalid output fails validation without replacement", async () => {
        const { item, info } = await attachment("linked", "image-heavy.pdf", "invalid output");
        const result = await withHook("beforeValidate", async context => {
          if (context.item.id === item.id) await IOUtils.write(context.output, ascii("not a PDF"));
        }, () => action("compress", item));
        outcome(result, "validation");
        await original(item, info);
        assert(!record(item), "Invalid output gained a Revert record");
        return result;
      });
      await check("backup verification failure prevents replacement", async () => {
        const { item, info } = await attachment("linked", "image-heavy.pdf", "backup corruption");
        const result = await withHook("afterBackup", async context => {
          if (context.item.id === item.id) await IOUtils.write(context.backupPath, ascii("bad backup"));
        }, () => action("compress", item));
        outcome(result, "backup");
        await original(item, info);
        assert(!record(item), "Bad backup gained a Revert record");
        return result;
      });
      await check("external write before replacement is not overwritten", async () => {
        const { item, info } = await attachment("linked", "image-heavy.pdf", "write race");
        let changedHash;
        const result = await withHook("beforeReplace", async context => {
          if (context.item.id !== item.id) return;
          const source = await IOUtils.read(context.path);
          const extra = ascii("\n% external write\n");
          const changed = new Uint8Array(source.length + extra.length);
          changed.set(source); changed.set(extra, source.length);
          await IOUtils.write(context.path, changed);
          changedHash = await hash(context.path);
        }, () => action("compress", item));
        outcome(result, "compress-changed");
        assert(await hash(info.path) === changedHash, "Final-check race overwrote external bytes");
        assert(!record(item), "Failed compression gained a Revert record");
        return result;
      });
      await check("busy action cannot interrupt a running operation", async () => {
        const { item, info } = await attachment("linked", "image-heavy.pdf", "busy guard");
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { entered = resolve; });
        return withHook("afterBackup", async context => {
          if (context.item.id === item.id) { entered(); await gate; }
        }, async () => {
          const running = action("compress", item);
          let busy;
          try {
            await Promise.race([reached, Zotero.Promise.delay(10000).then(() => {
              throw new Error("Running operation did not reach the backup hook");
            })]);
            busy = await action("compress", item);
            outcome(busy, "busy");
            await original(item, info);
          } finally { release(); }
          const finished = await running;
          outcome(finished, "success");
          await compressed(item, info);
          await action("revert", item);
          await original(item, info);
          return { busy, finished };
        });
      });
      await check("busy linked alias cannot start a second compression of the same path", async () => {
        const { item, info } = await attachment("linked", "image-heavy.pdf", "busy alias owner");
        const alias = await aliasOf(item, info, "busy alias duplicate");
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { entered = resolve; });
        return withHook("afterBackup", async context => {
          if (context.item.id === item.id) { entered(); await gate; }
        }, async () => {
          const running = action("compress", item);
          let blocked;
          try {
            await Promise.race([reached, Zotero.Promise.delay(10000).then(() => {
              throw new Error("Alias owner did not reach the backup hook");
            })]);
            blocked = await action("compress", alias.item);
            outcome(blocked, "alias-busy");
            assert(blocked.value.changed === null, "Busy alias action falsely claims unchanged running bytes");
            await original(item, info);
            assert(!record(alias.item), "Busy alias created recovery state");
          } finally { release(); }
          const finished = await running;
          outcome(finished, "success");
          await compressed(item, info);
          outcome(await action("revert", item), "success");
          await original(alias.item, alias.info);
          return { blocked, finished };
        });
      });
      await check("restored PDF retains recovery state until metadata retry succeeds", async () => {
        const { item, info } = await attachment("stored", "image-heavy.pdf", "restored metadata retry");
        outcome(await action("compress", item), "success");
        await compressed(item, info);
        const backup = backupPath(item);
        const saveTx = item.saveTx;
        let restored, failedRetry;
        try {
          item.saveTx = async () => { throw new Error("Injected Revert metadata save failure"); };
          restored = await action("revert", item);
          outcome(restored, "partial");
          assert(restored.value.changed === true, "Initial partial Revert did not report restored bytes");
          await original(item, info);
          assert(record(item)?.partial === "restored-awaiting-metadata", "Restored partial state was not retained");
          assert(await hash(backup) === info.originalHash, "Initial partial Revert lost its verified backup");
          const retained = JSON.stringify(record(item));
          failedRetry = await action("revert", item);
          outcome(failedRetry, "partial");
          assert(failedRetry.value.changed === false, "Failed metadata-only retry claims another byte replacement");
          await original(item, info);
          assert(JSON.stringify(record(item)) === retained, "Failed metadata retry consumed recovery state");
          assert(await hash(backup) === info.originalHash, "Failed metadata retry consumed original backup");
        } finally { item.saveTx = saveTx; }
        // A metadata-only retry must not replace the already restored file again.
        await IOUtils.setModificationTime(info.path, Date.now() - 3600000);
        const beforeRetryMtime = (await IOUtils.stat(info.path)).lastModified;
        const retry = await action("revert", item);
        outcome(retry, "success");
        assert(retry.value.changed === false, "Successful metadata-only retry claims another replacement");
        await original(item, info);
        assert((await IOUtils.stat(info.path)).lastModified === beforeRetryMtime,
          "Metadata-only retry rewrote the restored file");
        assert(!record(item), "Successful metadata retry retained a stale record");
        assert(!(await IOUtils.exists(backup)), "Successful metadata retry did not remove session backup");
        outcome(await action("compress", item), "success");
        await compressed(item, info);
        outcome(await action("revert", item), "success");
        await original(item, info);
        return { restored, failedRetry, retry, beforeRetryMtime };
      });
      await check("metadata failure after replacement retains recovery information", async () => {
        const { item, info } = await attachment("stored", "image-heavy.pdf", "metadata failure");
        const saveTx = item.saveTx;
        item.saveTx = async () => { throw new Error("Injected metadata save failure"); };
        let result;
        try { result = await action("compress", item); }
        finally { item.saveTx = saveTx; }
        await compressed(item, info);
        outcome(result, "partial");
        assert(result.value.changed === true, "Partial replacement outcome falsely reports unchanged bytes");
        assert(record(item), "Partial replacement lost recovery record");
        const backup = backupPath(item);
        assert(await hash(backup) === info.originalHash, "Partial replacement lost verified original");
        const retry = await action("revert", item);
        await original(item, info);
        return { result, retry, note: "Result text needs review for explicit partial failure" };
      });
    }
  }
  if (request.ui && request.mode === "suite") {
    const progressURI = "chrome://mupdf-compress-prototype/content/progress.xhtml";
    function progressFor(item) {
      const title = item.getField("title");
      const windows = Services.wm.getEnumerator(null);
      const found = [];
      while (windows.hasMoreElements()) {
        const candidate = windows.getNext();
        if (!candidate.closed && candidate.document?.documentURI === progressURI
          && candidate.arguments?.[0]?.title === title) found.push(candidate);
      }
      return found;
    }
    async function until(fn, message, timeout = 5000) {
      const start = Date.now();
      for (;;) {
        const value = fn();
        if (value) return value;
        if (Date.now() - start > timeout) throw new Error(message);
        await Zotero.Promise.delay(50);
      }
    }
    async function resultWindow(item) {
      return until(() => progressFor(item).find(candidate =>
        candidate.document.getElementById("message")?.textContent
          === candidate.arguments[0].result?.message
        && candidate.arguments[0].result?.visibleAt),
      "Result did not become visible in its progress window");
    }
    async function timedDismiss(progress) {
      const visibleAt = progress.arguments[0].result.visibleAt;
      const earlyWait = Math.max(0, visibleAt + 8500 - Date.now());
      await Zotero.Promise.delay(earlyWait);
      assert(!progress.closed, "Result closed before its 10-second interval");
      await until(() => progress.closed, "Result did not dismiss after 10 seconds", 5000);
      const elapsed = Date.now() - visibleAt;
      assert(elapsed >= 9900 && elapsed <= 13500,
        "Result dismissal timing outside expected interval: " + elapsed);
      return { visibleAt, observedClosedAfterMs: elapsed };
    }
    await check("UI: dismissed running window reopens for success and dismisses after 10 seconds", async () => {
      const { item, info } = await attachment("linked", "image-heavy.pdf", "UI reopening");
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const reached = new Promise(resolve => { entered = resolve; });
      return withHook("afterBackup", async context => {
        if (context.item.id === item.id) { entered(); await gate; }
      }, async () => {
        const running = action("compress", item);
        let oldWindow;
        try {
          await Promise.race([reached, Zotero.Promise.delay(10000).then(() => {
            throw new Error("UI operation did not reach the backup stage");
          })]);
          oldWindow = await until(() => progressFor(item).find(candidate =>
            candidate.document.getElementById("stage")?.textContent === "Backing up"),
          "Running stage was not visible");
          const message = oldWindow.document.getElementById("message").textContent;
          assert(message.includes("does not cancel"), "Running feedback does not explain closing behavior");
          assert(!oldWindow.document.querySelector('progress,[role="progressbar"],[dlgtype="cancel"]'),
            "Indeterminate progress has a percentage widget or Cancel control");
          oldWindow.close();
          await until(() => oldWindow.closed, "Running window did not close");
          const identity = item.libraryID + ":" + item.key;
          assert(state().busy.includes(identity), "Closing the window cancelled the running operation");
        } finally { release(); }
        const finished = await running;
        outcome(finished, "success");
        await compressed(item, info);
        const reopened = await resultWindow(item);
        assert(reopened !== oldWindow, "Result reused a closed window");
        assert(reopened.document.getElementById("message").textContent.includes(
          "Revert is available only during this Zotero session"), "Success omitted session-only reminder");
        const timing = await timedDismiss(reopened);
        outcome(await action("revert", item), "success");
        await original(item, info);
        for (const ownWindow of progressFor(item)) ownWindow.close();
        return { finished, timing, reopened: true };
      });
    });
    await check("UI: no-benefit result dismisses after 10 seconds", async () => {
      const { item, info } = await attachment("linked", "image-heavy.pdf", "UI no benefit");
      const result = await withHook("beforeValidate", async context => {
        if (context.item.id === item.id) await IOUtils.copy(context.record.backupPath, context.output);
      }, () => action("compress", item));
      outcome(result, "no-benefit");
      await original(item, info);
      const progress = await resultWindow(item);
      return { result, timing: await timedDismiss(progress) };
    });
    await check("UI: blocked-action result remains visible beyond 10 seconds", async () => {
      const { item, info } = await attachment("linked", "image-heavy.pdf", "UI persistent failure");
      const result = await action("revert", item);
      outcome(result, "no-record");
      const progress = await resultWindow(item);
      const visibleAt = progress.arguments[0].result.visibleAt;
      try {
        await Zotero.Promise.delay(Math.max(0, visibleAt + 11000 - Date.now()));
        assert(!progress.closed, "Blocked-action result auto-dismissed");
        assert(progress.document.getElementById("message").textContent === result.value.message,
          "Blocked-action result did not display its outcome text");
        await original(item, info);
        return { result, visibleAfterMs: Date.now() - visibleAt };
      } finally { if (!progress.closed) progress.close(); }
    });
  }
  report.finalState = state();
  report.finished = new Date().toISOString();
  report.status = report.checks.some(x => x.status === "fail") ? "failed" : "passed";
  report.counts = Object.fromEntries(["pass", "fail", "skipped"].map(status =>
    [status, report.checks.filter(x => x.status === status).length]));
  await save();
  return report;
}
