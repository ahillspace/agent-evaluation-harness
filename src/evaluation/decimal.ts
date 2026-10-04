import type { Json } from "../contracts.js";

import { parseDecimal, type Decimal } from "../contracts/numeric.js";
export {
  parseDecimal,
  isIntegerDecimal,
  type Decimal,
} from "../contracts/numeric.js";

const abs = (value: bigint) => (value < 0n ? -value : value);
function align(left: Decimal, right: Decimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * 10n ** BigInt(scale - left.scale),
    right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

export function decimalsMatch(
  expected: Json,
  actual: Json,
  absoluteTolerance: number,
  relativeTolerance: number,
): boolean {
  const left = parseDecimal(expected),
    right = parseDecimal(actual);
  const absolute = parseDecimal(absoluteTolerance),
    relative = parseDecimal(relativeTolerance);
  if (!left || !right || !absolute || !relative) return false;
  const [a, b, scale] = align(left, right);
  const difference = { coefficient: abs(a - b), scale };
  const relativeBound = {
    coefficient: abs(left.coefficient) * relative.coefficient,
    scale: left.scale + relative.scale,
  };
  return [absolute, relativeBound].some((bound) => {
    const [distance, limit] = align(difference, bound);
    return distance <= limit;
  });
}

export function compareDecimals(left: Json, right: Json): number {
  const a = parseDecimal(left),
    b = parseDecimal(right);
  if (!a || !b) throw new Error("Ranking requires valid decimal values.");
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Round exact decimals at half boundaries away from zero. */
export function roundedDecimalsMatch(
  left: Json,
  right: Json,
  places: number,
): boolean {
  const round = (value: Json): bigint | undefined => {
    const decimal = parseDecimal(value);
    if (!decimal) return undefined;
    if (decimal.scale <= places)
      return decimal.coefficient * 10n ** BigInt(places - decimal.scale);
    const divisor = 10n ** BigInt(decimal.scale - places);
    const magnitude = abs(decimal.coefficient);
    const rounded =
      magnitude / divisor + ((magnitude % divisor) * 2n >= divisor ? 1n : 0n);
    return decimal.coefficient < 0n ? -rounded : rounded;
  };
  const a = round(left),
    b = round(right);
  return a !== undefined && b !== undefined && a === b;
}
