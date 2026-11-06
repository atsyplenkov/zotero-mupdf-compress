/* SPDX-License-Identifier: AGPL-3.0-or-later */

export function eligible(item: Zotero.Item | null | undefined): item is Zotero.Item {
  return !!(
    item &&
    item.isAttachment() &&
    item.attachmentContentType === "application/pdf" &&
    (item.isStoredFileAttachment() || item.isLinkedFileAttachment())
  );
}

function childPdfs(item: Zotero.Item): Zotero.Item[] {
  if (!item.isRegularItem()) return [];
  try {
    return Zotero.Items.get(item.getAttachments()).filter(
      (child) => child.attachmentContentType === "application/pdf",
    );
  } catch {
    return [];
  }
}

function solePdf(item: Zotero.Item): Zotero.Item | null {
  const children = childPdfs(item);
  if (children.length !== 1) return null;
  return eligible(children[0]) ? children[0] : null;
}

export function resolveTarget(items: Zotero.Item[] | null | undefined): Zotero.Item | null {
  if (!items || items.length !== 1) return null;
  const [item] = items;
  return eligible(item) ? item : solePdf(item);
}

function remember(item: Zotero.Item, seen: Set<string>, selected: Zotero.Item[]): void {
  if (!eligible(item)) return;
  const id = `${item.libraryID}:${item.key}`;
  if (seen.has(id)) return;
  seen.add(id);
  selected.push(item);
}

export function selectPdfs(items: Zotero.Item[] | null | undefined): Zotero.Item[] {
  if (!items || items.length === 0) return [];
  const seen = new Set<string>();
  const selected: Zotero.Item[] = [];
  for (const item of items) {
    if (item.isAttachment()) {
      remember(item, seen, selected);
      continue;
    }
    if (!item.isRegularItem()) continue;
    let children: Zotero.Item[] = [];
    try {
      const found = Zotero.Items.get(item.getAttachments());
      children = Array.isArray(found) ? found : [];
    } catch {
      children = [];
    }
    for (const child of children) remember(child, seen, selected);
  }
  return selected;
}
