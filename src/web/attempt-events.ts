import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput, ObservationEvent } from "../contracts.js";
import { command, CommandError } from "./api.js";
import { mergeEvents } from "./observation-stream.js";

interface AttemptEvents {
  key: string;
  cursor: number;
  events: ObservationEvent[];
  loaded: boolean;
  loading: boolean;
  error: Error | null;
}

/** One selected attempt retains its cursor while its evidence tabs change. */
export function useAttemptEvents(
  input: CommandInput<"runs.attempt-events">,
  enabled: boolean,
) {
  const key = JSON.stringify(input);
  const retained = useRef<AttemptEvents | null>(null);
  const [state, setState] = useState<AttemptEvents | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    if (retained.current?.key !== key)
      retained.current = {
        key,
        cursor: 0,
        events: [],
        loaded: false,
        loading: false,
        error: null,
      };
    const current = retained.current;
    if (!enabled || !JSON.parse(key).attemptId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => setState({ ...current });
    const load = async () => {
      current.loading = !current.loaded;
      publish();
      try {
        const next = await command(
          "runs.attempt-events",
          { ...JSON.parse(key), cursor: current.cursor },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        current.cursor = next.cursor;
        current.events = mergeEvents(current.events, next.events);
        const hasMore = next.events.length >= 200;
        current.loaded ||= !hasMore;
        current.loading = !current.loaded;
        current.error = null;
        publish();
        timer = setTimeout(() => void load(), hasMore ? 0 : 1500);
      } catch (cause) {
        if (controller.signal.aborted) return;
        current.error =
          cause instanceof Error ? cause : new Error(String(cause));
        current.loading = false;
        publish();
        if (!(cause instanceof CommandError) || cause.status >= 500)
          timer = setTimeout(() => void load(), 1500);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, enabled, version]);

  const current = state?.key === key ? state : null;
  return {
    events: current?.events ?? [],
    loading: enabled && (!current || current.loading),
    error: enabled ? current?.error : null,
    refresh,
  };
}
