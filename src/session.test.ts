/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal, ok, rejects } from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, statSync, accessSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Exercise the extension's session APIs with Node adapters for Gecko host APIs.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (process.platform === "win32" && specifier === "./windows.ts") {
      return nextResolve(new URL("./test-fixtures/windows-node-host.mjs", import.meta.url).href, context);
    }
    if (specifier === "./engine" || specifier === "./files") return nextResolve(specifier + ".ts", context);
    return nextResolve(specifier, context);
  },
});
let session: typeof import("./session.ts");
try {
  session = await import("./session.ts");
} finally {
  hooks.deregister();
}
const { cleanSession, initSession, releaseLock } = session;
const nativeDirectory = resolve(process.env.MUPDF_NATIVE_DIR || fileURLToPath(new URL(
  `../addon/native/${process.platform === "win32" ? "windows-x86_64" : "linux-x86_64"}`, import.meta.url,
)));
const helper = join(nativeDirectory, process.platform === "win32" ? "session-lock.exe" : "session-lock");

async function makePrivateDirectory(path: string) {
  if (process.platform === "win32") {
    const { ensureWindowsPrivateDirectory } = await import("./test-fixtures/windows-node-host.mjs");
    ensureWindowsPrivateDirectory(path, { ignoreExisting: false });
  } else await mkdir(path);
}

