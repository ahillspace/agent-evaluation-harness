import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { evaluatorSettingsSchema, type WorkspaceView } from "../contracts.js";
import { Banks } from "./banks.js";
import { Runs } from "./runs.js";
import { BankEditor } from "./bank-editor.js";

const { resource } = vi.hoisted(() => ({ resource: vi.fn() }));
vi.mock("./api.js", () => ({ useResource: resource, command: vi.fn() }));

describe("compact evaluation libraries", () => {
  it("focuses question authoring and keeps secondary metadata collapsed", () => {
    const html = renderToStaticMarkup(
      <BankEditor
        question={{ id: "q1", text: "Count?", expected: 1, tags: [] }}
        settings={evaluatorSettingsSchema.parse({})}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(html).toContain(
      '<details class="disclosure"><summary>Question ID and tags</summary>',
    );
    for (const action of [
      "Public context",
      "Private reference answer",
      "How this question is graded",
      "Save draft",
      "Try an answer",
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
    resource.mockImplementation((operation: string, input: unknown) => {
      expect(operation).toBe("runs.list");
      expect(input).toMatchObject({ limit: 100, offset: 0 });
      return {
        data: { runs: workspace.runs, total: 1, nextOffset: null },
        error: null,
        refresh: vi.fn(),
      };
    });
    const html = renderToStaticMarkup(
      <Runs workspace={workspace} refresh={() => {}} />,
    );
    expect(html).toContain('href="#/runs/new?source=r1"');
    expect(html).toContain('href="#/runs/new"');
    expect(html).toContain("New run");
    expect(html).toContain('href="#/runs/r1"');
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
    resource.mockImplementation((operation: string) => ({
      data:
        operation === "banks.findings"
          ? []
          : {
              bank,
              evaluatorRevisions: [],
              evaluatorDrafts: [],
              jevProfiles: [],
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
    }));
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
      "Add question",
      "History",
      "Grading",
      "Findings",
      "Publish changes",
    ])
      expect(html).toContain(action);
  });
});
