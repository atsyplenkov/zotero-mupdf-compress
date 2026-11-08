/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal, ifError } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";
const nativeDirectory = resolve(process.env.MUPDF_NATIVE_DIR || fileURLToPath(new URL(
  `../addon/native/${windows ? "windows-x86_64" : "linux-x86_64"}`, import.meta.url,
)));
const helper = join(nativeDirectory, windows ? "session-lock.exe" : "session-lock");
const timeout = windows ? 30000 : 5000;

function startOwner(path: string) {
  const child = spawn(helper, [path], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("timed out waiting for session lock")), timeout);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("\n")) {
        if (output === "LOCKED\n") finish();
        else finish(new Error(`unexpected session lock output: ${JSON.stringify(output)}`));
      }
    };
    const onError = (error: Error) => finish(error);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`session lock exited before ownership: ${code ?? signal}`));
    };
    function finish(error?: Error) {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    }
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
  return { child, ready, exited };
}

async function waitForExit(owner: ReturnType<typeof startOwner>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      owner.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for session lock exit")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withOwner(path: string, run: (owner: ReturnType<typeof startOwner>) => Promise<void>) {
  const owner = startOwner(path);
  try {
    await owner.ready;
    await run(owner);
  } finally {
    owner.child.kill("SIGKILL");
    await waitForExit(owner);
  }
}

async function withDirectory(run: (directory: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "mupdf lock café 文献-"));
  try {
    let directory = temporary;
    if (windows) {
      directory = join(temporary, "private");
      const { ensureWindowsPrivateDirectory } = await import("./test-fixtures/windows-node-host.mjs");
      ensureWindowsPrivateDirectory(directory, { ignoreExisting: false });
    }
    await run(directory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function runHelper(path: string, cwd?: string) {
  const result = spawnSync(helper, [path], { cwd, encoding: "utf8", input: "", timeout });
  ifError(result.error);
  return result;
}

function expectRefusal(path: string, cwd?: string) {
  const result = runHelper(path, cwd);
  equal(result.status, 1);
  equal(result.stdout, "");
}

test("relative paths and paths containing dot components are refused", async () => {
  await withDirectory(async (directory) => {
    expectRefusal("relative.lock", directory);
    expectRefusal(`${directory}/../${basename(directory)}/dot-dot.lock`);
    expectRefusal(`${directory}/./dot.lock`);
    expectRefusal(`${directory}//empty.lock`);
  });
});

test("symbolic links at the lock file or an ancestor are refused", async () => {
  await withDirectory(async (directory) => {
    const realDirectory = join(directory, "real");
    const realFile = join(realDirectory, "target");
    const lockLink = join(directory, "lock-link");
    const directoryLink = join(directory, "directory-link");
    if (windows) {
      const { ensureWindowsPrivateDirectory } = await import("./test-fixtures/windows-node-host.mjs");
      ensureWindowsPrivateDirectory(realDirectory, { ignoreExisting: false });
    } else await mkdir(realDirectory);
    await writeFile(realFile, "untouched", { mode: 0o600 });
    if (!windows) await symlink(realFile, lockLink);
    await symlink(realDirectory, directoryLink, windows ? "junction" : "dir");
    if (!windows) expectRefusal(lockLink);
    expectRefusal(join(directoryLink, "ancestor.lock"));
    equal(await readFile(realFile, "utf8"), "untouched");
  });
});

test("hard-linked, wrong-mode, and non-regular lock files are refused", { skip: windows }, async () => {
  await withDirectory(async (directory) => {
    const realFile = join(directory, "target");
    const hardLink = join(directory, "hard-link");
    const wrongMode = join(directory, "wrong-mode");
    const fifo = join(directory, "fifo");
    await writeFile(realFile, "untouched", { mode: 0o600 });
    await link(realFile, hardLink);
    await writeFile(wrongMode, "untouched", { mode: 0o600 });
    await chmod(wrongMode, 0o644);
    const makeFifo = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout });
    ifError(makeFifo.error);
    equal(makeFifo.status, 0, makeFifo.stderr);
    for (const path of [hardLink, wrongMode, fifo, directory]) expectRefusal(path);
    equal(await readFile(realFile, "utf8"), "untouched");
    equal(await readFile(wrongMode, "utf8"), "untouched");
  });
});

test("Windows refuses hard-linked locks and an inherited directory ACL", { skip: !windows }, async () => {
  await withDirectory(async (directory) => {
    const target = join(directory, "target");
    const hardLink = join(directory, "hard-link");
    await writeFile(target, "untouched");
    await link(target, hardLink);
    expectRefusal(hardLink);
    equal(await readFile(target, "utf8"), "untouched");
    const inherited = join(directory, "inherited");
    await mkdir(inherited);
    expectRefusal(join(inherited, "session.lock"));
  });
});

test("a session owner excludes a concurrent owner", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "session.lock");
    await withOwner(path, async () => {
      const contender = runHelper(path);
      equal(contender.status, 1);
      equal(contender.stdout, "");
    });
  });
});

test("a forcibly terminated owner's lock is released by the operating system", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "session.lock");
    await withOwner(path, async (owner) => {
      owner.child.kill("SIGKILL");
      const exit = await waitForExit(owner);
      if (!windows) equal(exit.signal, "SIGKILL");
      const successor = runHelper(path);
      equal(successor.status, 0);
      equal(successor.stdout, "LOCKED\n");
    });
  });
});

test("closing the owner's input releases the lock", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "session.lock");
    await withOwner(path, async (owner) => {
      owner.child.stdin.end();
      equal((await waitForExit(owner)).code, 0);
      const successor = runHelper(path);
      equal(successor.status, 0);
      equal(successor.stdout, "LOCKED\n");
    });
  });
});
