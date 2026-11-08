/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { deepEqual, equal, ifError, match, notEqual, rejects, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join as nodeJoin } from "node:path";
import { test } from "node:test";
import { checkNoSymlinks, copyPrivateFile, ensurePrivateDirectory, join, replaceFile } from "./files.ts";
import { windowsCtypes } from "./test-fixtures/fake-windows-ctypes.mjs";

test("Windows paths keep their drive, Unicode names, and native separators", () => {
  equal(join("C:\\Users\\Zoë 文献", "mupdf-compress", "backup.pdf"),
    "C:\\Users\\Zoë 文献\\mupdf-compress\\backup.pdf");
});

test("Windows path checks reject redirected ancestors", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "ChromeUtils");
  const ptr = Object.assign(() => ({}), { ptr: {} });
  const types = {
    winapi_abi: {}, uint32_t: {}, int32_t: {}, voidptr_t: ptr, jschar: { ptr: {} },
    intptr_t: (value: number) => value,
    cast: () => ({ toString: () => "invalid" }),
    StructType: () => Object.assign(() => ({}), { ptr: {} }),
    open: () => ({
      close() {},
      declare(name: string) {
        if (name === "GetFileAttributesW") {
          return (path: string) => path === "C:\\Users\\Junction" ? 0x410 : 0x10;
        }
        return () => 1;
      },
    }),
  };
  Object.defineProperty(globalThis, "ChromeUtils", {
    configurable: true,
    value: { importESModule: () => ({ ctypes: types }) },
  });
  try {
    checkNoSymlinks("C:\\Users\\Zoë 文献");
    throws(() => checkNoSymlinks("C:\\Users\\Junction\\attachment.pdf"), { safeCode: "symlink-path" });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "ChromeUtils", descriptor);
    else Reflect.deleteProperty(globalThis, "ChromeUtils");
  }
});

test("Windows private directory creation supplies a protected owner-only ACL at creation", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "ChromeUtils");
  const host = windowsCtypes();
  Object.defineProperty(globalThis, "ChromeUtils", {
    configurable: true, value: { importESModule: () => ({ ctypes: host.ctypes }) },
  });
  try {
    const root = "C:\\Users\\Zoë\\mupdf-compress";
    const target = `${root}\\windows-x86_64\\artifact`;
    await ensurePrivateDirectory(target, { privateRoot: root });
    deepEqual(host.created, [root, `${root}\\windows-x86_64`, target]);
    for (const path of host.created) {
      equal(host.entries.get(path)?.sddl, `O:${host.sid}D:P(A;OICI;FA;;;${host.sid})`);
    }
  } finally {
    if (original) Object.defineProperty(globalThis, "ChromeUtils", original);
    else Reflect.deleteProperty(globalThis, "ChromeUtils");
  }
});

test("Windows refuses an existing directory with a foreign ACL without rewriting it", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "ChromeUtils");
  const host = windowsCtypes();
  const root = "C:\\Users\\Zoë\\mupdf-compress";
  const foreign = "O:foreignD:P(A;OICI;FA;;;foreign)";
  host.entries.set(root, { attributes: 0x10, sddl: foreign });
  Object.defineProperty(globalThis, "ChromeUtils", {
    configurable: true, value: { importESModule: () => ({ ctypes: host.ctypes }) },
  });
  try {
    await rejects(ensurePrivateDirectory(root), { safeCode: "windows-private-directory" });
    equal(host.entries.get(root)?.sddl, foreign);
    deepEqual(host.created, []);
  } finally {
    if (original) Object.defineProperty(globalThis, "ChromeUtils", original);
    else Reflect.deleteProperty(globalThis, "ChromeUtils");
  }
});

