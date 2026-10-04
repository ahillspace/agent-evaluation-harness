import type { Json } from "../contracts.js";

/** Public numeric strings use the same bounded scientific exponent as grading. */
export const decimalStringPattern =
  "^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?0*(?:[0-9]{1,3}|1000))?$";

export interface Decimal {
  coefficient: bigint;
  scale: number;
}

/** Preserve decimal strings exactly, including values beyond Number's integer precision. */
export function parseDecimal(value: Json): Decimal | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  const source = String(value).trim();
  if (source.length > 2048) return undefined;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(
    source,
  );
  if (!match) return undefined;
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 1000)
    return undefined;
  const scale = fraction.length - exponent;
  let coefficient = BigInt(
    `${match[1] === "-" ? "-" : ""}${match[2] ?? "0"}${fraction}`,
  );
  if (scale < 0) coefficient *= 10n ** BigInt(-scale);
  return { coefficient, scale: Math.max(0, scale) };
}

export function isIntegerDecimal(value: Json): boolean {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return false;
  const decimal = parseDecimal(value);
  return (
    decimal !== undefined &&
    decimal.coefficient % 10n ** BigInt(decimal.scale) === 0n
  );
}
