/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { drain } from "./engine";
import { checkNoSymlinks, fail, join, localFile, log, uuid } from "./files";

const PREF = "extensions.mupdf-compress.temporaryFolder";
const OWNER_MARKER = "MuPDF Compress session v1\n";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Lock {
  proc: { stdin: { close(): Promise<void> }; wait(): Promise<unknown>; kill(): void };
  alive: boolean;
}

export async function acquireLock(
  subprocess: any,
  lockHelperPath: string,
  directory: string,
): Promise<Lock | null> {
  checkNoSymlinks(directory);
  const lockPath = join(directory, "session.lock");
  checkNoSymlinks(lockPath, true);
  let proc: any;
  try {
    proc = await subprocess.call({
      command: lockHelperPath,
      arguments: [lockPath],
      stderr: "pipe",
    });
    const diagnostic = drain(proc.stderr);
    if ((await proc.stdout.readString(7)) !== "LOCKED\n") fail("lock-unavailable");
    const held: Lock = { proc, alive: true };
    proc.wait().then(() => {
      held.alive = false;
    });
    void diagnostic;
    return held;
  } catch {
    if (proc) {
      try {
        proc.kill();
      } catch {
        // The helper is already gone.
      }
    }
    return null;
  }
}

export async function releaseLock(lock: Lock | null): Promise<void> {
  if (!lock) return;
  try {
    await lock.proc.stdin.close();
    await lock.proc.wait();
  } catch {
    try {
      lock.proc.kill();
    } catch {
      // The helper is already gone.
    }
  }
  lock.alive = false;
}

async function recognized(directory: string): Promise<boolean> {
  try {
    checkNoSymlinks(directory);
    if (!localFile(directory).isDirectory() || !UUID.test(localFile(directory).leafName)) return false;
    const marker = join(directory, "owner.txt");
    checkNoSymlinks(marker);
    const stat = await IOUtils.stat(marker);
    return stat.type === "regular" && stat.size === OWNER_MARKER.length &&
      (await IOUtils.readUTF8(marker)) === OWNER_MARKER;
  } catch {
    return false;
  }
}

export async function cleanSession(directory: string, lock: Lock): Promise<boolean> {
  if (!lock.alive || !(await recognized(directory))) return false;
  const paths = await IOUtils.getChildren(directory);
  for (const path of paths) {
    checkNoSymlinks(path);
    const name = localFile(path).leafName;
    if (
      !localFile(path).isFile() ||
      !(name === "owner.txt" || name === "session.lock" ||
        (/^[a-f0-9-]{36}\.pdf$/.test(name) && UUID.test(name.slice(0, -4))))
    ) {
      return false;
    }
  }
  for (const path of paths.filter((candidate) => !["owner.txt", "session.lock"].includes(localFile(candidate).leafName))) {
    if (!lock.alive) fail("lock-lost-during-cleanup");
    checkNoSymlinks(path);
    await IOUtils.remove(path);
  }
  const marker = join(directory, "owner.txt");
  await IOUtils.remove(marker);
  try {
    await IOUtils.remove(join(directory, "session.lock"));
    await IOUtils.remove(directory);
  } catch (error) {
    if (lock.alive && (await IOUtils.exists(directory))) {
      try {
        await IOUtils.writeUTF8(marker, OWNER_MARKER, { mode: "create" });
      } catch {
        // Leave partial cleanup state if the marker cannot be restored.
      }
    }
    throw error;
  }
  return true;
}

function temporaryFolder(): string {
  const selected = Zotero.Prefs.get(PREF, true);
  return typeof selected === "string" && selected ? selected : Zotero.getTempDirectory().path;
}

export async function initSession(
  subprocess: any,
  lockHelperPath: string,
): Promise<{ sessionDir: string; lock: Lock }> {
  const selected = temporaryFolder();
  checkNoSymlinks(selected);
  if (!localFile(selected).isDirectory()) fail("temporary-folder");
  const root = join(selected, "mupdf-compress-v1");
  checkNoSymlinks(root, true);
  await IOUtils.makeDirectory(root, { permissions: 0o700 });
  checkNoSymlinks(root);
  for (const directory of await IOUtils.getChildren(root)) {
    if (!(await recognized(directory))) continue;
    const lock = await acquireLock(subprocess, lockHelperPath, directory);
    if (!lock) continue;
    try {
      await cleanSession(directory, lock);
    } catch {
      log("startup", "cleanup-failed");
    } finally {
      await releaseLock(lock);
    }
  }
  const sessionDir = join(root, uuid());
  await IOUtils.makeDirectory(sessionDir, { permissions: 0o700, ignoreExisting: false });
  const lock = await acquireLock(subprocess, lockHelperPath, sessionDir);
  if (!lock) fail("lock-unavailable");
  await IOUtils.writeUTF8(join(sessionDir, "owner.txt"), OWNER_MARKER, { mode: "create" });
  return { sessionDir, lock };
}
