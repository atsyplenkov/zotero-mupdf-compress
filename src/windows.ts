/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { fail } from "./files.ts";

// All Windows operations here fail closed if Gecko's js-ctypes is unavailable.
// A drive path is required; device namespaces, UNC paths, streams, and Win32
// aliases are deliberately not accepted by the session and extraction code.
export function windowsParts(path: string): string[] {
  if (!/^[a-zA-Z]:\\/.test(path)) fail("unsafe-path");
  const parts = path.slice(3).split("\\");
  if (parts.length === 1 && !parts[0]) return [];
  for (const part of parts) {
    if (!part || /[. ]$/.test(part) || /[<>:"/|?*]/.test(part) ||
        Array.from(part).some((character) => character.charCodeAt(0) < 32) ||
        /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)) {
      fail("unsafe-path");
    }
  }
  return parts;
}

function native<T>(action: (ctypes: any, kernel: any, security: any) => T): T {
  let kernel: any;
  let security: any;
  try {
    const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    kernel = ctypes.open("kernel32.dll");
    security = ctypes.open("advapi32.dll");
    return action(ctypes, kernel, security);
  } catch (error) {
    if ((error as { safeCode?: string }).safeCode) throw error;
    return fail("windows-security-unavailable");
  } finally {
    if (security) security.close();
    if (kernel) kernel.close();
  }
}

export function checkWindowsPath(path: string, allowMissing: boolean): void {
  const parts = windowsParts(path);
  native((ctypes, kernel) => {
    const attributes = kernel.declare("GetFileAttributesW", ctypes.winapi_abi, ctypes.uint32_t, ctypes.jschar.ptr);
    const ptr = ctypes.voidptr_t;
    const dword = ctypes.uint32_t;
    const filetime = ctypes.StructType("FILETIME", [{ low: dword }, { high: dword }]);
    const fileInfo = ctypes.StructType("BY_HANDLE_FILE_INFORMATION", [
      { attributes: dword }, { creation: filetime }, { access: filetime }, { write: filetime },
      { volume: dword }, { sizeHigh: dword }, { sizeLow: dword }, { links: dword },
      { indexHigh: dword }, { indexLow: dword },
    ]);
    const open = kernel.declare("CreateFileW", ctypes.winapi_abi, ptr,
      ctypes.jschar.ptr, dword, dword, ptr, dword, dword, ptr);
    const info = kernel.declare("GetFileInformationByHandle", ctypes.winapi_abi,
      ctypes.int32_t, ptr, fileInfo.ptr);
    const close = kernel.declare("CloseHandle", ctypes.winapi_abi, ctypes.int32_t, ptr);
    const invalid = ctypes.cast(ctypes.intptr_t(-1), ptr).toString();
    let current = path.slice(0, 3);
    for (const part of ["", ...parts]) {
      if (part) current += (current.endsWith("\\") ? "" : "\\") + part;
      const value = Number(attributes(current));
      if (value === 0xffffffff) {
        const error = Number(ctypes.winLastError);
        if (allowMissing && (error === 2 || error === 3)) return;
        if (error === 2 || error === 3) fail("missing-path");
        fail("unsafe-path");
      }
      if (value & 0x400) fail("symlink-path"); // FILE_ATTRIBUTE_REPARSE_POINT, including junctions
      if (!(value & 0x10)) {
        const handle = open(current, 0x80, 7, null, 3, 0x00200000, null);
        if (handle.toString() === invalid) fail("unsafe-path");
        try {
          const stat = fileInfo();
          if (!info(handle, stat.address()) || (Number(stat.attributes) & 0x400) || Number(stat.links) !== 1) {
            fail("unsafe-path");
          }
        } finally { close(handle); }
      }
    }
  });
}

export interface WindowsPrivateOptions {
  privateRoot?: string;
  ignoreExisting?: boolean;
  verifyExistingOnly?: boolean;
}

