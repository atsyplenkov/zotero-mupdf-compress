/* SPDX-License-Identifier: AGPL-3.0-or-later */

export function eligible(item: Zotero.Item | null | undefined): item is Zotero.Item {
  return !!(
    item &&
    item.isAttachment() &&
    item.attachmentContentType === "application/pdf" &&
    (item.isStoredFileAttachment() || item.isLinkedFileAttachment())
  );
}

export function resolveTarget(items: Zotero.Item[] | null | undefined): Zotero.Item | null {
  if (!items || items.length !== 1) return null;
  const [item] = items;
  return eligible(item) ? item : null;
}
