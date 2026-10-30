/* SPDX-License-Identifier: AGPL-3.0-or-later */
{
  const input = document.getElementById("mupdf-compress-temporary-folder");
  const pref = "extensions.mupdf-compress-prototype.temporaryFolder";
  input.value = Zotero.Prefs.get(pref, true) || "";
  input.addEventListener("input", () => Zotero.Prefs.set(pref, input.value.trim(), true));
}