test("Windows private backup creation applies its ACL before document bytes are written", async () => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "ChromeUtils");
  const originalZotero = Object.getOwnPropertyDescriptor(globalThis, "Zotero");
  const host = windowsCtypes();
  const session = "C:\\Users\\Zoë\\session";
  const source = "C:\\Users\\Zoë\\attachment.pdf";
  const output = `${session}\\backup.pdf`;
  host.entries.set(session, { attributes: 0x10, sddl: `O:${host.sid}D:P(A;OICI;FA;;;${host.sid})` });
  host.entries.set(source, { attributes: 0, bytes: Buffer.from("original") });
  Object.defineProperty(globalThis, "ChromeUtils", {
    configurable: true, value: { importESModule: () => ({ ctypes: host.ctypes }) },
  });
  Object.defineProperty(globalThis, "Zotero", {
    configurable: true, value: { setTimeout: (callback: () => void) => queueMicrotask(callback) },
  });
  try {
    await copyPrivateFile(source, output);
    const copied = host.entries.get(output);
    equal(copied?.sddl, `O:${host.sid}D:P(A;;FA;;;${host.sid})`);
    equal(copied?.bytes.toString(), "original");
    equal(copied?.privateBeforeWrite, true);
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, "ChromeUtils", originalChrome);
    else Reflect.deleteProperty(globalThis, "ChromeUtils");
    if (originalZotero) Object.defineProperty(globalThis, "Zotero", originalZotero);
    else Reflect.deleteProperty(globalThis, "Zotero");
  }
});

test("Windows replacement requires security metadata merging without ignore-error flags", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "ChromeUtils");
  const host = windowsCtypes();
  const source = "C:\\Users\\Zoë\\attachment.pdf";
  const output = "C:\\Users\\Zoë\\replacement.pdf";
  host.entries.set(source, { attributes: 0, sddl: "inherited-original" });
  host.entries.set(output, { attributes: 0, sddl: "private-output" });
  Object.defineProperty(globalThis, "ChromeUtils", {
    configurable: true, value: { importESModule: () => ({ ctypes: host.ctypes }) },
  });
  try {
    await replaceFile(output, source);
    deepEqual(host.replacements, [{ original: source, replacement: output, backup: null, flags: 0 }]);
    equal(host.entries.get(source)?.sddl, "inherited-original");
  } finally {
    if (original) Object.defineProperty(globalThis, "ChromeUtils", original);
    else Reflect.deleteProperty(globalThis, "ChromeUtils");
  }
});

