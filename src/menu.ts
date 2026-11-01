/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { log } from "./files";
import { resolveTarget } from "./target";
import type { Action } from "./types";

const MENU_ID = "mupdf-compress-itemmenu";
const SUBMENU_LABEL = "Compress PDF";

type MainWindow = Window & {
  ZoteroPane?: { getSelectedItems(): Zotero.Item[] };
};

interface WindowMenu {
  popup: XULElement;
  menu: XULElement;
  onShowing: (event: Event) => void;
  commands: Array<{ element: XULElement; listener: EventListener }>;
}

const windowMenus = new Map<Window, WindowMenu>();
let registered: string | null = null;

function invoke(action: Action, items: Zotero.Item[] | null | undefined): void {
  const operation = addon.operation;
  if (!operation) return;
  const target = resolveTarget(items);
  const run = action === "Compress" ? operation.compress(target) : operation.revert(target);
  run.catch((error: unknown) => {
    log("menu", (error as { safeCode?: string }).safeCode || "action-failed");
  });
}

function registerWithMenuManager(): string | null {
  const manager = Zotero.MenuManager;
  if (!manager || typeof manager.registerMenu !== "function") return null;
  const menuID = manager.registerMenu({
    menuID: MENU_ID,
    pluginID: addon.data.config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "submenu",
        onShowing(_event, context) {
          context.menuElem.id = MENU_ID;
          context.menuElem.setAttribute("label", SUBMENU_LABEL);
          context.setVisible(!!resolveTarget(context.items));
        },
        menus: [
          {
            menuType: "menuitem",
            onShowing(_event, context) {
              context.menuElem.setAttribute("label", "Compress");
            },
            onCommand(_event, context) {
              invoke("Compress", context.items);
            },
          },
          {
            menuType: "menuitem",
            onShowing(_event, context) {
              context.menuElem.setAttribute("label", "Revert");
            },
            onCommand(_event, context) {
              invoke("Revert", context.items);
            },
          },
        ],
      },
    ],
  });
  return typeof menuID === "string" ? menuID : null;
}

function injectMenu(win: Window): void {
  const main = win as MainWindow;
  const popup = win.document.getElementById("zotero-itemmenu") as XULElement | null;
  const pane = main.ZoteroPane;
  if (!popup || !pane || windowMenus.has(win)) return;
  const doc = win.document;
  const menu = doc.createXULElement("menu") as XULElement;
  menu.id = MENU_ID;
  menu.setAttribute("label", SUBMENU_LABEL);
  const children = doc.createXULElement("menupopup") as XULElement;
  const commands: WindowMenu["commands"] = [];
  for (const action of ["Compress", "Revert"] as Action[]) {
    const entry = doc.createXULElement("menuitem") as XULElement;
    entry.setAttribute("label", action);
    const listener: EventListener = () => invoke(action, pane.getSelectedItems());
    entry.addEventListener("command", listener);
    commands.push({ element: entry, listener });
    children.appendChild(entry);
  }
  menu.appendChild(children);
  const onShowing = (event: Event) => {
    if (event.target !== popup) return;
    menu.hidden = !resolveTarget(pane.getSelectedItems());
  };
  popup.addEventListener("popupshowing", onShowing);
  popup.appendChild(menu);
  windowMenus.set(win, { popup, menu, onShowing, commands });
}

function removeMenu(win: Window): void {
  const entry = windowMenus.get(win);
  if (!entry) return;
  entry.popup.removeEventListener("popupshowing", entry.onShowing);
  for (const command of entry.commands) {
    command.element.removeEventListener("command", command.listener);
  }
  entry.menu.remove();
  windowMenus.delete(win);
}

export function registerMenus(): void {
  unregisterMenus();
  registered = registerWithMenuManager();
}

export function unregisterMenus(): void {
  if (registered) {
    try {
      Zotero.MenuManager.unregisterMenu(registered);
    } catch {
      // The manager may already be shutting down with its plugin registrations.
    }
    registered = null;
    // The manager only removes elements when it unregisters a registration, and
    // its own plugin shutdown observer runs after this function. Remove the
    // owned element explicitly so disable leaves no stale menu behind.
    for (const win of Zotero.getMainWindows()) {
      win.document.getElementById(MENU_ID)?.remove();
    }
  }
  for (const win of windowMenus.keys()) {
    removeMenu(win);
  }
}

export function onMainWindowLoad(win: Window): void {
  if (registered) return;
  injectMenu(win);
}

export function onMainWindowUnload(win: Window): void {
  removeMenu(win);
}
