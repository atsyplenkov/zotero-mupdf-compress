/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal } from "node:assert/strict";
import { test } from "node:test";
import { beginDecision, drainLedger, markMissing, presentStored, type Ledger, type LedgerRow } from "./queue-ledger.ts";

function waiting(itemID: number): LedgerRow {
  return {
    itemID,
    libraryID: 1,
    key: `K${itemID}`,
    filename: `${itemID}.pdf`,
    phase: { kind: "waiting" },
    listed: true,
  };
}

test("a throwing row update does not stop attachment work or reject the pump", async () => {
  const ledger: Ledger = {
    action: "Compress",
    run: "processing",
    closedByQueue: false,
    rows: [waiting(1), waiting(2)],
  };
  let updates = 0;
  let started = 0;
  const sink = {
    update(): void {
      updates += 1;
      if (updates === 2) throw new Error("dialog gone");
    },
  };
  for (const row of ledger.rows) presentStored(row, ledger.action, sink);
  await drainLedger(ledger, async (row) => {
    started += 1;
    row.phase = { kind: "done", result: { kind: "installed", before: 100000, after: 18000 } };
  }, sink);
  equal(started, 2);
  equal(ledger.run, "processing");
});

test("one hundred rows publish once per transition", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => waiting(index + 1));
  const ledger: Ledger = { action: "Compress", run: "processing", closedByQueue: false, rows };
  let updates = 0;
  const sink = { update(): void { updates += 1; } };
  for (const row of rows) presentStored(row, "Compress", sink);
  await drainLedger(ledger, async (row) => {
    row.phase = { kind: "done", result: { kind: "blocked", before: null, code: "missing" } };
  }, sink);
  equal(updates, 300);
});

test("a missing item keeps its row id and receives File not found", () => {
  const row = markMissing(waiting(41));
  equal(row.itemID, 41);
  let seen = "";
  presentStored(row, "Compress", { update: (_id, _status, message) => { seen = message; } });
  equal(seen, "File not found");
});

test("a dead pump with a processing ledger restarts, and an open finished dialog does not", () => {
  equal(beginDecision({ pumpRunning: false, dialogOpen: false, ledger: { run: "processing" } }), "restart");
  equal(beginDecision({ pumpRunning: true, dialogOpen: false, ledger: { run: "processing" } }), "join");
  equal(beginDecision({ pumpRunning: false, dialogOpen: true, ledger: { run: "finished" } }), "join");
  equal(beginDecision({ pumpRunning: false, dialogOpen: false, ledger: { run: "finished" } }), "replace");
  equal(beginDecision({ pumpRunning: false, dialogOpen: false, ledger: null }), "replace");
});
