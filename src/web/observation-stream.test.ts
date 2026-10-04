import { describe, expect, it } from "vitest";
import { mergeEvents, mergeRunObservation } from "./observation-stream.js";
import type { RunRecord, RunObservation } from "../contracts.js";
import type { ObservationEvent } from "../contracts.js";

describe("durable observation cursor presentation", () => {
  it("keeps the original manifest while consuming lightweight status updates", () => {
    const run = {
      id: "r1",
      status: "running",
      manifest: { digest: "frozen" },
    } as RunRecord;
    const update = {
      run: { id: "r1", status: "paused" },
      events: [],
      cursor: 8,
    } as unknown as RunObservation;
    const view = mergeRunObservation(run, update);
    expect(view.run.manifest).toBe(run.manifest);
    expect(view.run.status).toBe("paused");
    expect(view.cursor).toBe(8);
  });
  it("reconnects without duplicated or invented events", () => {
    const event = (sequence: number): ObservationEvent => ({
      sequence,
      createdAt: "2026-10-03T00:00:00Z",
      type: "message",
      message: `Saved ${sequence}`,
    });
    expect(mergeEvents([event(1), event(2)], [event(2), event(4)])).toEqual([
      event(1),
      event(2),
      event(4),
    ]);
  });
});
