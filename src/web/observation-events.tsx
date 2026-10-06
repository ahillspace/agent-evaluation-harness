import type { ObservationEvent } from "../contracts.js";
import { Icon, JsonView } from "./ui.js";

export function EventList({
  events,
  empty,
}: {
  events: ObservationEvent[];
  empty: string;
}) {
  return events.length ? (
    <ol className="event-list">
      {events.map((event) => (
        <li key={event.sequence} className={`event event-${event.type}`}>
          <div className="event-marker">
            <Icon
              name={
                event.type.includes("tool")
                  ? "tool"
                  : event.type.includes("score") ||
                      event.type.includes("evaluat")
                    ? "shield"
                    : "agent"
              }
              size={15}
            />
          </div>
          <div className="event-content">
            <div className="event-header">
              <span>{event.type.replaceAll(/[._]/g, " ")}</span>
              <time dateTime={event.createdAt}>
                {new Date(event.createdAt).toLocaleTimeString()}
              </time>
            </div>
            {event.message.length > 480 ? (
              <div>
                <div className="event-message">
                  {event.message.slice(0, 240)}...
                </div>
                <details className="event-disclosure">
                  <summary>Read full message</summary>
                  <div className="event-message">{event.message}</div>
                </details>
              </div>
            ) : (
              <div className="event-message">{event.message}</div>
            )}
            {event.data !== undefined && (
              <details>
                <summary>Event details</summary>
                <JsonView value={event.data} />
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  ) : (
    <p className="waiting-text">{empty}</p>
  );
}
