/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal } from "node:assert/strict";
import { test } from "node:test";
import { classifyMove, classifyUnverified, planCompress, planRevert, reconcileUnverified } from "./recovery.ts";
import type { SessionRecord } from "./types.ts";

const compressed: SessionRecord = {
  phase: "compressed",
  id: "1:ABC",
  libraryID: 1,
  key: "ABC",
  path: "/library/paper.pdf",
  backupPath: "/session/backup.pdf",
  originalHash: "original",
  originalSize: 100000,
  compressedHash: "compressed",
  compressedSize: 18000,
};

test("classifyMove trusts the live hash, not the thrown error", () => {
  equal(classifyMove("original", "compressed", { kind: "read", hash: "compressed" }).kind, "verified");
  equal(classifyMove("original", "compressed", { kind: "read", hash: "original" }).kind, "unchanged");
  equal(classifyMove("original", "compressed", { kind: "read", hash: "other" }).kind, "unverified");
  equal(classifyMove("original", "compressed", { kind: "unreadable" }).kind, "unverified");
});

test("the next action is the record phase", () => {
  equal(planCompress(null).kind, "proceed");
  equal(planCompress(compressed).kind, "stop");
  equal(planCompress({ ...compressed, phase: "compressed-awaiting-metadata" }).kind, "stop");
  const unresolved = planCompress({ ...compressed, phase: "replacement-unverified", intended: "compressed" });
  equal(unresolved.kind, "stop");
  if (unresolved.kind === "stop") equal(unresolved.code, "unresolved");

  equal(planRevert(null).kind, "stop");
  equal(planRevert(compressed).kind, "restore");
  equal(planRevert({ ...compressed, phase: "compressed-awaiting-metadata" }).kind, "restore");
  equal(planRevert({
    phase: "restored-awaiting-metadata",
    id: compressed.id,
    libraryID: 1,
    key: "ABC",
    path: compressed.path,
    backupPath: compressed.backupPath,
    originalHash: "original",
    originalSize: 100000,
  }).kind, "finish-metadata");
  equal(planRevert({ ...compressed, phase: "replacement-unverified", intended: "compressed" }).kind, "reconcile");
});

test("an unverified record is not treated as a normal compressed file", () => {
  const record: SessionRecord = { ...compressed, phase: "replacement-unverified", intended: "compressed" };
  equal(classifyUnverified(record, { kind: "read", hash: "compressed" }).kind, "intended-landed");
  equal(classifyUnverified(record, { kind: "read", hash: "original" }).kind, "previous-still-installed");
  equal(classifyUnverified(record, { kind: "read", hash: "other" }).kind, "still-unverified");
  equal(classifyUnverified(record, { kind: "unreadable" }).kind, "still-unverified");

  const restored = classifyUnverified(
    { ...record, intended: "restored" },
    { kind: "read", hash: "original" },
  );
  equal(restored.kind, "intended-landed");
  equal(classifyUnverified({ ...record, intended: "restored" }, { kind: "read", hash: "compressed" }).kind, "previous-still-installed");
});

test("a relinked attachment is refused before its new bytes are read", () => {
  const record: SessionRecord = { ...compressed, phase: "replacement-unverified", intended: "compressed" };
  let reads = 0;
  const result = reconcileUnverified(record, "/library/other.pdf", () => {
    reads += 1;
    return { kind: "read", hash: "original" };
  });
  equal(result.kind, "path-changed");
  equal(reads, 0);
});

test("reconciliation reads the recorded path when the attachment still points there", () => {
  const record: SessionRecord = { ...compressed, phase: "replacement-unverified", intended: "compressed" };
  let readPath = "";
  const result = reconcileUnverified(record, record.path, (path) => {
    readPath = path;
    return { kind: "read", hash: "original" };
  });
  equal(result.kind, "previous-still-installed");
  equal(readPath, record.path);
});
