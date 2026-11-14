// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useObservation } from "./observation-stream.js";
import { EventList } from "./observation-events.js";

it.each(["research.get"] as const)(
  "retains complete %s event continuation independently of snapshot refresh",
  async (operation) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const request = vi.fn(async (_url: string, options: RequestInit) => {
      const { cursor } = JSON.parse(options.body as string);
      const events = Array.from(
        { length: cursor === 0 ? 200 : 1 },
        (_, index) => ({
          sequence: cursor + index + 1,
          type: "agent.message",
          createdAt: "2026-11-01T00:00:00Z",
          message: `marker-${cursor + index + 1}`,
        }),
      );
      return Response.json({ events, cursor: events.at(-1)!.sequence });
    });
    vi.stubGlobal("fetch", request);
    function Probe() {
      const result = useObservation(
        operation,
        { sessionId: "research" },
        true,
        false,
      );
      return <EventList events={result.data?.events ?? []} empty="Waiting" />;
    }
    try {
      await act(async () => root.render(<Probe />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(request).toHaveBeenCalledTimes(2);
      expect(
        request.mock.calls.map(
          ([, options]) => JSON.parse(options.body as string).cursor,
        ),
      ).toEqual([0, 200]);
      const messages = Array.from(
        container.querySelectorAll(".event-message"),
      ).map((item) => item.textContent);
      expect(messages).toHaveLength(201);
      expect(messages[0]).toBe("marker-1");
      expect(messages.at(-1)).toBe("marker-201");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  },
);
