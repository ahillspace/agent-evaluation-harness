import { useCallback, useEffect, useState } from "react";
import type {
  ObservationEvent,
  CommandInput,
  CommandResultMap,
} from "../contracts.js";
import { command } from "./api.js";
export function mergeEvents(
  previous: ObservationEvent[],
  incoming: ObservationEvent[],
): ObservationEvent[] {
  return [
    ...new Map(
      [...previous, ...incoming].map((event) => [event.sequence, event]),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence);
}

export function useObservation(
  operation: "research.get",
  input: CommandInput<"research.get">,
  enabled = true,
  polling = true,
) {
  const key = JSON.stringify(input);
  const [data, setData] = useState<CommandResultMap["research.get"] | null>(
      null,
    ),
    [error, setError] = useState<Error | null>(null),
    [version, setVersion] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let cursor = 0;
    let events: ObservationEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      let delay = 1500;
      let hasMore = false;
      try {
        const request = { ...JSON.parse(key), cursor };
        const next = await command(operation, request, controller.signal);
        if (controller.signal.aborted) return;
        cursor = next.cursor;
        events = mergeEvents(events, next.events);
        setData({ ...next, events });
        setLoadedKey(`${operation}:${key}`);
        setError(null);
        if (next.events.length >= 200) {
          delay = 0;
          hasMore = true;
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
      if (!controller.signal.aborted && (polling || hasMore))
        timer = setTimeout(() => {
          void load();
        }, delay);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [operation, key, version, enabled, polling]);
  return {
    data: enabled && loadedKey === `${operation}:${key}` ? data : null,
    error,
    refresh,
  };
}
