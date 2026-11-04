declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  addon: import("../src/addon").default;
};

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare namespace Zotero {
  let MuPDFCompress: import("../src/addon").default | undefined;
}
