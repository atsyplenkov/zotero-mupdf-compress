/* SPDX-License-Identifier: AGPL-3.0-or-later */

import type { SessionRecord } from "./types.ts";

export type LiveHash = { kind: "read"; hash: string } | { kind: "unreadable" };

export type MoveClass = { kind: "verified" } | { kind: "unchanged" } | { kind: "unverified" };

export type UnverifiedClass =
  | { kind: "still-unverified" }
  | { kind: "intended-landed" }
  | { kind: "previous-still-installed" };

export type CompressPlan = { kind: "proceed" } | { kind: "stop"; code: "repeated" | "unresolved" };

export type RevertPlan =
  | { kind: "stop"; code: "no-record" }
  | { kind: "finish-metadata" }
  | { kind: "reconcile" }
  | { kind: "restore" };

export function classifyMove(beforeHash: string, intendedHash: string, live: LiveHash): MoveClass {
  if (live.kind === "read" && live.hash === intendedHash) return { kind: "verified" };
  if (live.kind === "read" && live.hash === beforeHash) return { kind: "unchanged" };
  return { kind: "unverified" };
}

export function classifyUnverified(
  record: Extract<SessionRecord, { phase: "replacement-unverified" }>,
  live: LiveHash,
): UnverifiedClass {
  if (live.kind !== "read") return { kind: "still-unverified" };
  const intendedHash = record.intended === "compressed" ? record.compressedHash : record.originalHash;
  const previousHash = record.intended === "compressed" ? record.originalHash : record.compressedHash;
  if (live.hash === intendedHash) return { kind: "intended-landed" };
  if (live.hash === previousHash) return { kind: "previous-still-installed" };
  return { kind: "still-unverified" };
}

export function reconcileUnverified(
  record: Extract<SessionRecord, { phase: "replacement-unverified" }>,
  livePath: string,
  readAt: (path: string) => LiveHash,
): UnverifiedClass | { kind: "path-changed" } {
  if (livePath !== record.path) return { kind: "path-changed" };
  return classifyUnverified(record, readAt(record.path));
}

export function planCompress(record: SessionRecord | null): CompressPlan {
  if (!record) return { kind: "proceed" };
  if (record.phase === "replacement-unverified") return { kind: "stop", code: "unresolved" };
  return { kind: "stop", code: "repeated" };
}

export function planRevert(record: SessionRecord | null): RevertPlan {
  if (!record) return { kind: "stop", code: "no-record" };
  switch (record.phase) {
    case "restored-awaiting-metadata":
      return { kind: "finish-metadata" };
    case "replacement-unverified":
      return { kind: "reconcile" };
    case "compressed":
    case "compressed-awaiting-metadata":
      return { kind: "restore" };
    default: {
      const unreachable: never = record;
      return unreachable;
    }
  }
}
