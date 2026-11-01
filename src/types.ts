/* SPDX-License-Identifier: AGPL-3.0-or-later */

export type Action = "Compress" | "Revert";
export type Changed = boolean | null;
export type PartialRecoveryState =
  | "compressed-awaiting-metadata"
  | "restored-awaiting-metadata"
  | "replacement-state-uncertain";

export interface SessionRecord {
  id: string;
  libraryID: number;
  key: string;
  path: string;
  backupPath: string;
  originalHash: string;
  compressedHash: string | null;
  originalSize?: number;
  compressedSize?: number;
  partial: PartialRecoveryState | null;
}

export interface Outcome {
  code: string;
  message: string;
  changed: Changed;
  stage: string;
}

export interface StartupDiagnostic {
  stage: string;
  name: string;
  code: string;
}

export interface UiErrorDiagnostic {
  stage: string;
  name: string;
  code: number | null;
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
    records: SessionRecord[];
    busy: string[];
    busyPaths: string[];
    uiErrors: UiErrorDiagnostic[];
  };
}