class LocalFile {
  path = "";
  initWithPath(path: string) { this.path = path; }
  get parent(): LocalFile | null {
    const parent = dirname(this.path);
    if (parent === this.path) return null;
    const file = new LocalFile();
    file.initWithPath(parent);
    return file;
  }
  get leafName() { return basename(this.path); }
  exists() { return existsSync(this.path); }
  isSymlink() {
    try { return lstatSync(this.path).isSymbolicLink(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  isDirectory() { return statSync(this.path).isDirectory(); }
  isFile() { return statSync(this.path).isFile(); }
  isWritable() {
    try { accessSync(this.path, constants.W_OK); return true; }
    catch { return false; }
  }
}

function pipe(stream: Readable) {
  const iterator = stream[Symbol.asyncIterator]();
  let buffer = "";
  let ended = false;
  return {
    async readString(length = 1): Promise<string | undefined> {
      while (buffer.length < length && !ended) {
        const chunk = await iterator.next();
        if (chunk.done) ended = true;
        else buffer += chunk.value.toString();
      }
      if (!buffer) return undefined;
      const result = buffer.slice(0, length);
      buffer = buffer.slice(length);
      return result;
    },
  };
}

async function withSessionHost(
  run: (folder: string, subprocess: unknown) => Promise<void>,
  windows = process.platform === "win32",
) {
  const folder = await mkdtemp(join(tmpdir(), "mupdf session café 文献-"));
  const children = new Map<ReturnType<typeof spawn>, Promise<void>>();
  const openLocks = new Set<string>();
  const subprocess = {
    async call({ command, arguments: args }: { command: string; arguments: string[] }) {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      openLocks.add(args[0]);
      const timer = setTimeout(() => child.kill("SIGKILL"), process.platform === "win32" ? 30000 : 5000);
      const exited = new Promise<void>((resolve) => {
        child.once("error", () => {});
        child.once("close", () => {
          clearTimeout(timer);
          children.delete(child);
          openLocks.delete(args[0]);
          resolve();
        });
      });
      children.set(child, exited);
      child.stdin.on("error", () => {});
      return {
        pid: child.pid,
        stdin: { async close() { child.stdin.end(); } },
        stdout: pipe(child.stdout), stderr: pipe(child.stderr),
        wait: () => exited,
        kill: () => child.kill("SIGKILL"),
      };
    },
  };
  const globals = {
    Services: { uuid: { generateUUID: () => `{${randomUUID()}}` }, appinfo: { OS: windows ? "WINNT" : "Linux" } },
    Zotero: { Prefs: { get: () => folder }, debug: () => {} },
    Components: {
      classes: { "@mozilla.org/file/local;1": { createInstance: () => new LocalFile() } },
      interfaces: { nsIFile: {} },
    },
    IOUtils: {
      makeDirectory: (path: string, options: { permissions: number; ignoreExisting?: boolean }) =>
        mkdir(path, { mode: options.permissions, recursive: options.ignoreExisting }),
      exists: async (path: string) => existsSync(path),
      getChildren: async (path: string) => (await readdir(path)).map((entry) => join(path, entry)),
      stat: async (path: string) => {
        const info = await stat(path);
        return { size: info.size, type: info.isFile() ? "regular" : "other" };
      },
      readUTF8: (path: string) => readFile(path, "utf8"),
      writeUTF8: (path: string, value: string) => writeFile(path, value, { flag: "wx" }),
      remove: async (path: string) => {
        if (windows && openLocks.has(path)) throw new Error("sharing violation");
        if (lstatSync(path).isDirectory()) await rmdir(path);
        else await unlink(path);
      },
    },
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    await run(folder, subprocess);
  } finally {
    const pending = [...children.values()];
    for (const child of children.keys()) child.kill("SIGKILL");
    await Promise.all(pending);
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
    await rm(folder, { recursive: true, force: true });
  }
}

test("startup cleanup respects active ownership and removes only recognized abandoned sessions", async () => {
  await withSessionHost(async (folder, subprocess) => {
    const first = await initSession(subprocess, helper);
    const root = join(folder, "mupdf-compress-v1");
    const backupName = `${randomUUID()}.pdf`;
    const activeBackup = join(first.sessionDir, backupName);
    await writeFile(activeBackup, "active original");

    const abandoned = join(root, randomUUID());
    await makePrivateDirectory(abandoned);
    await writeFile(join(abandoned, "owner.txt"), "MuPDF Compress session v1\n");
    await writeFile(join(abandoned, `${randomUUID()}.pdf`), "abandoned original");

    const unrelated = join(root, "unrelated");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep"), "unrelated");
    const outside = join(folder, "outside");
    await mkdir(outside);
    const sentinel = join(outside, "keep");
    await writeFile(sentinel, "outside");
    const redirected = join(root, randomUUID());
    await symlink(outside, redirected, process.platform === "win32" ? "junction" : "dir");

    const unsafe = join(root, randomUUID());
    await makePrivateDirectory(unsafe);
    await writeFile(join(unsafe, "owner.txt"), "MuPDF Compress session v1\n");
    const unsafeLink = join(unsafe, `${randomUUID()}.pdf`);
    await symlink(process.platform === "win32" ? outside : sentinel, unsafeLink,
      process.platform === "win32" ? "junction" : "file");

    const second = await initSession(subprocess, helper);
    equal(await readFile(activeBackup, "utf8"), "active original");
    equal(existsSync(abandoned), false);
    equal(await readFile(join(unrelated, "keep"), "utf8"), "unrelated");
    equal(await readFile(sentinel, "utf8"), "outside");
    ok(lstatSync(redirected).isSymbolicLink());
    ok(lstatSync(unsafeLink).isSymbolicLink());

    await releaseLock(first.lock);
    const third = await initSession(subprocess, helper);
    equal(existsSync(first.sessionDir), false);
    equal(await readFile(sentinel, "utf8"), "outside");
    equal(await cleanSession(second.sessionDir, second.lock), true);
    await releaseLock(second.lock);
    equal(await cleanSession(third.sessionDir, third.lock), true);
    await releaseLock(third.lock);
  });
});

test("cleanup refuses a lock owned by another session", async () => {
  await withSessionHost(async (_folder, subprocess) => {
    const first = await initSession(subprocess, helper);
    const second = await initSession(subprocess, helper);
    const backup = join(second.sessionDir, `${randomUUID()}.pdf`);
    await writeFile(backup, "second original");
    try {
      equal(await cleanSession(second.sessionDir, first.lock), false);
      equal(await readFile(backup, "utf8"), "second original");
    } finally {
      await releaseLock(first.lock);
      await releaseLock(second.lock);
    }
  });
});

test("a failed directory removal leaves a recognized session for a safe retry", async () => {
  await withSessionHost(async (_folder, subprocess) => {
    const owned = await initSession(subprocess, helper);
    const marker = join(owned.sessionDir, "owner.txt");
    const backup = join(owned.sessionDir, `${randomUUID()}.pdf`);
    await writeFile(backup, "original");
    const io = (globalThis as any).IOUtils;
    const remove = io.remove;
    let failOnce = true;
    io.remove = async (path: string) => {
      if (path === owned.sessionDir && failOnce) {
        failOnce = false;
        throw new Error("directory busy");
      }
      await remove(path);
    };
    try {
      await rejects(cleanSession(owned.sessionDir, owned.lock), /directory busy/);
      equal(await readFile(marker, "utf8"), "MuPDF Compress session v1\n");
      equal(owned.lock.alive, true);
      equal(await cleanSession(owned.sessionDir, owned.lock), true);
      equal(existsSync(owned.sessionDir), false);
    } finally {
      io.remove = remove;
      await releaseLock(owned.lock);
    }
  }, true);
});

test("Windows cleanup removes session backups while the lock file remains open", async () => {
  await withSessionHost(async (_folder, subprocess) => {
    const owned = await initSession(subprocess, helper);
    const backup = join(owned.sessionDir, `${randomUUID()}.pdf`);
    await writeFile(backup, "original");
    try {
      equal(await cleanSession(owned.sessionDir, owned.lock), true);
      equal(existsSync(owned.sessionDir), false);
      equal(owned.lock.alive, true);
    } finally {
      await releaseLock(owned.lock);
    }
  }, true);
});

test("release waits for a killed lock helper to exit", async () => {
  let finish!: () => void;
  let killed = false;
  let released = false;
  const exited = new Promise<void>((resolve) => { finish = resolve; });
  const lock = {
    directory: "/owned",
    alive: true,
    proc: {
      stdin: { async close() { throw new Error("close failed"); } },
      wait: () => exited,
      kill: () => { killed = true; },
    },
  };
  const pending = releaseLock(lock).then(() => { released = true; });
  await Promise.resolve();
  await Promise.resolve();
  equal(killed, true);
  equal(released, false);
  finish();
  await pending;
  equal(lock.alive, false);
});

test("Windows startup removes its empty session directory if the owner marker cannot be written", async () => {
  await withSessionHost(async (folder, subprocess) => {
    const io = (globalThis as any).IOUtils;
    io.writeUTF8 = async () => { throw new Error("marker write failed"); };
    await rejects(initSession(subprocess, helper), /marker write failed/);
    const entries = await readdir(join(folder, "mupdf-compress-v1"), { withFileTypes: true });
    equal(entries.length, 1);
    equal(entries[0].isFile(), true);
    equal(entries[0].name.endsWith(".lock"), true);
  }, true);
});

test("session startup stops when exclusive ownership cannot be established", async () => {
  await withSessionHost(async (folder, subprocess) => {
    await rejects(initSession(subprocess, join(folder, "missing-helper")), { safeCode: "lock-unavailable" });
    equal((await readdir(join(folder, "mupdf-compress-v1"))).length, 0);
  });
});
