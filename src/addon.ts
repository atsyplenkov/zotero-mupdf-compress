/* SPDX-License-Identifier: AGPL-3.0-or-later */
import { config } from "../package.json";
import hooks from "./hooks";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    initialized: boolean;
    paneID: string | null;
    mainWindows: Set<Window>;
  };
  public hooks: typeof hooks;

  constructor() {
    this.data = {
      alive: true,
      config,
      initialized: false,
      paneID: null,
      mainWindows: new Set(),
    };
    this.hooks = hooks;
  }
}

export default Addon;
