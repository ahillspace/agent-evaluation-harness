import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EventList } from "./observation-events.js";

it("keeps long recorded messages available through progressive disclosure", () => {
  const message = "Recorded provider output. ".repeat(40);
  const html = renderToStaticMarkup(
    <EventList
      events={[
        {
          sequence: 1,
          createdAt: "2026-10-04T12:00:00Z",
          type: "message",
          message,
        },
      ]}
      empty="No events"
    />,
  );
  expect(html).toContain("Read full message");
  expect(html).toContain(message);
  expect(html).toContain('dateTime="2026-10-04T12:00:00Z"');
  expect(html).not.toContain('open=""');
});

it("shows short event messages without a redundant disclosure", () => {
  const html = renderToStaticMarkup(
    <EventList
      events={[
        {
          sequence: 1,
          createdAt: "2026-10-04T12:00:00Z",
          type: "message",
          message: "Answer submitted",
        },
      ]}
      empty="No events"
    />,
  );
  expect(html).toContain("Answer submitted");
  expect(html).not.toContain("Read full message");
});
