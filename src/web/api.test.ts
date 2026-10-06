import { beforeEach, expect, it, vi } from "vitest";
const { state } = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock("react", () => ({
  useState: state,
  useEffect: vi.fn(),
  useCallback: (callback: unknown) => callback,
}));
import { useResource } from "./api.js";
beforeEach(() => state.mockReset());
function resourceState(errorKey: string) {
  for (const value of [
    null,
    "",
    new Error("Old connection failed"),
    errorKey,
    0,
  ])
    state.mockReturnValueOnce([value, vi.fn()]);
}
it("hides an old request error immediately when the connection changes", () => {
  resourceState('connections.test:{"connectionId":"old"}');
  expect(
    useResource("connections.test", { connectionId: "new" }).error,
  ).toBeNull();
});
it("retains failures only for the same enabled request", () => {
  resourceState('connections.test:{"connectionId":"old"}');
  expect(
    useResource("connections.test", { connectionId: "old" }).error?.message,
  ).toBe("Old connection failed");
  state.mockReset();
  resourceState('connections.test:{"connectionId":"old"}');
  expect(
    useResource("connections.test", { connectionId: "old" }, undefined, false)
      .error,
  ).toBeNull();
});
