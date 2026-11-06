/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { equal } from "node:assert/strict";
import { test } from "node:test";
import { formatByteSize, formatSavedPercent } from "./file-size.ts";

const renders: Array<[number, string]> = [
  [0, "0 B"],
  [999, "999 B"],
  [1000, "1.0 KB"],
  [999_999, "1000.0 KB"],
  [1_000_000, "1.0 MB"],
  [3_131_680, "3.1 MB"],
  [10_134_679, "10.1 MB"],
  [13_266_359, "13.3 MB"],
  [999_999_999, "1000.0 MB"],
  [1_000_000_000, "1.0 GB"],
];

test("formatByteSize renders decimal file sizes", () => {
  for (const [bytes, expected] of renders) {
    equal(formatByteSize(bytes), expected, String(bytes));
  }
});

test("compress success sentence uses decimal megabytes", () => {
  const originalSize = 13266359;
  const compressedSize = 3131680;
  const saved = originalSize - compressedSize;
  const message = `Compressed: ${formatByteSize(originalSize)} to ${formatByteSize(compressedSize)}. Saved ${formatByteSize(saved)} (${formatSavedPercent(originalSize, compressedSize)}). Revert is available only during this Zotero session.`;
  equal(
    message,
    "Compressed: 13.3 MB to 3.1 MB. Saved 10.1 MB (76.4%). Revert is available only during this Zotero session.",
  );
});

test("formatSavedPercent uses one decimal place", () => {
  equal(formatSavedPercent(13266359, 3131680), "76.4%");
  equal(formatSavedPercent(13266359, 14300000), "-7.8%");
  equal(formatSavedPercent(13266359, 13266359), "0.0%");
  equal(formatSavedPercent(0, 10), "0.0%");
  equal(formatSavedPercent(Number.NaN, 10), "0.0%");
  equal(formatSavedPercent(10, Number.POSITIVE_INFINITY), "0.0%");
});
