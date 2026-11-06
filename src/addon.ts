/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { config } from "../package.json";
import hooks from "./hooks";
import type { OperationApi } from "./operation";
import { startCompress as startCompressQueue } from "./queue";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    initialized: boolean;
    paneID: string | null;
    mainWindows: Set<Window>;
  };
  public hooks: typeof hooks;
  public operation: OperationApi | null;
  public startCompress: (items: Zotero.Item[]) => void;

  constructor() {
    this.data = {
      alive: true,
      config,
      initialized: false,
      paneID: null,
      mainWindows: new Set(),
    };
    this.hooks = hooks;
    this.operation = null;
    this.startCompress = startCompressQueue;
  }
}

export default Addon;
