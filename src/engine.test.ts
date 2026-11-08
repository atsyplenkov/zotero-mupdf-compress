/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal, match, rejects } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Zotero's bundler resolves extensionless imports; Node's native TypeScript runner does not.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./files" && context.parentURL === new URL("./engine.ts", import.meta.url).href) {
      return nextResolve("./files.ts", context);
    }
    return nextResolve(specifier, context);
  },
});
let engine: typeof import("./engine.ts");
try {
  engine = await import("./engine.ts");
} finally {
  hooks.deregister();
}
const { CLEAN, documentInfo, validate } = engine;

const nativeDirectory = resolve(process.env.MUPDF_NATIVE_DIR || fileURLToPath(new URL("../addon/native/linux-x86_64", import.meta.url)));
const timeout = 60_000;
const mutool = join(nativeDirectory, "mutool");
const pdf = fileURLToPath(new URL("./test-fixtures/unicode-metadata.pdf", import.meta.url));
const invalidSecondPage = fileURLToPath(new URL("./test-fixtures/invalid-second-page.pdf", import.meta.url));

function pipe(text: string) {
  return {
    async readString() {
      const chunk = text;
      text = "";
      return chunk;
    },
  };
}

// Run the bundled binary while adapting Node's process API to Zotero's Subprocess API.
const subprocess = {
  async call({ command, arguments: args, environment }: {
    command: string;
    arguments: string[];
    environment: NodeJS.ProcessEnv;
  }) {
    const result = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, ...environment }, timeout });
    if (result.error) throw result.error;
    return {
      stdin: { async close() {} },
      stdout: pipe(result.stdout),
      stderr: pipe(result.stderr),
      async wait() { return { exitCode: result.status }; },
    };
  },
};

function runMutool(args: string[]) {
  const result = spawnSync(mutool, args, { encoding: "utf8", timeout });
  if (result.error) throw result.error;
  equal(result.status, 0, result.stderr);
}

async function withTempDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "mupdf-engine-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withNodeIOUtils(run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "IOUtils");
  Object.defineProperty(globalThis, "IOUtils", {
    configurable: true,
    value: {
      async exists(path: string) {
        try {
          await access(path);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      },
      stat,
    },
  });
  try {
    await run();
  } finally {
    if (original) Object.defineProperty(globalThis, "IOUtils", original);
    else Reflect.deleteProperty(globalThis, "IOUtils");
  }
}

test("a readable PDF with Unicode metadata is accepted for compression", async () => {
  equal(await documentInfo(subprocess, mutool, pdf), 1);
});

test("password-protected and empty-user-password PDFs are rejected as encrypted", async () => {
  await withTempDirectory(async (directory) => {
    for (const [label, password] of [["password", "secret"], ["empty", ""]]) {
      const encrypted = join(directory, label + ".pdf");
      runMutool(["clean", "-E", "aes-256", "-O", "owner", "-U", password, pdf, encrypted]);
      const probe = spawnSync(mutool, ["info", "-M", encrypted], { encoding: "utf8", timeout });
      if (probe.error) throw probe.error;
      if (password) {
        equal(probe.status, 1);
        match(probe.stderr, /cannot authenticate password/i);
      } else {
        equal(probe.status, 0);
        match(probe.stdout, /Encryption object/i);
      }
      await rejects(documentInfo(subprocess, mutool, encrypted), { safeCode: "encrypted" });
    }
  });
});

test("validation accepts a compressed output after rendering the input and output", async () => {
  await withTempDirectory(async (directory) => {
    const output = join(directory, "compressed.pdf");
    runMutool([...CLEAN, pdf, output]);
    await withNodeIOUtils(async () => {
      await validate(subprocess, mutool, pdf, output);
    });
  });
});

test("compression and validation work with spaces and Unicode in input and output paths", async () => {
  await withTempDirectory(async (directory) => {
    const namedDirectory = join(directory, "papers café 文献");
    await mkdir(namedDirectory);
    const input = join(namedDirectory, "résumé 入力.pdf");
    const output = join(namedDirectory, "résumé 出力.pdf");
    await copyFile(pdf, input);
    runMutool([...CLEAN, input, output]);
    await withNodeIOUtils(async () => {
      await validate(subprocess, mutool, input, output);
    });
    equal(await documentInfo(subprocess, mutool, output), 1);
  });
});

test("validation rejects a rendering failure on a later page of either PDF", async () => {
  await withTempDirectory(async (directory) => {
    const twoPages = join(directory, "two-pages.pdf");
    runMutool(["merge", "-o", twoPages, pdf, "1", pdf, "1"]);
    // This fixture has two pages: page 1 renders, while page 2 has an invalid content stream.
    equal(await documentInfo(subprocess, mutool, invalidSecondPage), 2);
    equal(await documentInfo(subprocess, mutool, twoPages), 2);
    runMutool(["draw", "-r", "72", "-F", "ppm", "-o", "/dev/null", invalidSecondPage, "1"]);
    await withNodeIOUtils(async () => {
      await rejects(validate(subprocess, mutool, invalidSecondPage, twoPages), { safeCode: "validation" });
      await rejects(validate(subprocess, mutool, twoPages, invalidSecondPage), { safeCode: "validation" });
    });
  });
});
