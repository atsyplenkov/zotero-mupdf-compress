/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { checkWindowsPath, copyWindowsPrivateFile, ensureWindowsPrivateDirectory, replaceWindowsFile } from "./windows.ts";

export function fail(code: string, checkedPath?: string): never {
  const error = new Error(code) as Error & { safeCode?: string; checkedPath?: string };
  error.safeCode = code;
  if (checkedPath !== undefined) error.checkedPath = checkedPath;
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
  if (/^[a-zA-Z]:[\\/]/.test(parts[0] || "")) {
    return parts.join("\\").replace(/[\\/]+/g, "\\");
  }
  return parts.join("/").replace(/\/+/g, "/");
}

export function log(stage: string, code: string): void {
  Zotero.debug(`[MuPDF Compress] ${stage}: ${code}`);
}

function windowsFileSystem(path: string): boolean {
  return (typeof Zotero !== "undefined" && Zotero.isWin) || /^[a-zA-Z]:/.test(path);
}

export function checkNoSymlinks(path: string, allowMissing = false): void {
  if (typeof path === "string" && windowsFileSystem(path)) {
    checkWindowsPath(path, allowMissing);
    return;
  }
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.split("/").includes("..")) {
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

export async function ensurePrivateDirectory(
  path: string,
  options: { privateRoot?: string; ignoreExisting?: boolean; verifyExistingOnly?: boolean } = {},
): Promise<void> {
  if (windowsFileSystem(path)) {
    ensureWindowsPrivateDirectory(path, options);
    return;
  }
  if (options.verifyExistingOnly) {
    checkNoSymlinks(path);
    if (!localFile(path).isDirectory()) fail("unsafe-path");
    return;
  }
  await IOUtils.makeDirectory(path, {
    permissions: 0o700,
    createAncestors: Boolean(options.privateRoot && options.privateRoot !== path),
    ignoreExisting: options.ignoreExisting !== false,
  });
}

export async function copyPrivateFile(source: string, destination: string): Promise<void> {
  if (windowsFileSystem(destination)) {
    await copyWindowsPrivateFile(source, destination);
    return;
  }
  await IOUtils.copy(source, destination, { noOverwrite: true });
  await IOUtils.setPermissions(destination, 0o600);
}

export async function replaceFile(output: string, original: string): Promise<void> {
  if (windowsFileSystem(original)) {
    replaceWindowsFile(output, original);
    return;
  }
  await IOUtils.setPermissions(output, localFile(original).permissions & 0o777);
  await IOUtils.move(output, original);
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
