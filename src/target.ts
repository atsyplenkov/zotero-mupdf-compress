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
    // An item whose child list is unavailable is not a usable parent target.
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
