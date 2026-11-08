/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal, ifError, match, notEqual, rejects } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Use the real extension modules with adapters for Gecko's host APIs.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (process.platform === "win32" && specifier === "./windows.ts") {
      return nextResolve(new URL("./test-fixtures/windows-node-host.mjs", import.meta.url).href, context);
    }
    if (specifier === "./files" && context.parentURL === new URL("./engine.ts", import.meta.url).href) {
      return nextResolve("./files.ts", context);
    }
    return nextResolve(specifier, context);
  },
});
let extractNative: typeof import("./engine.ts").extractNative;
try {
  ({ extractNative } = await import("./engine.ts"));
} finally {
  hooks.deregister();
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
  exists() { return existsSync(this.path); }
  isSymlink() {
    try { return lstatSync(this.path).isSymbolicLink(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

async function withGecko(run: (root: string, profile: string, fixture: {
  manifest: { schemaVersion: number; source: string; sourceSha256: string; platforms: Record<string, {
    os: string; abi: string; artifact: string; files: Array<{ name: string; path: string; sha256: string; executable: boolean }>;
  }> };
  appinfo: { OS: string; XPCOMABI: string };
  removeAppinfo: () => void;
  resource: string;
  saveManifest: () => Promise<void>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "mupdf-native-test-"));
  const profile = join(directory, "profile");
  const resource = join(directory, "package");
  await mkdir(profile);
  await mkdir(join(resource, "native", "linux-x86_64"), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    source: "https://example.test/mupdf.tar.gz",
    sourceSha256: "b".repeat(64),
    platforms: {
      "linux-x86_64": {
        os: "Linux", abi: "x86_64-gcc3", artifact: "2799d384cf1fba70b2138286721a7a55198dd03004ad7dc64d712a1e6a508b70",
        files: [
          { name: "mutool", path: "linux-x86_64/mutool", sha256: "fa2ed69c710c52b807f0ae2ce398fe011dc9180a6380621ae9fb20580fc85677", executable: true },
          { name: "session-lock", path: "linux-x86_64/session-lock", sha256: "0a94d8257b8fbf868bc9572abfb27e486cf80dfb6d9829585ab9ab9ada92958d", executable: true },
        ],
      },
    },
  };
  await writeFile(join(resource, "native", "components.json"), JSON.stringify(manifest));
  await writeFile(join(resource, "native", "linux-x86_64", "mutool"), "linux mutool\n");
  await writeFile(join(resource, "native", "linux-x86_64", "session-lock"), "linux lock\n");

  const classes = {
    "@mozilla.org/file/local;1": { createInstance: () => new LocalFile() },
    "@mozilla.org/network/file-input-stream;1": { createInstance: () => ({
      path: "", init(file: LocalFile) { this.path = file.path; }, close() {},
    }) },
    "@mozilla.org/security/hash;1": { createInstance: () => ({
      SHA256: 1, bytes: Buffer.alloc(0), init() {},
      update(bytes: Uint8Array) { this.bytes = Buffer.from(bytes); },
      updateFromStream(stream: { path: string }) { this.bytes = readFileSync(stream.path); },
      finish() { return createHash("sha256").update(this.bytes).digest("latin1"); },
    }) },
    "@mozilla.org/binaryinputstream;1": { createInstance: () => ({
      bytes: Buffer.alloc(0), setInputStream(stream: { bytes: Buffer }) { this.bytes = stream.bytes; },
      available() { return this.bytes.length; }, readByteArray() { return this.bytes; }, close() {},
    }) },
  };
  const netUtil = {
    newChannel({ uri }: { uri: string }) { return uri; },
    asyncFetch(uri: string, callback: (stream: { bytes: Buffer } | null, status: number) => void) {
      readFile(fileURLToPath(uri)).then((bytes) => callback({ bytes }, 0), () => callback(null, 1));
    },
  };
  const globals = {
    Services: { appinfo: { OS: "Linux", XPCOMABI: "x86_64-gcc3" } },
    Zotero: { getProfileDirectory: () => ({ path: profile }) },
    Components: {
      classes,
      interfaces: {
        nsIFile: {}, nsIFileInputStream: {}, nsICryptoHash: {}, nsIBinaryInputStream: {},
        nsILoadInfo: { SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL: 0 }, nsIContentPolicy: { TYPE_OTHER: 0 },
      },
      isSuccessCode: (status: number) => status === 0,
    },
    ChromeUtils: { importESModule: () => ({ NetUtil: netUtil }) },
    IOUtils: {
      makeDirectory: (path: string, options: { createAncestors: boolean; permissions: number }) =>
        mkdir(path, { recursive: options.createAncestors, mode: options.permissions }),
      exists: async (path: string) => existsSync(path),
      write: (path: string, bytes: Uint8Array) => writeFile(path, bytes),
      setPermissions: chmod,
    },
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    await run(pathToFileURL(resource + "/").href, profile, {
      manifest, resource, appinfo: globals.Services.appinfo,
      removeAppinfo: () => { Reflect.deleteProperty(globals.Services, "appinfo"); },
      saveManifest: () => writeFile(join(resource, "native", "components.json"), JSON.stringify(manifest)),
    });
  } finally {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("Linux x86-64 extracts the declared engine and session-lock helper", async () => {
  await withGecko(async (root, profile) => {
    const paths = await extractNative(root);
    equal(await readFile(paths.mutool, "utf8"), "linux mutool\n");
    equal(await readFile(paths["session-lock"], "utf8"), "linux lock\n");
    equal(paths.mutool.startsWith(join(profile, "mupdf-compress", "linux-x86_64") + (process.platform === "win32" ? "\\" : "/")), true);
    if (process.platform !== "win32") {
      equal((await stat(paths.mutool)).mode & 0o777, 0o700);
      equal((await stat(paths["session-lock"])).mode & 0o777, 0o700);
    }
  });
});

async function withWindows(run: Parameters<typeof withGecko>[0]) {
  await withGecko(async (root, profile, fixture) => {
    fixture.appinfo.OS = "WINNT";
    fixture.appinfo.XPCOMABI = "x86_64-msvc";
    const files = [
      { name: "mutool.exe", path: "windows-x86_64/mutool.exe", sha256: "fa2ed69c710c52b807f0ae2ce398fe011dc9180a6380621ae9fb20580fc85677", executable: true },
      { name: "session-lock.exe", path: "windows-x86_64/session-lock.exe", sha256: "0a94d8257b8fbf868bc9572abfb27e486cf80dfb6d9829585ab9ab9ada92958d", executable: true },
    ];
    fixture.manifest.platforms["windows-x86_64"] = {
      os: "WINNT", abi: "x86_64-msvc",
      artifact: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files,
    };
    await mkdir(join(fixture.resource, "native", "windows-x86_64"));
    await writeFile(join(fixture.resource, "native", "windows-x86_64", "mutool.exe"), "linux mutool\n");
    await writeFile(join(fixture.resource, "native", "windows-x86_64", "session-lock.exe"), "linux lock\n");
    await fixture.saveManifest();
    await run(root, profile, fixture);
  });
}

test("Windows x64 extracts .exe components with the existing engine and helper keys", async () => {
  await withWindows(async (root, profile, fixture) => {
    const paths = await extractNative(root);
    equal(await readFile(paths.mutool, "utf8"), "linux mutool\n");
    equal(await readFile(paths["session-lock"], "utf8"), "linux lock\n");
    equal(paths.mutool, join(profile, "mupdf-compress", "windows-x86_64", fixture.manifest.platforms["windows-x86_64"].artifact, "mutool.exe"));
    equal(paths["session-lock"].endsWith("session-lock.exe"), true);
  });
});

test("Windows cached executables cannot hide missing or corrupt package components", async () => {
  await withWindows(async (root, _profile, fixture) => {
    const first = await extractNative(root);
    await writeFile(first.mutool, "stale engine");
    await writeFile(first["session-lock"], "stale helper");
    const repaired = await extractNative(root);
    equal(await readFile(repaired.mutool, "utf8"), "linux mutool\n");
    equal(await readFile(repaired["session-lock"], "utf8"), "linux lock\n");
    const helper = join(fixture.resource, "native", "windows-x86_64", "session-lock.exe");
    await writeFile(helper, "corrupt helper");
    await rejects(extractNative(root), { safeCode: "native-digest-mismatch" });
    await rm(helper);
    await rejects(extractNative(root));
  });
});

test("Windows component names cannot alias the same case-insensitive cache file", async () => {
  await withWindows(async (root, profile, fixture) => {
    const platform = fixture.manifest.platforms["windows-x86_64"];
    platform.files.push({ ...platform.files[0], name: "MUTOOL.EXE", path: "windows-x86_64/MUTOOL.EXE" });
    platform.artifact = createHash("sha256").update(JSON.stringify(platform.files)).digest("hex");
    await fixture.saveManifest();
    await rejects(extractNative(root), { safeCode: "native-digest-manifest" });
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("Windows device names and trailing-dot aliases are refused before caching", async () => {
  for (const name of ["NUL", "CON.txt", "COM1.dll", "mutool.exe.", "CONIN$", "CONOUT$", "CLOCK$", "COM¹.dll", "LPT²"]) {
    await withWindows(async (root, profile, fixture) => {
      const platform = fixture.manifest.platforms["windows-x86_64"];
      platform.files.push({ ...platform.files[0], name, path: `windows-x86_64/${name}` });
      platform.artifact = createHash("sha256").update(JSON.stringify(platform.files)).digest("hex");
      await fixture.saveManifest();
      await rejects(extractNative(root), { safeCode: "native-digest-manifest" });
      equal(existsSync(join(profile, "mupdf-compress")), false);
    });
  }
});

test("Windows ARM64 is refused even if a manifest declares matching components", async () => {
  await withWindows(async (root, profile, fixture) => {
    fixture.appinfo.XPCOMABI = "aarch64-msvc";
    fixture.manifest.platforms["windows-x86_64"].abi = "aarch64-msvc";
    await fixture.saveManifest();
    await rejects(extractNative(root), { safeCode: "native-unsupported" });
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("a component set for a different runtime is not selected", async () => {
  await withGecko(async (root, profile, fixture) => {
    fixture.manifest.platforms["linux-x86_64"].abi = "aarch64-gcc3";
    await fixture.saveManifest();
    await rejects(extractNative(root));
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("a manifest without the executable session-lock helper is rejected before caching", async () => {
  await withGecko(async (root, profile, fixture) => {
    fixture.manifest.platforms["linux-x86_64"].files.pop();
    await fixture.saveManifest();
    await rejects(extractNative(root));
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("a changed helper digest with an unchanged artifact identity is rejected before caching", async () => {
  await withGecko(async (root, profile, fixture) => {
    fixture.manifest.platforms["linux-x86_64"].files[1].sha256 = "b".repeat(64);
    await fixture.saveManifest();
    await rejects(extractNative(root));
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("a manifest with a redirected resource path is rejected before caching", async () => {
  await withGecko(async (root, profile, fixture) => {
    const platform = fixture.manifest.platforms["linux-x86_64"];
    platform.files[1].path = "linux-x86_64/../../outside";
    platform.artifact = createHash("sha256").update(JSON.stringify(platform.files)).digest("hex");
    await fixture.saveManifest();
    await rejects(extractNative(root));
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("duplicate component names are rejected before caching", async () => {
  await withGecko(async (root, profile, fixture) => {
    const platform = fixture.manifest.platforms["linux-x86_64"];
    platform.files.push({ ...platform.files[0] });
    platform.artifact = createHash("sha256").update(JSON.stringify(platform.files)).digest("hex");
    await fixture.saveManifest();
    await rejects(extractNative(root));
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("an unknown manifest schema is rejected before caching", async () => {
  await withGecko(async (root, profile, fixture) => {
    fixture.manifest.schemaVersion = 2;
    await fixture.saveManifest();
    await rejects(extractNative(root));
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("unavailable Zotero runtime information fails safely before caching", async () => {
  await withGecko(async (root, profile, fixture) => {
    fixture.removeAppinfo();
    await rejects(extractNative(root), { safeCode: "native-unsupported" });
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("the component set is selected by its declared OS and ABI", async () => {
  await withGecko(async (root, _profile, fixture) => {
    const platform = fixture.manifest.platforms["linux-x86_64"];
    delete fixture.manifest.platforms["linux-x86_64"];
    for (const file of platform.files) file.path = `linux-amd64/${file.name}`;
    platform.artifact = createHash("sha256").update(JSON.stringify(platform.files)).digest("hex");
    fixture.manifest.platforms["linux-amd64"] = platform;
    await rename(join(fixture.resource, "native", "linux-x86_64"), join(fixture.resource, "native", "linux-amd64"));
    await fixture.saveManifest();
    const paths = await extractNative(root);
    equal(await readFile(paths.mutool, "utf8"), "linux mutool\n");
    match(paths.mutool, /[\\/]linux-amd64[\\/]/);
  });
});

test("altered package bytes are rejected without installing an unverified executable", async () => {
  await withGecko(async (root, profile, fixture) => {
    await writeFile(join(fixture.resource, "native", "linux-x86_64", "session-lock"), "altered helper\n");
    await rejects(extractNative(root), { safeCode: "native-digest-mismatch" });
    const artifact = fixture.manifest.platforms["linux-x86_64"].artifact;
    equal(existsSync(join(profile, "mupdf-compress", "linux-x86_64", artifact, "session-lock")), false);
  });
});

test("a cached component does not hide a missing packaged helper", async () => {
  await withGecko(async (root, _profile, fixture) => {
    await extractNative(root);
    await rm(join(fixture.resource, "native", "linux-x86_64", "session-lock"));
    await rejects(extractNative(root));
  });
});

test("each repeated extraction repairs altered executables and required runtime files", async () => {
  await withGecko(async (root, _profile, fixture) => {
    const platform = fixture.manifest.platforms["linux-x86_64"];
    platform.files.push({
      name: "libsupport.so", path: "linux-x86_64/libsupport.so",
      sha256: "81bd06db34338d0503d244772888feac7553c67aa906c8189f1a9d0ee4a8a9d6", executable: false,
    });
    platform.artifact = createHash("sha256").update(JSON.stringify(platform.files)).digest("hex");
    await writeFile(join(fixture.resource, "native", "linux-x86_64", "libsupport.so"), "shared runtime\n");
    await fixture.saveManifest();
    const first = await extractNative(root);
    equal(await readFile(first["libsupport.so"], "utf8"), "shared runtime\n");
    if (process.platform !== "win32") equal((await stat(first["libsupport.so"])).mode & 0o777, 0o600);
    await writeFile(first.mutool, "stale engine\n");
    await writeFile(first["session-lock"], "stale helper\n");
    await writeFile(first["libsupport.so"], "stale runtime\n");
    const second = await extractNative(root);
    equal(second.mutool, first.mutool);
    equal(await readFile(second.mutool, "utf8"), "linux mutool\n");
    equal(await readFile(second["session-lock"], "utf8"), "linux lock\n");
    equal(await readFile(second["libsupport.so"], "utf8"), "shared runtime\n");
    await writeFile(join(fixture.resource, "native", "linux-x86_64", "libsupport.so"), "altered runtime\n");
    await rejects(extractNative(root), { safeCode: "native-digest-mismatch" });
  });
});

test("unsupported and incomplete Zotero runtimes are refused before caching", async () => {
  for (const [os, abi] of [["WINNT", "x86_64-msvc"], ["Linux", "aarch64-gcc3"], ["Linux", ""], ["", "x86_64-gcc3"]]) {
    await withGecko(async (root, profile, fixture) => {
      fixture.appinfo.OS = os;
      fixture.appinfo.XPCOMABI = abi;
      await rejects(extractNative(root), { safeCode: "native-unsupported" });
      equal(existsSync(join(profile, "mupdf-compress")), false);
    });
  }
});

test("an updated helper gets a different cache identity even when the engine is unchanged", async () => {
  await withGecko(async (root, _profile, fixture) => {
    const first = await extractNative(root);
    const platform = fixture.manifest.platforms["linux-x86_64"];
    platform.files[1].sha256 = "e9f76d634b3ce95e055113cf4ff580ff680a2c1958b2bfeb1c6652468fb992ce";
    platform.artifact = createHash("sha256").update(JSON.stringify(platform.files)).digest("hex");
    await writeFile(join(fixture.resource, "native", "linux-x86_64", "session-lock"), "replacement helper\n");
    await fixture.saveManifest();
    const second = await extractNative(root);
    notEqual(first.mutool, second.mutool);
    equal(await readFile(second["session-lock"], "utf8"), "replacement helper\n");
    equal(await readFile(first["session-lock"], "utf8"), "linux lock\n");
  });
});

test("a symlinked cache directory is rejected without touching its target", async () => {
  await withGecko(async (root, profile, fixture) => {
    const target = join(profile, "outside");
    await mkdir(target);
    const cacheParent = join(profile, "mupdf-compress", "linux-x86_64");
    await mkdir(cacheParent, { recursive: true });
    await symlink(target, join(cacheParent, fixture.manifest.platforms["linux-x86_64"].artifact), process.platform === "win32" ? "junction" : "dir");
    await rejects(extractNative(root), { safeCode: "symlink-path" });
    equal(existsSync(join(target, "mutool")), false);
    equal(existsSync(join(target, "session-lock")), false);
  });
});

test("ambiguous declarations for one runtime are refused before caching", async () => {
  await withGecko(async (root, profile, fixture) => {
    fixture.manifest.platforms["linux-other"] = { ...fixture.manifest.platforms["linux-x86_64"] };
    await fixture.saveManifest();
    await rejects(extractNative(root), { safeCode: "native-unsupported" });
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("malformed component entries fail with a manifest error before caching", async () => {
  await withGecko(async (root, profile, fixture) => {
    const platform = fixture.manifest.platforms["linux-x86_64"];
    platform.files.unshift(null as unknown as (typeof platform.files)[number]);
    await fixture.saveManifest();
    await rejects(extractNative(root), { safeCode: "native-digest-manifest" });
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});

test("the candidate's native engine executes after extraction through the runtime API", {
  skip: !process.env.MUPDF_NATIVE_DIR || !process.env.MUPDF_NATIVE_MANIFEST,
}, async () => {
  await withGecko(async (root, _profile, fixture) => {
    const directory = process.env.MUPDF_NATIVE_DIR!;
    const native = JSON.parse(await readFile(process.env.MUPDF_NATIVE_MANIFEST!, "utf8"));
    const windows = process.platform === "win32";
    const platformId = windows ? "windows-x86_64" : "linux-x86_64";
    fixture.appinfo.OS = windows ? "WINNT" : "Linux";
    fixture.appinfo.XPCOMABI = windows ? "x86_64-msvc" : "x86_64-gcc3";
    await mkdir(join(fixture.resource, "native", platformId), { recursive: true });
    for (const file of native.platforms[platformId].files) {
      await copyFile(join(directory, file.name), join(fixture.resource, "native", platformId, file.name));
    }
    await writeFile(join(fixture.resource, "native", "components.json"), JSON.stringify(native));
    const paths = await extractNative(root);
    const result = spawnSync(paths.mutool, ["-v"], { encoding: "utf8", timeout: 10_000 });
    ifError(result.error);
    equal(result.status, 0, result.stderr);
    match(result.stdout + result.stderr, /mutool version 1\.28\.5/);
  });
});

test("a required engine declared non-executable is rejected before caching", async () => {
  await withGecko(async (root, profile, fixture) => {
    const platform = fixture.manifest.platforms["linux-x86_64"];
    platform.files[0].executable = false;
    platform.artifact = createHash("sha256").update(JSON.stringify(platform.files)).digest("hex");
    await fixture.saveManifest();
    await rejects(extractNative(root), { safeCode: "native-digest-manifest" });
    equal(existsSync(join(profile, "mupdf-compress")), false);
  });
});
