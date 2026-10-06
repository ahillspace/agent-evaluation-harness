/** Find a complete assignment, retaining duplicates and overlapping tolerance matches. */
export function rowsMatch(
  count: number,
  compatible: (expected: number, actual: number) => boolean,
): boolean {
  let remainingSearchSteps = 1_000_000;
  const owners = new Int32Array(count).fill(-1);
  const assignments = new Int32Array(count).fill(-1);
  const cache = new Map<number, boolean>();
  for (let start = 0; start < count; start++) {
    const queue = [start];
    const seenExpected = new Set([start]);
    const parent = new Int32Array(count).fill(-1);
    let free = -1;
    for (let cursor = 0; cursor < queue.length && free < 0; cursor++) {
      const expected = queue[cursor]!;
      for (let actual = 0; actual < count; actual++) {
        if (--remainingSearchSteps < 0)
          throw new Error("Row assignment exceeds the bounded search budget.");
        if (parent[actual] !== -1) continue;
        const key = expected * count + actual;
        if (!cache.has(key)) cache.set(key, compatible(expected, actual));
        if (!cache.get(key)) continue;
        parent[actual] = expected;
        const owner = owners[actual]!;
        if (owner < 0) {
          free = actual;
          break;
        }
        if (!seenExpected.has(owner)) {
          seenExpected.add(owner);
          queue.push(owner);
        }
      }
    }
    if (free < 0) return false;
    while (free >= 0) {
      const expected = parent[free]!;
      const previous = assignments[expected]!;
      owners[free] = expected;
      assignments[expected] = free;
      free = previous;
    }
  }
  return true;
}
