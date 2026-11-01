/* SPDX-License-Identifier: AGPL-3.0-or-later */

export function fail(code: string): never {
  const error = new Error(code) as Error & { safeCode?: string };
  error.safeCode = code;
  throw error;
}

export function uuid(): string {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

export function component(contract: string): any {
  return (Components.classes as unknown as Record<string, { createInstance(iface: unknown): any }>)[contract];
}

export function localFile(path: string): nsIFile {
  const file = component("@mozilla.org/file/local;1").createInstance(Components.interfaces.nsIFile);
  file.initWithPath(path);
  return file;
}

export function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

export function log(stage: string, code: string): void {
  Zotero.debug(`[MuPDF Compress] ${stage}: ${code}`);
}

export function checkNoSymlinks(path: string, allowMissing = false): void {
  if (typeof path !== "string" || !path.startsWith("/") || path.split("/").includes("..")) {
    fail("unsafe-path");
  }
  let current: nsIFile | null = localFile(path);
  while (current) {
    try {
      if (current.isSymlink()) fail("symlink-path");
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (
        !(allowMissing &&
          ["NS_ERROR_FILE_NOT_FOUND", "NS_ERROR_FILE_TARGET_DOES_NOT_EXIST"].includes(name || ""))
      ) {
        throw error;
      }
    }
    if (!allowMissing && !current.exists()) fail("missing-path");
    current = current.parent;
  }
}

export function fileHash(path: string): string {
  checkNoSymlinks(path);
  const input = component("@mozilla.org/network/file-input-stream;1").createInstance(
    Components.interfaces.nsIFileInputStream,
  );
  const hash = component("@mozilla.org/security/hash;1").createInstance(
    Components.interfaces.nsICryptoHash,
  );
  input.init(localFile(path), 0x01, 0, 0);
  try {
    hash.init(hash.SHA256);
    hash.updateFromStream(input, 0xffffffff);
    return Array.from(hash.finish(false), (byte: string) => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } finally {
    input.close();
  }
}

export function loadModule(esURI: string, jsmURI: string): any {
  try {
    return ChromeUtils.importESModule(esURI);
  } catch {
    return ChromeUtils.import(jsmURI);
  }
}

export async function readResourceBytes(uri: string): Promise<Uint8Array> {
  const { NetUtil } = loadModule(
    "resource://gre/modules/NetUtil.sys.mjs",
    "resource://gre/modules/NetUtil.jsm",
  );
  const channel = NetUtil.newChannel({
    uri,
    loadUsingSystemPrincipal: true,
    securityFlags: Components.interfaces.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    contentPolicyType: Components.interfaces.nsIContentPolicy.TYPE_OTHER,
  });
  return new Promise((resolve, reject) => {
    NetUtil.asyncFetch(channel, (stream: any, status: number) => {
      if (!Components.isSuccessCode(status)) {
        reject(new Error("resource-read"));
        return;
      }
      const binary = component("@mozilla.org/binaryinputstream;1").createInstance(
        Components.interfaces.nsIBinaryInputStream,
      );
      binary.setInputStream(stream);
      try {
        resolve(Uint8Array.from(binary.readByteArray(binary.available())));
      } catch (error) {
        reject(error);
      } finally {
        binary.close();
      }
    });
  });
}

export async function attachmentPath(item: Zotero.Item): Promise<string> {
  const path = await item.getFilePathAsync();
  if (!path || !(await IOUtils.exists(path))) fail("missing");
  checkNoSymlinks(path);
  if (!localFile(path).isFile()) fail("missing");
  return path;
}