for (const scenario of [
  { name: "an inherited attachment ACL from a different parent", sibling: false, acl: "inherited" },
  { name: "an inherited attachment ACL from the same parent", sibling: true, acl: "inherited" },
  { name: "a protected attachment ACL from a different parent", sibling: false, acl: "protected" },
  { name: "a mixed attachment ACL from a different parent", sibling: false, acl: "mixed" },
]) {
  test(`Windows replacement retains ${scenario.name}`, {
    skip: process.platform !== "win32",
  }, async () => {
    const folder = await mkdtemp(nodeJoin(tmpdir(), "mupdf replace café 文献-"));
    const helper = process.env.MUPDF_WINDOWS_TEST_HOST;
    try {
      if (!helper) throw new Error("MUPDF_WINDOWS_TEST_HOST is required");
      const granted = spawnSync("icacls.exe", [folder, "/grant", "*S-1-5-32-545:(OI)(CI)RX"], { encoding: "utf8" });
      ifError(granted.error);
      equal(granted.status, 0, granted.stderr);
      const privateDirectory = nodeJoin(folder, "private");
      const { ensureWindowsPrivateDirectory } = await import("./test-fixtures/windows-node-host.mjs");
      ensureWindowsPrivateDirectory(privateDirectory, { ignoreExisting: false });
      const attachment = nodeJoin(folder, "attachment.pdf");
      let output = nodeJoin(privateDirectory, "replacement.pdf");
      await writeFile(attachment, "original");
      await writeFile(output, "replacement");
      if (scenario.acl !== "inherited") {
        const args = scenario.acl === "protected"
          ? [attachment, "/inheritance:d"]
          : [attachment, "/grant", "*S-1-5-11:R"];
        const changed = spawnSync("icacls.exe", args, { encoding: "utf8" });
        ifError(changed.error);
        equal(changed.status, 0, changed.stderr);
      }
      const descriptor = (path: string) => {
        const result = spawnSync(helper, ["--test-security-descriptor", path], { encoding: "utf8" });
        ifError(result.error);
        equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const before = descriptor(attachment);
      match(before, scenario.acl === "protected" ? /D:P/ : /D:(?!P)/);
      const privateAcl = descriptor(output);
      notEqual(before, privateAcl);
      if (scenario.sibling) {
        const sibling = nodeJoin(folder, "replacement.pdf");
        await rename(output, sibling);
        output = sibling;
        equal(descriptor(output), privateAcl, "Moving the output must keep its bytes private");
      }
      const result = spawnSync(helper, ["--test-replace-file", attachment, output], { encoding: "utf8" });
      ifError(result.error);
      equal(result.status, 0, result.stderr);
      equal(await readFile(attachment, "utf8"), "replacement");
      equal(descriptor(attachment), before);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

}

test("Windows path checks reject a hard-linked regular file", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "ChromeUtils");
  const host = windowsCtypes();
  const path = "C:\\Users\\Zoë\\backup.pdf";
  host.entries.set(path, { attributes: 0, links: 2 });
  Object.defineProperty(globalThis, "ChromeUtils", {
    configurable: true, value: { importESModule: () => ({ ctypes: host.ctypes }) },
  });
  try {
    throws(() => checkNoSymlinks(path), { safeCode: "unsafe-path" });
  } finally {
    if (original) Object.defineProperty(globalThis, "ChromeUtils", original);
    else Reflect.deleteProperty(globalThis, "ChromeUtils");
  }
});

test("private backup copies are not overwritten and are readable only by their owner", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(nodeJoin(tmpdir(), "mupdf-private-copy-"));
  const original = Object.getOwnPropertyDescriptor(globalThis, "IOUtils");
  Object.defineProperty(globalThis, "IOUtils", {
    configurable: true,
    value: {
      copy: (source: string, target: string) => copyFile(source, target, constants.COPYFILE_EXCL),
      setPermissions: (path: string, mode: number) => chmod(path, mode),
    },
  });
  try {
    const source = nodeJoin(directory, "source.pdf");
    const backup = nodeJoin(directory, "backup.pdf");
    await writeFile(source, "original");
    await copyPrivateFile(source, backup);
    equal(await readFile(backup, "utf8"), "original");
    equal((await stat(backup)).mode & 0o777, 0o600);
    await rejects(copyPrivateFile(source, backup));
    equal(await readFile(backup, "utf8"), "original");
  } finally {
    if (original) Object.defineProperty(globalThis, "IOUtils", original);
    else Reflect.deleteProperty(globalThis, "IOUtils");
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Windows host never falls back to POSIX file operations for non-drive paths", async () => {
  const originalZotero = Object.getOwnPropertyDescriptor(globalThis, "Zotero");
  const originalIO = Object.getOwnPropertyDescriptor(globalThis, "IOUtils");
  let calls = 0;
  Object.defineProperty(globalThis, "Zotero", { configurable: true, value: { isWin: true } });
  Object.defineProperty(globalThis, "IOUtils", {
    configurable: true,
    value: { makeDirectory: async () => { calls++; }, copy: async () => { calls++; }, setPermissions: async () => { calls++; } },
  });
  try {
    for (const path of ["/temporary/session", "\\\\server\\share\\session"]) {
      throws(() => checkNoSymlinks(path), { safeCode: "unsafe-path" });
      await rejects(ensurePrivateDirectory(path), { safeCode: "unsafe-path" });
      await rejects(copyPrivateFile(path, path), { safeCode: "unsafe-path" });
      await rejects(replaceFile("C:\\output.pdf", path), { safeCode: "unsafe-path" });
    }
    equal(calls, 0);
  } finally {
    if (originalZotero) Object.defineProperty(globalThis, "Zotero", originalZotero);
    else Reflect.deleteProperty(globalThis, "Zotero");
    if (originalIO) Object.defineProperty(globalThis, "IOUtils", originalIO);
    else Reflect.deleteProperty(globalThis, "IOUtils");
  }
});

test("Windows device names, streams and relative paths are rejected", () => {
  for (const path of ["C:relative", "C:\\Users\\..\\file", "C:\\NUL.txt", "C:\\file:stream",
    "\\\\?\\C:\\file", "//server/share"]) {
    throws(() => checkNoSymlinks(path), { safeCode: "unsafe-path" });
  }
});
