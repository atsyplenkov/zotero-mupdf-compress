/* SPDX-License-Identifier: AGPL-3.0-or-later */

const UNITS = [
  { unit: "B", below: 1000, divisor: 1, fractionDigits: 0 },
  { unit: "KB", below: 1_000_000, divisor: 1000, fractionDigits: 1 },
  { unit: "MB", below: 1_000_000_000, divisor: 1_000_000, fractionDigits: 1 },
  { unit: "GB", below: Number.POSITIVE_INFINITY, divisor: 1_000_000_000, fractionDigits: 1 },
] as const;

export function formatByteSize(bytes: number): string {
  const chosen = UNITS.find((entry) => bytes < entry.below) ?? UNITS[UNITS.length - 1];
  const scale = 10 ** chosen.fractionDigits;
  const rounded = Math.round((bytes * scale) / chosen.divisor);
  return `${(rounded / scale).toFixed(chosen.fractionDigits)} ${chosen.unit}`;
}

export function formatSavedPercent(before: number, after: number): string {
  if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after)) return "0.0%";
  return `${((100 * (before - after)) / before).toFixed(1)}%`;
}

export function formatChangePercent(before: number, after: number, base = before): string {
  if (!Number.isFinite(before) || !Number.isFinite(after) || !Number.isFinite(base) || base <= 0) return "0.0%";
  const change = (100 * (after - before)) / base;
  const magnitude = Math.abs(change).toFixed(1);
  if (change > 0) return `+${magnitude}%`;
  if (change < 0) return `-${magnitude}%`;
  return "0.0%";
}
