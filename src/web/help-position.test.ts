import { expect, it } from "vitest";
import { helpPosition } from "./help-position.js";

it("keeps help inside the viewport near either edge", () => {
  expect(
    helpPosition(
      { left: 2, top: 20, bottom: 36 },
      { width: 300, height: 100 },
      { width: 400, height: 600 },
    ),
  ).toEqual({ left: 12, top: 44 });
  expect(
    helpPosition(
      { left: 390, top: 560, bottom: 580 },
      { width: 300, height: 100 },
      { width: 400, height: 600 },
    ),
  ).toEqual({ left: 88, top: 452 });
});
