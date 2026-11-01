/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { checkNoSymlinks, fail, fileHash, join, readResourceBytes } from "./files";

export const CLEAN = [
  "clean", "-ggg", "-z", "-Z", "-f", "-i", "-m", "--structure=keep",
  "--color-image-subsample-dpi=150", "--color-image-recompress-method=jpeg:85",
  "--gray-image-subsample-dpi=150", "--gray-image-recompress-method=jpeg:85",
  "--recompress-images-when=smaller",
];

export async function extractNative(root: string): Promise<Record<string, string>> {
  const native = JSON.parse(new TextDecoder().decode(await readResourceBytes(root + "native/digests.json")));
  const profile = Zotero.getProfileDirectory().path;
  const cache = join(profile, "mupdf-compress", native.mutool.slice(0, 16));
  checkNoSymlinks(cache, true);
  await IOUtils.makeDirectory(cache, { createAncestors: true, permissions: 0o700 });
  checkNoSymlinks(cache);
  const paths: Record<string, string> = {};
  for (const name of ["mutool", "session-lock"]) {
    if (!/^[a-f0-9]{64}$/.test(native[name])) fail("native-digest-manifest");
    const path = join(cache, name);
    if (!(await IOUtils.exists(path)) || fileHash(path) !== native[name]) {
      checkNoSymlinks(path, true);
      await IOUtils.write(path, await readResourceBytes(root + "native/" + name), { mode: "overwrite" });
    }
    await IOUtils.setPermissions(path, 0o700);
    if (fileHash(path) !== native[name]) fail("native-digest-mismatch");
    paths[name] = path;
  }
  return paths;
}

export async function drain(pipe: { readString(): Promise<string | undefined> }, keep = false): Promise<string> {
  let text = "";
  for (;;) {
    const chunk = await pipe.readString();
    if (!chunk) break;
    if (keep) {
      text += chunk;
      if (text.length > 4 * 1024 * 1024) fail("engine-output-limit");
    }
  }
  return text;
}

export async function nativeRun(
  subprocess: any,
  mutoolPath: string,
  args: string[],
  capture = false,
): Promise<string> {
  let proc: any;
  try {
    proc = await subprocess.call({
      command: mutoolPath,
      arguments: args,
      stderr: "pipe",
      environmentAppend: true,
      environment: { LC_ALL: "C", LANG: "C" },
    });
    try {
      await proc.stdin.close();
    } catch (error) {
      if ((error as { errorCode?: number }).errorCode !== subprocess.ERROR_END_OF_FILE) throw error;
    }
    const [stdout, , result] = await Promise.all([
      drain(proc.stdout, capture),
      drain(proc.stderr),
      proc.wait(),
    ]);
    if (result.exitCode !== 0) fail("engine-exit");
    return stdout;
  } catch (error) {
    if (proc) {
      try {
        proc.kill();
      } catch {
        // The child is already gone.
      }
    }
    fail((error as { safeCode?: string }).safeCode || "engine-unavailable");
  }
}

export async function documentInfo(subprocess: any, mutoolPath: string, path: string): Promise<number> {
  const text = await nativeRun(subprocess, mutoolPath, ["info", path], true);
  if (/Encryption object/i.test(text)) fail("encrypted");
  const match = text.match(/^Pages:\s*(\d+)\s*$/m);
  if (!match || Number(match[1]) < 1) fail("validation");
  return Number(match[1]);
}

export async function validate(
  subprocess: any,
  mutoolPath: string,
  input: string,
  output: string,
): Promise<void> {
  if (!(await IOUtils.exists(output)) || !(await IOUtils.stat(output)).size) fail("validation");
  if ((await documentInfo(subprocess, mutoolPath, input)) !== (await documentInfo(subprocess, mutoolPath, output))) {
    fail("validation");
  }
  await nativeRun(subprocess, mutoolPath, ["draw", "-r", "72", "-F", "ppm", "-o", "/dev/null", input]);
  await nativeRun(subprocess, mutoolPath, ["draw", "-r", "72", "-F", "ppm", "-o", "/dev/null", output]);
}
