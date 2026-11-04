/* SPDX-License-Identifier: AGPL-3.0-or-later */
import Addon from "./addon";
import { config } from "../package.json";

if (config.addonInstance !== "MuPDFCompress") {
  throw new Error("addonInstance");
}
if (!Zotero.MuPDFCompress) {
  _globalThis.addon = new Addon();
  Zotero.MuPDFCompress = _globalThis.addon;
}