// Create each private directory with its ACL at creation time. Existing
// directories must already have exactly this protected, owner-only ACL.
export function ensureWindowsPrivateDirectory(path: string, options: WindowsPrivateOptions): void {
  const root = options.privateRoot || path;
  const rootParts = windowsParts(root);
  const parts = windowsParts(path);
  if (root.slice(0, 2).toLowerCase() !== path.slice(0, 2).toLowerCase() ||
      rootParts.length > parts.length ||
      rootParts.some((part, index) => part.toLowerCase() !== parts[index].toLowerCase())) fail("unsafe-path");
  if (!rootParts.length) fail("unsafe-path");
  const parent = rootParts.length === 1 ? root.slice(0, 3) : root.slice(0, root.lastIndexOf("\\"));
  checkWindowsPath(parent, false);
  native((ctypes, kernel, security) => {
    const ptr = ctypes.voidptr_t;
    const dword = ctypes.uint32_t;
    const winapi = ctypes.winapi_abi;
    const BOOL = ctypes.int32_t;
    const sidAttributes = ctypes.StructType("SID_AND_ATTRIBUTES", [{ Sid: ptr }, { Attributes: dword }]);
    const tokenUser = ctypes.StructType("TOKEN_USER", [{ User: sidAttributes }]);
    const securityAttributes = ctypes.StructType("SECURITY_ATTRIBUTES", [
      { nLength: dword }, { lpSecurityDescriptor: ptr }, { bInheritHandle: BOOL },
    ]);
    const currentProcess = kernel.declare("GetCurrentProcess", winapi, ptr);
    const openToken = security.declare("OpenProcessToken", winapi, BOOL, ptr, dword, ptr.ptr);
    const tokenInfo = security.declare("GetTokenInformation", winapi, BOOL, ptr, dword, ptr, dword, dword.ptr);
    const sidString = security.declare("ConvertSidToStringSidW", winapi, BOOL, ptr, ctypes.jschar.ptr.ptr);
    const parseDescriptor = security.declare("ConvertStringSecurityDescriptorToSecurityDescriptorW", winapi,
      BOOL, ctypes.jschar.ptr, dword, ptr.ptr, dword.ptr);
    const stringDescriptor = security.declare("ConvertSecurityDescriptorToStringSecurityDescriptorW", winapi,
      BOOL, ptr, dword, dword, ctypes.jschar.ptr.ptr, dword.ptr);
    const getSecurity = security.declare("GetNamedSecurityInfoW", winapi, dword,
      ctypes.jschar.ptr, dword, dword, ptr.ptr, ptr.ptr, ptr.ptr, ptr.ptr, ptr.ptr);
    const createDirectory = kernel.declare("CreateDirectoryW", winapi, BOOL,
      ctypes.jschar.ptr, securityAttributes.ptr);
    const closeHandle = kernel.declare("CloseHandle", winapi, BOOL, ptr);
    const localFree = kernel.declare("LocalFree", winapi, ptr, ptr);
    const token = ptr();
    let sidText = ctypes.jschar.ptr();
    const descriptor = ptr();
    try {
      if (!openToken(currentProcess(), 8, token.address())) fail("windows-security-unavailable");
      const size = dword();
      tokenInfo(token, 1, null, 0, size.address());
      if (!size.value) fail("windows-security-unavailable");
      const bytes = ctypes.ArrayType(ctypes.uint8_t, Number(size.value))();
      if (!tokenInfo(token, 1, bytes, size.value, size.address())) fail("windows-security-unavailable");
      const user = ctypes.cast(bytes.address(), tokenUser.ptr).contents;
      if (!sidString(user.User.Sid, sidText.address())) fail("windows-security-unavailable");
      const sid = sidText.readString();
      const input = `O:${sid}D:P(A;OICI;FA;;;${sid})`;
      if (!parseDescriptor(input, 1, descriptor.address(), null)) fail("windows-security-unavailable");
      const toString = (sd: any): string => {
        const out = ctypes.jschar.ptr();
        if (!stringDescriptor(sd, 1, 5, out.address(), null)) fail("windows-security-unavailable");
        try { return out.readString().replace("D:PAI", "D:P"); }
        finally { localFree(ctypes.cast(out, ptr)); }
      };
      const expected = toString(descriptor);
      const attributes = securityAttributes();
      attributes.nLength = securityAttributes.size;
      attributes.lpSecurityDescriptor = descriptor;
      attributes.bInheritHandle = 0;
      let current = root;
      const paths = [current];
      for (const part of parts.slice(rootParts.length)) {
        current += "\\" + part;
        paths.push(current);
      }
      for (let index = 0; index < paths.length; index++) {
        current = paths[index];
        if (!options.verifyExistingOnly) {
          const created = Number(createDirectory(current, attributes.address())) !== 0;
          if (!created && Number(ctypes.winLastError) !== 183) fail("windows-private-directory");
          if (!created && index === paths.length - 1 && options.ignoreExisting === false) fail("windows-private-directory");
        }
        checkWindowsPath(current, false);
        const owner = ptr();
        const dacl = ptr();
        const actual = ptr();
        if (Number(getSecurity(current, 1, 5, owner.address(), null, dacl.address(), null, actual.address())) !== 0) {
          fail("windows-private-directory");
        }
        try {
          if (owner.isNull() || dacl.isNull() || toString(actual) !== expected) fail("windows-private-directory");
        } finally { if (!actual.isNull()) localFree(actual); }
      }
    } finally {
      if (!descriptor.isNull()) localFree(descriptor);
      if (!sidText.isNull()) localFree(ctypes.cast(sidText, ptr));
      if (!token.isNull()) closeHandle(token);
    }
  });
}

