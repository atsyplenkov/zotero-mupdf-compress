// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness-only smoke check. No Zotero process, files, or library are modified.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const local = "/mock/.local-test";
const work = local + "/prototype";
const profile = local + "/zotero/profile";
const data = local + "/zotero/data";
const bytes = Uint8Array.from([37, 80, 68, 70, 45, 49]);
const files = new Map([[local + "/fixtures/image-heavy.pdf", bytes]]);
let evidence;
const item = {
  id: 1, key: "MOCKKEY1", libraryID: 1,
  attachmentPath: work + "/integration-files-mock/MOCK-image-heavy.pdf",
  async getFilePathAsync() { return this.attachmentPath; },
};
const context = vm.createContext({
  Zotero: {
    version: "mock", Profile: { dir: profile }, DataDirectory: { dir: data },
    Prefs: { get: () => false }, Libraries: { userLibraryID: 1 },
    Utilities: { randomString: () => "MOCK" },
    Items: { get: () => item },
    Attachments: { importFromFile: async () => item },
  },
  IOUtils: {
    async makeDirectory() {},
    async writeJSON(_path, value) { evidence = JSON.parse(JSON.stringify(value)); },
    async read(file) {
      assert(files.has(file), "Mock file absent: " + file);
      return files.get(file);
    },
    async copy(source, target) { files.set(target, files.get(source)); },
    async stat(file) { return { size: files.get(file).length }; },
  },
  PathUtils: { join: path.posix.join },
  Components: {
    interfaces: { nsICryptoHash: {} },
    classes: { "@mozilla.org/security/hash;1": {
      createInstance() {
        let input;
        return {
          SHA256: 1, init() {}, update(value) { input = value; },
          finish() { return crypto.createHash("sha256").update(input).digest("latin1"); },
        };
      },
    } },
  },
});
vm.runInContext(fs.readFileSync(new URL("./lifecycle-modes.js", import.meta.url), "utf8"), context);
vm.runInContext(fs.readFileSync(new URL("./integration.js", import.meta.url), "utf8"), context);
await context.runMuPDFIntegration({
  snapshot: () => ({ ready: true, records: [] }),
  compress: async () => ({ code: "validation", changed: false, stage: "Inspecting input" }),
}, {
  runID: "mock", mode: "seed-session", expectedProfile: profile, expectedData: data,
}, { work, local, evidencePath: work + "/mock.json", window: {} });
assert.equal(evidence.status, "failed");
assert.equal(evidence.actions.length, 1);
assert.equal(evidence.actions[0].value.code, "validation");
assert.match(evidence.checks[0].error.message, /latest action:.*"code":"validation"/);
console.log("Harness smoke passed: failed Compress is retained and named in byte-assertion diagnostics.");

// Review setup must select a compressed fixture and never imply acceptance.
const reviewItems = new Map();
let nextID = 10;
const collectionID = 7;
const records = [];
context.Zotero.Utilities.randomString = () => "MOCK" + nextID;
for (const fixture of ["text-vector.pdf", "annotated.pdf"]) {
  files.set(local + "/fixtures/" + fixture, bytes);
}
context.Zotero.Collection = class {
  async saveTx() { this.id = collectionID; this.key = "MOCKCOLL"; }
};
context.Zotero.Items.get = id => reviewItems.get(id);
const importReview = async options => {
  assert.deepEqual(Array.from(options.collections), [collectionID]);
  const id = nextID++;
  const reviewItem = {
    id, key: "REVIEW" + id, libraryID: 1, attachmentPath: options.file,
    async getFilePathAsync() { return this.attachmentPath; },
  };
  reviewItems.set(id, reviewItem);
  return reviewItem;
};
context.Zotero.Attachments.importFromFile = importReview;
context.Zotero.Attachments.linkFromFile = importReview;
let selectedID;
let selectedIDs = [];
context.Zotero.Promise = { async delay() {} };
const children = {
  dispatchEvent() {}, hidePopup() {},
  querySelectorAll: () => ["Compress", "Revert"].map(label => ({
    getAttribute: () => label, disabled: false, hidden: false,
  })),
};
const submenu = {
  get hidden() { return selectedIDs.length !== 1; },
  getAttribute: () => "Compress PDF", querySelector: () => children,
};
const popup = { dispatchEvent() {}, hidePopup() {}, querySelectorAll: () => [submenu] };
await context.runMuPDFIntegration({
  snapshot: () => ({ ready: true, records }),
  compress: async reviewItem => {
    files.set(reviewItem.attachmentPath, bytes.slice(0, 3));
    records.push({ key: reviewItem.key, backupPath: "/mock/backup.pdf" });
    return { code: "success", changed: true };
  },
}, {
  runID: "review-mock", mode: "review-session", expectedProfile: profile, expectedData: data,
}, { work, local, evidencePath: work + "/review-mock.json", window: {
  Event: class {}, document: { getElementById: () => popup },
  ZoteroPane: {
    collectionsView: { async selectCollection(id) { assert.equal(id, collectionID); return true; } },
    itemsView: { async selectItems(ids) { selectedIDs = ids; } },
    async buildItemContextMenu() {},
    async selectItem(id) { selectedID = id; selectedIDs = [id]; return true; },
    getSelectedItems: () => selectedIDs.map(id => reviewItems.get(id)),
  },
} });
assert.equal(evidence.status, "passed", JSON.stringify(evidence.checks));
assert.equal(evidence.items.length, 4);
assert.equal(evidence.review.selectedAttachmentID, selectedID);
assert.equal(evidence.review.visualQuality, "deferred-by-user");
assert.equal(evidence.review.handsOnFeedback, "pending-user");
assert.equal(evidence.review.presetAccepted, false);
assert.equal(records.length, 1);
console.log("Review-mode smoke passed: four fixtures, one active record, selected attachment, no acceptance claim.");
