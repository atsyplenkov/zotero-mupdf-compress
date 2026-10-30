/* SPDX-License-Identifier: AGPL-3.0-or-later
 * THROWAWAY: extra isolated lifecycle and hands-on review setup.
 */
async function runMuPDFLifecycleMode(mode, helpers) {
  const { api, request, report, env, runDir, state, save, check, assert, skip,
    action, outcome, attachment, compressed, original, record, hash, withHook } = helpers;
  const win = env.window;
  if (mode === "review-session") {
    report.review = {
      visualQuality: "deferred-by-user",
      handsOnFeedback: "pending-user",
      presetAccepted: false,
      note: "Prepared fixtures and automated checks do not establish quality or user acceptance.",
    };
    await check("prepare named collection and active Revert for hands-on feedback review", async () => {
      const collection = new Zotero.Collection();
      collection.libraryID = Zotero.Libraries.userLibraryID;
      collection.name = "MuPDF prototype #9 - hands-on review " + request.runID;
      await collection.saveTx();
      report.review.collection = { id: collection.id, key: collection.key, name: collection.name };
      await save();
      const stored = await attachment("stored", "image-heavy.pdf",
        "REVIEW stored image-heavy - Compress/Revert", collection.id);
      const linked = await attachment("linked", "image-heavy.pdf",
        "REVIEW linked image-heavy - original", collection.id);
      const text = await attachment("stored", "text-vector.pdf",
        "REVIEW text-vector - original", collection.id);
      const annotated = await attachment("stored", "annotated.pdf",
        "REVIEW embedded annotations - original", collection.id);
      const result = await action("compress", stored.item);
      outcome(result, "success");
      await compressed(stored.item, stored.info);
      await original(linked.item, linked.info);
      await original(text.item, text.info);
      await original(annotated.item, annotated.info);
      report.review.compressedAttachment = { ...stored.info,
        compressedHash: await hash(stored.info.path), record: record(stored.item) };
      report.review.originalAttachments = [linked.info, text.info, annotated.info];
      report.review.instructions = [
        "On the selected stored image-heavy PDF, use Compress PDF > Revert to restore its original bytes.",
        "Try Compress and Revert on the fresh linked image-heavy attachment.",
        "Close a PDF reader tab before invoking either action.",
        "Comment on progress stages, result wording, timing, and session-only Revert behavior.",
        "Visual-quality approval is deferred; no quality acceptance is recorded.",
        "Keep this isolated Zotero session open to retain the current Revert record.",
      ];
      await save();
      assert(win?.ZoteroPane?.collectionsView, "Main collection tree is unavailable");
      assert(await win.ZoteroPane.collectionsView.selectCollection(collection.id),
        "Could not select the hands-on review collection");
      assert(await win.ZoteroPane.selectItem(stored.item.id, { noWindowRestore: true }),
        "Could not select the compressed stored attachment");
      const selected = win.ZoteroPane.getSelectedItems();
      assert(selected.length === 1 && selected[0].id === stored.item.id,
        "The review PDF is not the sole selected attachment");
      report.review.selectedAttachmentID = stored.item.id;
      return { collection: report.review.collection, selectedAttachmentID: stored.item.id,
        activeRevert: record(stored.item), result };
    });
    await check("single-PDF context menu exposes both actions and hides for multiple selections", async () => {
      const popup = win.document.getElementById("zotero-itemmenu");
      assert(popup, "Attachment context menu is missing");
      const selectedID = report.review.selectedAttachmentID;
      const linkedID = report.review.originalAttachments[0].id;
      let submenu;
      try {
        await win.ZoteroPane.buildItemContextMenu();
        popup.dispatchEvent(new win.Event("popupshowing", { bubbles: true }));
        await Zotero.Promise.delay(200);
        submenu = [...popup.querySelectorAll("menu")].find(menu =>
          menu.getAttribute("label") === "Compress PDF");
        assert(submenu && !submenu.hidden, "Compress PDF menu is not visible for one PDF");
        const children = submenu.querySelector("menupopup");
        assert(children, "Compress PDF submenu is missing");
        children.dispatchEvent(new win.Event("popupshowing", { bubbles: true }));
        await Zotero.Promise.delay(100);
        const actions = [...children.querySelectorAll("menuitem")].map(entry => ({
          label: entry.getAttribute("label"), disabled: entry.disabled, hidden: entry.hidden,
        }));
        assert(["Compress", "Revert"].every(label => actions.some(entry =>
          entry.label === label && !entry.disabled && !entry.hidden)),
        "Both Compress and Revert must remain available for an eligible PDF");
        children.hidePopup();
        popup.hidePopup();
        await win.ZoteroPane.itemsView.selectItems([selectedID, linkedID]);
        assert(win.ZoteroPane.getSelectedItems().length === 2, "Could not select two review PDFs");
        await win.ZoteroPane.buildItemContextMenu();
        popup.dispatchEvent(new win.Event("popupshowing", { bubbles: true }));
        await Zotero.Promise.delay(200);
        const multiple = [...popup.querySelectorAll("menu")].find(menu =>
          menu.getAttribute("label") === "Compress PDF");
        assert(!multiple || multiple.hidden, "Compress PDF menu appears for multiple PDFs");
        return { actions, multiSelectionHidden: true };
      } finally {
        submenu?.querySelector("menupopup")?.hidePopup();
        popup.hidePopup();
        await win.ZoteroPane.selectItem(selectedID, { noWindowRestore: true });
      }
    });
    return;
  }
  if (mode === "shutdown-busy") {
    if (typeof api.testStop !== "function") skip("Prototype has no gated testStop interface");
    await check("shutdown waits for an active operation and preserves the pinned temporary root", async () => {
      const pref = "extensions.mupdf-compress-prototype.temporaryFolder";
      const oldPref = Zotero.Prefs.get(pref, true);
      const initial = state();
      const alternate = PathUtils.join(runDir, "next-session-temporary-folder");
      await IOUtils.makeDirectory(alternate, { permissions: 0o700 });
      let release, entered, context;
      const gate = new Promise(resolve => { release = resolve; });
      const reached = new Promise(resolve => { entered = resolve; });
      try {
        Zotero.Prefs.set(pref, alternate, true);
        assert(state().temporaryRoot === initial.temporaryRoot, "Preference change moved the active temporary root");
        const { item, info } = await attachment("stored", "image-heavy.pdf", "shutdown while busy");
        return await withHook("afterBackup", async current => {
          if (current.item.id === item.id) { context = current; entered(); await gate; }
        }, async () => {
          const running = action("compress", item);
          let stopTask, stopSettled = false, blocked;
          try {
            await Promise.race([reached, Zotero.Promise.delay(10000).then(() => {
              throw new Error("Shutdown operation did not reach the backup hook");
            })]);
            assert(context.backupPath.startsWith(initial.sessionDir + "/"), "Backup moved after temporary-folder preference change");
            assert(await hash(context.backupPath) === info.originalHash, "Busy operation backup is not verified");
            stopTask = api.testStop().then(() => { stopSettled = true; });
            await Zotero.Promise.delay(200);
            assert(state().stopping === true, "testStop did not reject new work");
            assert(!stopSettled, "Shutdown completed while the active operation was held");
            assert(await IOUtils.exists(initial.sessionDir), "Shutdown removed the busy session directory");
            assert(await hash(context.backupPath) === info.originalHash, "Shutdown removed or changed the busy backup");
            await original(item, info);
            blocked = await action("compress", item);
            outcome(blocked, "stopped");
            assert(!stopSettled, "Blocked new work interrupted the pending shutdown");
            report.shutdownWhileHeld = { state: state(), backupPath: context.backupPath,
              backupHash: await hash(context.backupPath), blocked };
            await save();
          } finally {
            release();
            // Never leave an intentionally held operation behind on assertion failure.
            await running;
            if (stopTask) await stopTask;
          }
          const finished = report.actions.filter(entry => entry.itemID === item.id
            && entry.kind === "compress" && entry.value?.code === "success").at(-1);
          assert(finished, "The released compression did not finish successfully");
          assert(stopSettled, "Shutdown did not finish after the operation was released");
          assert(!(await IOUtils.exists(initial.sessionDir)), "Shutdown left its owned session directory behind");
          assert(!(await IOUtils.exists(context.backupPath)), "Shutdown left its session backup behind");
          assert(state().records.length === 0, "Shutdown retained session Revert records");
          assert(state().lockAlive === false, "Shutdown retained the native lock helper");
          assert(state().temporaryRoot === initial.temporaryRoot, "Active temporary root changed during shutdown");
          assert(!(await IOUtils.exists(PathUtils.join(alternate, "mupdf-compress-prototype-v1"))),
            "Preference change initialized a second root in the active session");
          const finalHash = await hash(info.path);
          assert(finalHash !== info.originalHash, "Completed shutdown operation did not install compressed bytes");
          const afterStop = await action("compress", item);
          outcome(afterStop, "stopped");
          assert(await hash(info.path) === finalHash, "Stopped session accepted a later replacement");
          report.shutdownResult = { previousSession: initial.sessionDir,
            alternateTemporaryFolder: alternate, finalHash, afterStop,
            crashDuringOperation: "not tested; no deliberate process kill performed" };
          return report.shutdownResult;
        });
      } finally {
        release();
        if (oldPref === undefined) Zotero.Prefs.clear(pref, true);
        else Zotero.Prefs.set(pref, oldPref, true);
      }
    });
  }
}