// A backup is created with its final ACL before any document bytes are written.
// The source and destination stay open without write/delete sharing during copy.
export async function copyWindowsPrivateFile(source: string, destination: string): Promise<void> {
  checkWindowsPath(source, false);
  checkWindowsPath(destination, true);
  const parent = destination.slice(0, destination.lastIndexOf("\\"));
  ensureWindowsPrivateDirectory(parent, { verifyExistingOnly: true });
  let kernel: any;
  let security: any;
  try {
    const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    kernel = ctypes.open("kernel32.dll");
    security = ctypes.open("advapi32.dll");
    const ptr = ctypes.voidptr_t;
    const dword = ctypes.uint32_t;
    const bool = ctypes.int32_t;
    const abi = ctypes.winapi_abi;
    const sidAttributes = ctypes.StructType("SID_AND_ATTRIBUTES", [{ Sid: ptr }, { Attributes: dword }]);
    const tokenUser = ctypes.StructType("TOKEN_USER", [{ User: sidAttributes }]);
    const securityAttributes = ctypes.StructType("SECURITY_ATTRIBUTES", [
      { nLength: dword }, { lpSecurityDescriptor: ptr }, { bInheritHandle: bool },
    ]);
    const filetime = ctypes.StructType("FILETIME", [{ low: dword }, { high: dword }]);
    const fileInfo = ctypes.StructType("BY_HANDLE_FILE_INFORMATION", [
      { attributes: dword }, { creation: filetime }, { access: filetime }, { write: filetime },
      { volume: dword }, { sizeHigh: dword }, { sizeLow: dword }, { links: dword },
      { indexHigh: dword }, { indexLow: dword },
    ]);
    const currentProcess = kernel.declare("GetCurrentProcess", abi, ptr);
    const openToken = security.declare("OpenProcessToken", abi, bool, ptr, dword, ptr.ptr);
    const tokenInfo = security.declare("GetTokenInformation", abi, bool, ptr, dword, ptr, dword, dword.ptr);
    const sidString = security.declare("ConvertSidToStringSidW", abi, bool, ptr, ctypes.jschar.ptr.ptr);
    const parseDescriptor = security.declare("ConvertStringSecurityDescriptorToSecurityDescriptorW", abi,
      bool, ctypes.jschar.ptr, dword, ptr.ptr, dword.ptr);
    const open = kernel.declare("CreateFileW", abi, ptr, ctypes.jschar.ptr, dword, dword,
      securityAttributes.ptr, dword, dword, ptr);
    const fileStat = kernel.declare("GetFileInformationByHandle", abi, bool, ptr, fileInfo.ptr);
    const read = kernel.declare("ReadFile", abi, bool, ptr, ptr, dword, dword.ptr, ptr);
    const write = kernel.declare("WriteFile", abi, bool, ptr, ptr, dword, dword.ptr, ptr);
    const close = kernel.declare("CloseHandle", abi, bool, ptr);
    const free = kernel.declare("LocalFree", abi, ptr, ptr);
    const invalid = ctypes.cast(ctypes.intptr_t(-1), ptr).toString();
    const token = ptr();
    const sid = ctypes.jschar.ptr();
    const descriptor = ptr();
    let input: any;
    let output: any;
    try {
      if (!openToken(currentProcess(), 8, token.address())) fail("windows-security-unavailable");
      const size = dword();
      tokenInfo(token, 1, null, 0, size.address());
      if (!size.value) fail("windows-security-unavailable");
      const userBytes = ctypes.ArrayType(ctypes.uint8_t, Number(size.value))();
      if (!tokenInfo(token, 1, userBytes, size.value, size.address())) fail("windows-security-unavailable");
      const user = ctypes.cast(userBytes.address(), tokenUser.ptr).contents;
      if (!sidString(user.User.Sid, sid.address())) fail("windows-security-unavailable");
      const value = sid.readString();
      if (!parseDescriptor(`O:${value}D:P(A;;FA;;;${value})`, 1, descriptor.address(), null)) {
        fail("windows-security-unavailable");
      }
      const attributes = securityAttributes();
      attributes.nLength = securityAttributes.size;
      attributes.lpSecurityDescriptor = descriptor;
      attributes.bInheritHandle = 0;
      input = open(source, 0x80000000, 1, null, 3, 0x00200000, null);
      if (input.toString() === invalid) { input = null; fail("backup"); }
      const stat = fileInfo();
      if (!fileStat(input, stat.address()) || (Number(stat.attributes) & (0x400 | 0x10)) || Number(stat.links) !== 1) {
        fail("unsafe-path");
      }
      output = open(destination, 0x40000000, 0, attributes.address(), 1, 0x00200000, null);
      if (output.toString() === invalid) { output = null; fail("backup"); }
      const buffer = ctypes.ArrayType(ctypes.uint8_t, 1024 * 1024)();
      for (;;) {
        const received = dword();
        if (!read(input, buffer, buffer.length, received.address(), null)) fail("backup");
        if (!received.value) break;
        const written = dword();
        if (!write(output, buffer, received.value, written.address(), null) || written.value !== received.value) {
          fail("backup");
        }
        await new Promise<void>((resolve) => { Zotero.setTimeout(resolve, 0); });
      }
    } finally {
      if (output) close(output);
      if (input) close(input);
      if (!descriptor.isNull()) free(descriptor);
      if (!sid.isNull()) free(ctypes.cast(sid, ptr));
      if (!token.isNull()) close(token);
    }
  } catch (error) {
    if ((error as { safeCode?: string }).safeCode) throw error;
    fail("windows-security-unavailable");
  } finally {
    if (security) security.close();
    if (kernel) kernel.close();
  }
}

// ReplaceFileW keeps the replaced file's security metadata. Never request
// REPLACEFILE_IGNORE_MERGE_ERRORS: an ACL merge failure must stop replacement.
export function replaceWindowsFile(output: string, original: string): void {
  checkWindowsPath(original, false);
  checkWindowsPath(output, false);
  native((ctypes, kernel) => {
    const replace = kernel.declare("ReplaceFileW", ctypes.winapi_abi, ctypes.int32_t,
      ctypes.jschar.ptr, ctypes.jschar.ptr, ctypes.jschar.ptr, ctypes.uint32_t,
      ctypes.voidptr_t, ctypes.voidptr_t);
    if (!replace(original, output, null, 0, null, null)) fail("replacement");
  });
}
