/* SPDX-License-Identifier: AGPL-3.0-or-later */

// Node candidate tests use an unpackaged helper for Win32 checks. This module
// replaces only Gecko's OS binding through the test module-resolution hook; it
// does not exercise Gecko js-ctypes or claim Zotero integration coverage.
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

const helper = process.env.MUPDF_WINDOWS_TEST_HOST;

function fail(code) {
  throw Object.assign(new Error(code), { safeCode: code });
}

function run(code, ...args) {
  if (!helper) fail("windows-security-unavailable");
  const result = spawnSync(helper, args, { windowsHide: true, encoding: "utf8", timeout: 10000 });
  if (result.error || result.status !== 0) fail(code);
}

export function checkWindowsPath(path, allowMissing) {
  run("symlink-path", "--test-check-path", path, allowMissing ? "allow-missing" : "existing");
}

export function ensureWindowsPrivateDirectory(
  path,
  options,
){
  const root = options.privateRoot || path;
  const rest = win32.relative(root, path);
  if (rest === ".." || rest.startsWith("..\\") || win32.isAbsolute(rest)) fail("unsafe-path");
  checkWindowsPath(win32.dirname(root), false);
  const paths = [root];
  let current = root;
  for (const part of rest.split("\\").filter(Boolean)) {
    current = win32.join(current, part);
    paths.push(current);
  }
  for (let index = 0; index < paths.length; index++) {
    if (options.verifyExistingOnly) {
      run("windows-private-directory", "--test-verify-private-directory", paths[index]);
    } else {
      const isNew = index === paths.length - 1 && options.ignoreExisting === false;
      run("windows-private-directory", "--test-ensure-private-directory", paths[index], isNew ? "new" : "existing-ok");
    }
  }
}

export async function copyWindowsPrivateFile() {
  // The test adapter never falls back to a public/default ACL for PDF bytes.
  fail("windows-security-unavailable");
}

export function replaceWindowsFile(output, original) {
  run("replacement", "--test-replace-file", original, output);
}
