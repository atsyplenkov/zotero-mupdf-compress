/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { checkNoSymlinks, component, ensurePrivateDirectory, fail, fileHash, join, readResourceBytes } from "./files";

export const CLEAN = [
  "clean", "-ggg", "-z", "-Z", "-f", "-i", "-m", "--structure=keep",
  "--color-image-subsample-dpi=150", "--color-image-recompress-method=jpeg:85",
  "--gray-image-subsample-dpi=150", "--gray-image-recompress-method=jpeg:85",
  "--recompress-images-when=smaller",
];

function bytesHash(bytes: Uint8Array): string {
  const hash = component("@mozilla.org/security/hash;1").createInstance(Components.interfaces.nsICryptoHash);
  hash.init(hash.SHA256);
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), (byte: string) => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

export async function extractNative(root: string): Promise<Record<string, string>> {
  const native = JSON.parse(new TextDecoder().decode(await readResourceBytes(root + "native/components.json")));
  if (!native || native.schemaVersion !== 1) fail("native-digest-manifest");
  let os: string | undefined;
  let abi: string | undefined;
  try {
    os = Services.appinfo?.OS;
    abi = Services.appinfo?.XPCOMABI;
  } catch {
    fail("native-unsupported");
  }
  if (!((os === "Linux" && abi === "x86_64-gcc3") ||
        (os === "WINNT" && abi === "x86_64-msvc"))) fail("native-unsupported");
  const suffix = os === "WINNT" ? ".exe" : "";
  if (!native.platforms || typeof native.platforms !== "object" || Array.isArray(native.platforms)) {
    fail("native-digest-manifest");
  }
  const matches = Object.entries(native.platforms as Record<string, {
    os?: string; abi?: string; artifact: string; files: Array<{ name: string; path: string; sha256: string; executable: boolean }>;
  }>).filter(([, candidate]) => candidate?.os === os && candidate?.abi === abi);
  if (matches.length !== 1) fail("native-unsupported");
  const [platformId, platform] = matches[0];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(platformId)) fail("native-digest-manifest");
  if (!Array.isArray(platform.files)) fail("native-digest-manifest");
  const names = new Set<string>();
  for (const file of platform.files) {
    if (!file || typeof file.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file.name) ||
        file.path !== `${platformId}/${file.name}` || typeof file.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.executable !== "boolean" ||
        names.has(os === "WINNT" ? file.name.toLowerCase() : file.name) ||
        (os === "WINNT" && (file.name.endsWith(".") ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(file.name)))) {
      fail("native-digest-manifest");
    }
    names.add(os === "WINNT" ? file.name.toLowerCase() : file.name);
  }
  if (!["mutool", "session-lock"].every((name) =>
    platform.files.some((file) => file.name === name + suffix && file.executable === true),
  )) fail("native-digest-manifest");
  const identity = bytesHash(new TextEncoder().encode(JSON.stringify(platform.files)));
  if (identity !== platform.artifact) fail("native-digest-manifest");
  const profile = Zotero.getProfileDirectory().path;
  const cache = join(profile, "mupdf-compress", platformId, platform.artifact);
  checkNoSymlinks(cache, true);
  await ensurePrivateDirectory(cache, { privateRoot: join(profile, "mupdf-compress") });
  checkNoSymlinks(cache);
  const paths: Record<string, string> = {};
  for (const file of platform.files) {
    const bytes = await readResourceBytes(root + "native/" + file.path);
    if (bytesHash(bytes) !== file.sha256) fail("native-digest-mismatch");
    const path = join(cache, file.name);
    if (!(await IOUtils.exists(path)) || fileHash(path) !== file.sha256) {
      checkNoSymlinks(path, true);
      await IOUtils.write(path, bytes, { mode: "overwrite" });
    }
    if (os !== "WINNT") await IOUtils.setPermissions(path, file.executable ? 0o700 : 0o600);
    if (fileHash(path) !== file.sha256) fail("native-digest-mismatch");
    paths[file.name] = path;
  }
  paths.mutool = paths["mutool" + suffix];
  paths["session-lock"] = paths["session-lock" + suffix];
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
  const result = await run(subprocess, mutoolPath, args, capture, false);
  if (result.exitCode !== 0) fail("engine-exit");
  return result.stdout;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(
  subprocess: any,
  mutoolPath: string,
  args: string[],
  captureStdout: boolean,
  captureStderr: boolean,
): Promise<RunResult> {
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
      // A short-lived child can exit before stdin is closed. Only EOF is benign.
      if ((error as { errorCode?: number }).errorCode !== subprocess.ERROR_END_OF_FILE) throw error;
    }
    const [stdout, stderr, result] = await Promise.all([
      drain(proc.stdout, captureStdout),
      drain(proc.stderr, captureStderr),
      proc.wait(),
    ]);
    return { stdout, stderr, exitCode: result.exitCode };
  } catch (error) {
    if (proc) {
      try {
        proc.kill();
      } catch {}
    }
    fail((error as { safeCode?: string }).safeCode || "engine-unavailable");
  }
}

export async function documentInfo(
  subprocess: any,
  mutoolPath: string,
  path: string,
  failure = "unreadable",
): Promise<number> {
  const result = await run(subprocess, mutoolPath, ["info", "-M", path], true, true);
  if (/cannot authenticate password/i.test(result.stderr)) fail("encrypted");
  if (result.exitCode !== 0) fail(failure);
  if (/Encryption object/i.test(result.stdout)) fail("encrypted");
  const match = result.stdout.match(/^Pages:\s*(\d+)\s*$/m);
  if (!match || Number(match[1]) < 1) fail("validation");
  return Number(match[1]);
}

async function render(subprocess: any, mutoolPath: string, path: string): Promise<void> {
  try {
    const discard = Services.appinfo.OS === "WINNT" ? "NUL" : "/dev/null";
    await nativeRun(subprocess, mutoolPath, ["draw", "-r", "72", "-F", "ppm", "-o", discard, path]);
  } catch (error) {
    if ((error as { safeCode?: string }).safeCode === "engine-exit") fail("validation");
    throw error;
  }
}

export async function validate(
  subprocess: any,
  mutoolPath: string,
  input: string,
  output: string,
): Promise<void> {
  if (!(await IOUtils.exists(output)) || !(await IOUtils.stat(output)).size) fail("validation");
  if ((await documentInfo(subprocess, mutoolPath, input, "validation")) !== (await documentInfo(subprocess, mutoolPath, output, "validation"))) {
    fail("validation");
  }
  await render(subprocess, mutoolPath, input);
  await render(subprocess, mutoolPath, output);
}
