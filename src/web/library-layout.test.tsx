import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceView } from "../contracts.js";
import { Banks } from "./banks.js";
import { Results } from "./results.js";
import { BankEditor } from "./bank-editor.js";

const { resource } = vi.hoisted(() => ({ resource: vi.fn() }));
vi.mock("./api.js", () => ({ useResource: resource, command: vi.fn() }));

describe("compact evaluation libraries", () => {
  it("keeps authoring and import available with secondary metadata collapsed", () => {
    const html = renderToStaticMarkup(
      <BankEditor source="new" onClose={() => {}} onSaved={() => {}} />,
    );
    expect(html).toContain(
      '<details class="disclosure"><summary>Question ID and tags</summary>',
    );
    for (const action of [
      "Import JSON or CSV",
      "Expected answer",
      "Publish bank",
      "Add question",
    ])
      expect(html).toContain(action);
  });
  it("keeps reuse visible and groups secondary run actions in a collapsed disclosure", () => {
    resource.mockReturnValue({ data: null, error: null, refresh: vi.fn() });
    const workspace = {
      runs: [
        {
          id: "r1",
          name: "Baseline",
          bankName: "Sales",
          model: "luna",
          harness: "codex",
          status: "completed",
          completed: 20,
          total: 20,
          failed: 0,
          correct: 18,
          scored: 20,
          createdAt: "2026-10-04T00:00:00Z",
        },
      ],
      totalRuns: 1,
      blueprints: [],
    } as unknown as WorkspaceView;
    const html = renderToStaticMarkup(
      <Results workspace={workspace} refresh={() => {}} />,
    );
    expect(html).toContain('href="#/run?source=r1"');
    expect(html).not.toContain('href="#/run"');
    expect(html).toContain('<details class="result-actions-menu">');
    expect(html).toContain('aria-label="More actions for Baseline"');
    for (const action of [
      "Score saved answers",
      "Save blueprint",
      "Export JSON",
      "Compare",
    ])
      expect(html).toContain(action);
  });

  it("retains complete answers behind a collapsed reference disclosure", () => {
    const bank = {
      id: "b1",
      name: "Sales",
      latestRevisionId: "v1",
      questionCount: 1,
    };
    resource.mockReturnValue({
      data: {
        bank,
        revisions: [
          {
            id: "v1",
            bankId: "b1",
            number: 1,
            createdAt: "2026-10-04T00:00:00Z",
            questions: [
              {
                id: "q1",
                text: "Which regions?",
                expected: [{ region: "West" }],
                tags: [],
              },
            ],
          },
        ],
      },
      error: null,
      refresh: vi.fn(),
    });
    const html = renderToStaticMarkup(
      <Banks
        workspace={{ banks: [bank] } as unknown as WorkspaceView}
        refresh={() => {}}
      />,
    );
    expect(html).toContain('<details class="answer-preview">');
    expect(html).toContain('aria-label="Expected answer for q1"');
    expect(html).toContain("West");
    expect(html).toContain('aria-pressed="true"');
    for (const action of [
      "Export bank",
      "Edit questions",
      "History",
      "Jev criteria",
    ])
      expect(html).toContain(action);
  });
});
