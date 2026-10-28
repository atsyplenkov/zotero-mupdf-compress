# Zotero 7+ scaffold and UI APIs for the prototype

Resolves ticket #2 of [Working Linux prototype with bundled MuPDF](https://github.com/atsyplenkov/zotero-mupdf-compress/issues/1).

Checked 2026-10-28 against Zotero's developer documentation and the `zotero/zotero` source at tags `7.0.32`, `8.0.0`, and `10.0.6`. Zotero's current release line is 10.0.x.

## What the prototype needs

Seven integration points: plugin lifecycle, a PDF-attachment context menu, a preference pane, launching a bundled native binary, a temporary directory, detecting an open reader tab, and user feedback.

## Recommended scaffold

Use the community [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) (v3.1.0) with [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold), [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit), and [zotero-types](https://github.com/windingwind/zotero-types).

Reasons from its own configuration: it already builds a bootstrap-style plugin (`src/index.ts` bundled to `firefox115`, prefs prefix, addon id/name injected at build), ships hot reload, and counts many maintained Zotero plugins as users. The template declares `"license": "AGPL-3.0-or-later"`, matching the MuPDF licensing choice.

Zotero's own [Make It Red](https://github.com/zotero/make-it-red) sample is the reference for manifest and lifecycle shape, but it is a minimal demo with no build or release tooling. Zotero's [plugin development page](https://www.zotero.org/support/dev/client_coding/plugin_development) is marked a work in progress (last updated 2023-11-14) and does not prescribe a scaffold.

## Lifecycle

Zotero 7 replaced XUL overlays with bootstrapped plugins: a `manifest.json` plus a `bootstrap.js` exposing `startup`, `shutdown`, `install`, `uninstall`, `onMainWindowLoad`, and `onMainWindowUnload` ([Zotero 7 for Developers](https://www.zotero.org/support/dev/zotero_7_for_developers), "XUL Overlays → bootstrap.js"). Two constraints matter here:

- Window-specific work, including adding menu items, must happen in `onMainWindowLoad`, because the main window can be opened and closed repeatedly in one session.
- `shutdown()` must remove everything, because plugins can be disabled without restarting Zotero.

Manifest compatibility uses `applications.zotero.strict_min_version` / `strict_max_version`; `6.999` is the documented way to allow installation on Zotero 7 betas.

## Attachment context menu

Two different APIs, split by version:

- **Zotero 8.0 and later:** `Zotero.MenuManager.registerMenu({ menuID, pluginID, target, menus })`, documented in [Zotero 8 for Developers](https://www.zotero.org/support/dev/zotero_8_for_developers#custom-menu-items) (page dated 2026-02-18). Target `main/library/item` is the library item context menu. Menu entries receive `context.items`, and visibility is controlled with `context.setVisible(...)` inside `onShowing`; `Zotero.MenuManager.unregisterMenu(id)` removes them, and menus are removed automatically on plugin shutdown.
- **Zotero 7.0.x:** no `MenuManager`. At tag `7.0.32` the plugin API directory contains only `itemPaneManager.js`, `itemTreeManager.js`, and `pluginAPIBase.mjs`; `menuManager.js` first appears at `8.0.0`. Zotero 7.0 plugins must inject their own XUL `menuitem` into `#zotero-itemmenu` from `onMainWindowLoad` and remove it in `onMainWindowUnload`/`shutdown`.

Source references: [`menuManager.js` at 10.0.6](https://github.com/zotero/zotero/blob/10.0.6/chrome/content/zotero/xpcom/pluginAPI/menuManager.js) (`Zotero.MenuManager` and `registerMenu`), and the `7.0.32` [`pluginAPI` directory listing](https://github.com/zotero/zotero/tree/7.0.32/chrome/content/zotero/xpcom/pluginAPI).

Prototype implication: write one small menu module with two backends, chosen by feature detection (`typeof Zotero.MenuManager?.registerMenu === "function"`), and expose a single `isPdfAttachment` visibility rule to both. Do not assume the Zotero 8 API on the Zotero 7.0 path.

## Preference pane

`Zotero.PreferencePanes.register(options)` is available in both `7.0.32` and `10.0.6` ([`preferencePanes.js`](https://github.com/zotero/zotero/blob/10.0.6/chrome/content/zotero/xpcom/preferencePanes.js)). Required options are `pluginID` and `src`; optional `id`, `label`, `image`, `scripts`, `stylesheets`, and `helpURL`. The pane is unregistered automatically on plugin shutdown.

This covers the temporary-folder preference without custom preference-window work. Note the Zotero 8 change that preference panes run in their own global scope, so a pane script must set values on `window` explicitly if other panes need them.

## Launching the bundled binary

`Zotero.Utilities.Internal.exec(cmd, args)` exists at `7.0.0`, `7.0.32`, and `10.0.6` ([`utilities_internal.js`](https://github.com/zotero/zotero/blob/10.0.6/chrome/content/zotero/xpcom/utilities_internal.js)). It accepts a path string or `nsIFile`, throws when the target is not executable, resolves `true` on exit status 0, and rejects on a non-zero exit status. A sibling `subprocess()` returns stdout, which the validation step can use for page counts.

Two prototype consequences:

- The binary cannot be executed from inside the XPI. It must be extracted to a writable location first and made executable, then passed as an absolute path.
- `exec()` does not return stdout or stderr, so checks that need output must use `Utilities.Internal.subprocess()` instead.

## Temporary directory

`Zotero.getTempDirectory()` returns an `nsIFile` under the OS temp directory, in a Zotero-specific subfolder on Windows and macOS ([`zotero.js`](https://github.com/zotero/zotero/blob/10.0.6/chrome/content/zotero/xpcom/zotero.js), `getTempDirectory`). The default `zotero_compress_pdf_cache` folder from the original plan can be created beneath it, or the preference can point elsewhere.

## Detecting an open reader tab

There is no documented public accessor for the list of open readers. `Zotero.Reader` exposes `getByTabID(tabID)` and `getWindowStates()`, while the live reader list is the private `_readers` array ([`reader.js`](https://github.com/zotero/zotero/blob/10.0.6/chrome/content/zotero/xpcom/reader.js)). Zotero's own code iterates `Zotero.Reader._readers` in several places.

Prototype implication: iterate `Zotero.Reader._readers` behind a single helper, guard for `undefined`, and treat it as an unstable API. This is the one required behavior that depends on a private field, so it deserves an explicit note in code and a fallback that simply lets the user proceed if the check throws.

## Feedback

`Zotero.ProgressWindow` ([`progressWindow.js`](https://github.com/zotero/zotero/blob/10.0.6/chrome/content/zotero/xpcom/progressWindow.js)) provides the standard headline/lines progress and completion popup. It is sufficient for the prototype's single-file messages; no custom UI is needed.

## File picker

No `Zotero.FilePicker` module was found in the current source. Zotero 8 removed the older `nsIFilePicker` initialization pattern in favor of passing a `BrowsingContext` ([Zotero 8 for Developers](https://www.zotero.org/support/dev/zotero_8_for_developers), platform changes), and recommends Zotero's own file-picker module instead. For the prototype, prefer a plain text preference for the temporary folder, or use the toolkit's dialog helper, and confirm the picker path during the build.

## Version-compatibility risks

The stated target is Zotero 7 and newer, which spans 7.0.x through 10.0.x. Three differences are load-bearing:

1. **Menu API.** `Zotero.MenuManager` is 8.0+, so 7.0.x needs the fallback described above.
2. **Module system.** Zotero 8 moved to ES modules and removed global imports; Zotero 7 uses `.jsm` style. Plugin code that avoids importing Zotero internals and relies only on the injected `Zotero` global and standard browser globals is the safest way to span both. This needs prototype confirmation rather than assumption.
3. **Zotero 10 selection changes.** `Zotero.MenuManager` contexts for `main/library/item` still work, but `collectionTreeRow` now throws on multi-row selections; `collectionTreeRows` is the replacement ([Zotero 10 for Developers](https://www.zotero.org/support/dev/zotero_10_for_developers)). The prototype's menu visibility rule must use `context.items` only, not collection state.

Recommended manifest approach: set `strict_min_version` to `6.999`, and set `strict_max_version` only to the highest version actually tested. Zotero documents that the maximum can later be raised through the update manifest without shipping a new plugin version.

## Open questions for the prototype to settle

- Whether one build genuinely runs on both 7.0.x and 10.0.x, or whether two scaffolding profiles are needed.
- Whether `Utilities.Internal.subprocess()` behaves identically on 7.0.x (stdout capture, cancellation).
- Whether the private `_readers` accessor is stable enough across the supported range to keep the skip-if-open behavior.
