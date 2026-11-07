/* SPDX-License-Identifier: AGPL-3.0-or-later */

export type Action = "Compress" | "Revert";

export const RECOVERY_SENTENCE = {
  replacedIncomplete:
    "The PDF was replaced, but the remaining operation failed. The verified original backup and session recovery record were retained.",
  restoredIncomplete:
    "The PDF was restored, but the remaining operation failed. The verified original backup and session recovery record were retained.",
  metadataDoneBackupRemains:
    "The metadata update is complete, but the session backup could not be removed. The recovery record was retained.",
  restoredMetadataIncomplete:
    "The original PDF remains restored, but the remaining metadata update could not be completed. The verified original backup and session recovery record were retained.",
  unverified:
    "The operation failed during file replacement. The attachment's current state could not be verified.",
} as const;

export type RecoverySentence = (typeof RECOVERY_SENTENCE)[keyof typeof RECOVERY_SENTENCE];

type AttachmentIdentity = {
  id: string;
  libraryID: number;
  key: string;
};

type HeldBackup = AttachmentIdentity & {
  path: string;
  backupPath: string;
  originalHash: string;
  originalSize: number;
};

type CompressedFacts = HeldBackup & {
  compressedHash: string;
  compressedSize: number;
};

export type SessionRecord =
  | (CompressedFacts & { phase: "compressed" })
  | (CompressedFacts & { phase: "compressed-awaiting-metadata" })
  | (HeldBackup & { phase: "restored-awaiting-metadata" })
  | (CompressedFacts & { phase: "replacement-unverified"; intended: "compressed" | "restored" });

export interface OutcomeBase {
  message: string;
  stage: string;
}

export type Outcome =
  | (OutcomeBase & { code: "success"; changed: boolean; beforeBytes: number; producedBytes: number })
  | (OutcomeBase & { code: "no-benefit"; changed: false; beforeBytes: number; producedBytes: number })
  | (OutcomeBase & { code: "partial"; changed: boolean; message: RecoverySentence; beforeBytes: number; producedBytes: number })
  | (OutcomeBase & { code: "uncertain"; changed: null; message: typeof RECOVERY_SENTENCE.unverified; beforeBytes: number | null; producedBytes: null })
  | (OutcomeBase & { code: UntouchedCode; changed: false | null; beforeBytes: number | null; producedBytes: null });

export const UNTOUCHED_CODES = [
  "open",
  "missing",
  "encrypted",
  "unreadable",
  "compress-changed",
  "revert-changed",
  "validation",
  "backup",
  "backup-invalid",
  "no-record",
  "reader-check-unavailable",
  "lock-unavailable",
  "unsafe-path",
  "symlink-path",
  "missing-path",
  "ineligible",
  "stopped",
  "busy",
  "alias-busy",
  "alias-compressed",
  "repeated",
  "unresolved",
  "engine",
  "replacement-unchanged",
  "temporary-folder",
  "failure",
] as const;

export type UntouchedCode = (typeof UNTOUCHED_CODES)[number];

export interface StartupDiagnostic {
  stage: string;
  name: string;
  code: string;
}

export interface OperationApi {
  ready: Promise<void>;
  hooks: Record<string, (context: Record<string, unknown>) => Promise<void> | void>;
  compress(item: Zotero.Item | null): Promise<Outcome>;
  revert(item: Zotero.Item | null): Promise<Outcome>;
  snapshot(): {
    ready: boolean;
    initializationError: string | null;
    initializationDiagnostic: StartupDiagnostic | null;
    lockPid: number | null;
    lockAlive: boolean;
    records: SessionRecord[];
    busy: string[];
    busyPaths: string[];
  };
}
