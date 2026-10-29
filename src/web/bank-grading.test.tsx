// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { evaluatorSettingsSchema, type WorkspaceView } from "../contracts.js";
import { BankGrading } from "./bank-grading.js";

let root: Root;
let container: HTMLDivElement;
const request = vi.fn();
const questions = [{ id: "q1", text: "Amount", expected: 49.073755, tags: [] }];
function Fixture({ bankId = "bank" }: { bankId?: string }) {
  const [settings, setSettings] = useState(evaluatorSettingsSchema.parse({}));
  const workspace = {
    banks: [{ id: "bank", activeEvaluatorRevisionId: "e1" }],
    runs: [
      { id: "r1", bankId: "bank", name: "Saved run", createdAt: "2026-10-10" },
    ],
    revisions: [],
    evaluatorRevisions: [],
    evaluatorDrafts: [],
  } as unknown as WorkspaceView & {
    revisions: [];
    evaluatorRevisions: [];
    evaluatorDrafts: [];
  };
  return (
    <BankGrading
      workspace={workspace}
      bankId={bankId}
      questions={questions}
      evaluatorName="Draft rules"
      onEvaluatorName={() => {}}
      settings={settings}
      onSettings={setSettings}
      refresh={() => {}}
    />
  );
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  )!;
  await act(async () => button.click());
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockReset();
  request.mockImplementation(async (url: string) =>
    Response.json(
      url.endsWith("runs.list")
        ? {
            runs: [
              {
                id: "r1",
                bankId: "bank",
                name: "Saved run",
                createdAt: "2026-10-10",
              },
            ],
            total: 1,
            nextOffset: null,
          }
        : {
            runs: [],
            calibration: {
              bankRevisionId: "draft",
              total: 0,
              passed: 0,
              results: [],
            },
          },
    ),
  );
  vi.stubGlobal("fetch", request);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("previews parent-owned questions and rules without publishing or persisting an evaluator draft", async () => {
  await act(async () => root.render(<Fixture />));
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('[aria-label="Preview Saved run"]')!
      .click(),
  );
  await click("Preview saved answers");
  const previews = request.mock.calls.filter(([url]) =>
    url.endsWith("banks.preview-draft"),
  );
  expect(previews).toHaveLength(1);
  expect(request.mock.calls.map(([url]) => url)).toEqual([
    "/api/commands/runs.list",
    "/api/commands/banks.preview-draft",
  ]);
  expect(JSON.parse(previews[0]![1].body)).toMatchObject({
    bankId: "bank",
    questions,
    runIds: ["r1"],
    settings: { absoluteTolerance: 0.000001 },
  });
  expect(container.textContent).not.toContain("Publish and activate");
});
it("checks calibration against the current inline draft before the bank exists", async () => {
  request.mockResolvedValue(
    Response.json({
      bankRevisionId: "draft",
      total: 0,
      passed: 0,
      results: [],
    }),
  );
  await act(async () => root.render(<Fixture bankId="new" />));
  await click("Check calibration");
  expect(request.mock.calls[0]![0]).toBe("/api/commands/banks.calibrate-draft");
  expect(JSON.parse(request.mock.calls[0]![1].body).questions).toEqual(
    questions,
  );
  expect(container.textContent).toContain("0 / 0 calibration cases agree");
  expect(container.textContent).not.toContain("Saved run");
});
it("hides an outdated preview immediately after rules change", async () => {
  await act(async () => root.render(<Fixture />));
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('[aria-label="Preview Saved run"]')!
      .click(),
  );
  await click("Preview saved answers");
  expect(container.textContent).toContain("No score changes");
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Decimal places"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "1");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).not.toContain("No score changes");
});
it("keeps imported reference metadata warnings collapsed", async () => {
  await act(async () =>
    root.render(
      <BankGrading
        workspace={
          {
            banks: [],
            runs: [],
            revisions: [],
            evaluatorRevisions: [],
            evaluatorDrafts: [],
          } as unknown as Parameters<typeof BankGrading>[0]["workspace"]
        }
        bankId="new"
        questions={[
          {
            ...questions[0]!,
            expected: { type: "number", value: 1, tolerance: 0.1 },
          },
        ]}
        evaluatorName="Rules"
        onEvaluatorName={() => {}}
        settings={evaluatorSettingsSchema.parse({})}
        onSettings={() => {}}
        refresh={() => {}}
      />,
    ),
  );
  const details = Array.from(container.querySelectorAll("details")).find(
    (item) =>
      item.querySelector("summary")?.textContent?.includes("1 question"),
  );
  expect(details?.open).toBe(false);
});

it("pages runs for this bank and keeps selections when older runs are outside the workspace page", async () => {
  request.mockImplementation(async (url: string, options: RequestInit) => {
    if (!url.endsWith("runs.list")) return Response.json({ runs: [] });
    const input = JSON.parse(options.body as string);
    expect(input.bankId).toBe("bank");
    expect(input.limit).toBe(25);
    return Response.json(
      input.offset === 0
        ? {
            runs: [
              { id: "old1", name: "Older bank run", createdAt: "2026-10-10" },
            ],
            total: 26,
            nextOffset: 25,
          }
        : {
            runs: [
              { id: "old2", name: "Oldest bank run", createdAt: "2026-10-09" },
            ],
            total: 26,
            nextOffset: null,
          },
    );
  });
  await act(async () => root.render(<Fixture />));
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('[aria-label="Preview Older bank run"]')!
      .click(),
  );
  await click("Next runs");
  expect(container.textContent).toContain("Oldest bank run");
  expect(container.textContent).not.toContain("Older bank run");
  await act(async () =>
    container
      .querySelector<HTMLInputElement>(
        '[aria-label="Preview Oldest bank run"]',
      )!
      .click(),
  );
  await click("Preview saved answers");
  const preview = request.mock.calls.find(([url]) =>
    url.endsWith("banks.preview-draft"),
  )!;
  expect(JSON.parse(preview[1].body).runIds).toEqual(["old1", "old2"]);
});
