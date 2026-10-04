import { describe, expect, it } from "vitest";
import { rowsMatch } from "./row-matching.js";

describe("duplicate-preserving row assignment", () => {
  it("agrees with exhaustive assignment for every three-by-three compatibility matrix", () => {
    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (let matrix = 0; matrix < 512; matrix++) {
      const compatible = (left: number, right: number) =>
        Boolean(matrix & (1 << (left * 3 + right)));
      const exhaustive = permutations.some((permutation) =>
        permutation.every((right, left) => compatible(left, right)),
      );
      expect(rowsMatch(3, compatible), `Matrix ${matrix}`).toBe(exhaustive);
    }
    expect(rowsMatch(0, () => false)).toBe(true);
  });
});
