import { useCallback, useEffect, useState } from "react";
import type {
  ObservationEvent,
  CommandInput,
  CommandResultMap,
  RunRecord,
  RunObservation,
  RunView,
} from "../contracts.js";
import { command } from "./api.js";
export function mergeRunObservation(
  original: RunRecord,
  update: RunObservation,
): RunView {
  return { ...update, run: { ...update.run, manifest: original.manifest } };
}

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

export function useObservation<
  K extends "runs.get" | "research.get" | "runs.attempt-events",
>(operation: K, input: CommandInput<K>, enabled = true, polling = true) {
  const key = JSON.stringify(input);
  const [data, setData] = useState<CommandResultMap[K] | null>(null),
    [error, setError] = useState<Error | null>(null),
    [version, setVersion] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let cursor = 0;
    let events: ObservationEvent[] = [];
    let originalRun: RunRecord | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      let delay = 1500;
      let hasMore = false;
      try {
        const request = { ...JSON.parse(key), cursor };
        let next: CommandResultMap[K];
        if (operation === "runs.get" && originalRun)
          next = mergeRunObservation(
            originalRun,
            await command("runs.observe", request, controller.signal),
          ) as CommandResultMap[K];
        else {
          next = await command(operation, request, controller.signal);
          if (operation === "runs.get") originalRun = (next as RunView).run;
        }
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
