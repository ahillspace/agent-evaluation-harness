// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  evaluatorSettingsSchema,
  launchSchema,
  type WorkspaceView,
} from "../contracts.js";
import { Setup } from "./setup.js";
import { createLaunch, initialSetup } from "./drafts.js";
import {
  decodeSetupDraft,
  encodeSetupDraft,
  setupDraftKey,
} from "./setup-draft.js";

const banks = ["a", "b"].map((id) => ({
  id,
  name: `Bank ${id}`,
  createdAt: "2026-11-14",
  latestRevisionId: `revision-${id}`,
  activeEvaluatorRevisionId: `evaluator-${id}`,
  questionCount: 2,
  latestRevisionNumber: 1,
}));
const workspace: WorkspaceView = {
  workspaceId: "bank-recovery-workspace",
  banks,
  runs: [],
  totalRuns: 0,
  blueprints: [],
  researchSessions: [],
  connections: [],
};
const draft = {
  ...initialSetup(),
  targetKind: "external" as const,
  externalTarget: {
    kind: "external" as const,
    adapterId: "http",
    adapterVersion: 1,
    name: "Synthetic agent",
    configuration: {},
  },
  bankId: "a",
  bankRevisionId: "revision-a",
  evaluatorRevisionId: "evaluator-a",
  questionSelection: "selected" as const,
  questionIds: ["q2"],
  name: "Retained subset",
  repetitions: 3,
  timeoutSeconds: 73,
  concurrency: 2,
  maxOutputBytes: 123456,
  model: "retained-model",
  prompt: "Retain every hidden setting too.",
  settings: '{"maxTurns":7}',
  researcherSettings: '{"maxTurns":9}',
  researchInstructions: "Retained research instructions",
  maxCandidates: 4,
};
function detail(id = "a") {
  return {
    bank: banks.find((bank) => bank.id === id),
    revisions: [
      {
        id: `revision-${id}`,
        bankId: id,
        name: `Bank ${id}`,
        number: 1,
        questions: [
          { id: "q1", text: "First question?", expected: 1, tags: [] },
          { id: "q2", text: "Second question?", expected: 2, tags: [] },
        ],
      },
    ],
    evaluatorRevisions: [
      {
        id: `evaluator-${id}`,
        bankId: id,
        name: "Rules",
        settings: evaluatorSettingsSchema.parse({}),
      },
    ],
    evaluatorDrafts: [],
    jevProfiles: [],
  };
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const key = setupDraftKey(workspace.workspaceId)!;
let root: Root, container: HTMLDivElement;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  sessionStorage.clear();
  sessionStorage.setItem(key, encodeSetupDraft(draft, "questions", ""));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
const render = (sourceRunId?: string) =>
  act(async () =>
    root.render(
      <Setup
        workspace={workspace}
        refresh={() => {}}
        sourceRunId={sourceRunId}
      />,
    ),
  );
const start = () =>
  container.querySelector<HTMLButtonElement>(".setup-footer .primary")!;
const footer = () => container.querySelector(".setup-footer")!.textContent;
const retry = () =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Retry loading bank",
  );
const savedDraft = () => decodeSetupDraft(sessionStorage.getItem(key))!.draft;

it("explains a failed selected bank and retries without changing the complete draft or subset", async () => {
  const first = deferred(),
    second = deferred();
  let bankCalls = 0;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("banks.get"))
      return ++bankCalls === 1 ? first.promise : second.promise;
    throw new Error(`Unexpected request: ${url}`);
  });
  await render();
  expect(footer()).toContain("Loading question bank");
  expect(start().disabled).toBe(true);
  expect(retry()).toBeUndefined();
  await act(async () =>
    first.resolve(
      Response.json(
        {
          error: {
            code: "unavailable",
            message: "Bank temporarily unavailable",
          },
        },
        { status: 503 },
      ),
    ),
  );
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    "Bank temporarily unavailable",
  );
  expect(footer()).toContain("Question bank could not be loaded");
  expect(footer()).not.toContain("Choose a question bank");
  expect(start().disabled).toBe(true);
  expect(savedDraft()).toEqual(draft);
  expect(retry()).toBeDefined();
  await act(async () => retry()!.click());
  expect(footer()).toContain("Loading question bank");
  expect(retry()).toBeUndefined();
  expect(start().disabled).toBe(true);
  expect(savedDraft()).toEqual(draft);
  await act(async () => second.resolve(Response.json(detail())));
  expect(start().disabled).toBe(false);
  expect(footer()).toContain("1 question × 3 repetitions");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(retry()).toBeUndefined();
  const questions = Array.from(
    container.querySelectorAll<HTMLInputElement>(".selection-list input"),
  );
  expect(questions.map((input) => input.checked)).toEqual([false, true]);
  expect(savedDraft()).toEqual(draft);
  expect(bankCalls).toBe(2);
  expect(
    fetchMock.mock.calls.every(([url]) => String(url).endsWith("banks.get")),
  ).toBe(true);
});

it("does not show a cancelled bank failure in the replacement bank", async () => {
  const old = deferred(),
    current = deferred();
  const signals: AbortSignal[] = [];
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    expect(url).toContain("banks.get");
    signals.push(init.signal!);
    return JSON.parse(String(init.body)).bankId === "a"
      ? old.promise
      : current.promise;
  });
  await render();
  const select = container.querySelector<HTMLSelectElement>(
    '[aria-label="Question bank"]',
  )!;
  await act(async () => {
    select.value = "revision-b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(signals[0]!.aborted).toBe(true);
  await act(async () =>
    old.resolve(
      Response.json({ error: { message: "Old bank failed" } }, { status: 503 }),
    ),
  );
  expect(container.textContent).not.toContain("Old bank failed");
  expect(footer()).toContain("Loading question bank");
  await act(async () => current.resolve(Response.json(detail("b"))));
  expect(start().disabled).toBe(false);
  expect(savedDraft().bankRevisionId).toBe("revision-b");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("distinguishes an unavailable selected revision from no bank selection", async () => {
  fetchMock.mockResolvedValue(Response.json({ ...detail(), revisions: [] }));
  await render();
  expect(footer()).toContain("Selected bank revision is unavailable");
  expect(container.textContent).toContain(
    "Choose another question bank revision",
  );
  expect(start().disabled).toBe(true);
  expect(retry()).toBeUndefined();
  expect(savedDraft()).toEqual(draft);
});

it("replays an exact stored launch even when loading its bank fails", async () => {
  const input = {
    ...createLaunch(draft),
    idempotencyKey: "already-accepted-request",
  };
  sessionStorage.setItem(
    key,
    encodeSetupDraft(draft, "questions", "", {
      operation: "runs.launch",
      input,
    }),
  );
  const launches: unknown[] = [];
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("banks.get"))
      return Response.json(
        { error: { message: "Bank offline" } },
        { status: 503 },
      );
    if (url.endsWith("runs.launch")) {
      launches.push(JSON.parse(String(init.body)));
      return Response.json({ run: { id: "accepted-run" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  await render();
  expect(start().textContent).toContain("Retry launch");
  expect(start().disabled).toBe(false);
  await act(async () => start().click());
  expect(launches).toEqual([input]);
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(window.location.hash).toBe("#/runs/accepted-run");
});

it("blocks an invalid external timeout before submission and retains the entered draft", async () => {
  sessionStorage.setItem(
    key,
    encodeSetupDraft({ ...draft, timeoutSeconds: 601 }, "evaluation", ""),
  );
  fetchMock.mockResolvedValue(Response.json(detail()));
  await render();
  const timeout = container.querySelector<HTMLInputElement>(
    '[aria-label="Question timeout"]',
  )!;
  expect(timeout.max).toBe("600");
  expect(timeout.getAttribute("aria-invalid")).toBe("true");
  expect(start().disabled).toBe(true);
  expect(container.textContent).toContain(
    "Enter a timeout from 1 to 600 seconds.",
  );
  expect(savedDraft().timeoutSeconds).toBe(601);
  await act(async () => start().click());
  expect(
    fetchMock.mock.calls.every(([url]) => String(url).endsWith("banks.get")),
  ).toBe(true);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(timeout, "600");
    timeout.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(start().disabled).toBe(false);
  expect(timeout.getAttribute("aria-invalid")).toBeNull();
  expect(container.textContent).not.toContain("Enter a timeout from");
});

it.each([
  ["external", 1000],
  ["external", 1001],
  ["external", 1500],
  ["external", 600000],
  ["managed", 100],
  ["managed", 500],
  ["managed", 1001],
  ["managed", 3600000],
] as const)(
  "reuses %s %ims through actual Setup and submits the exact deadline",
  async (kind, timeoutMs) => {
    sessionStorage.clear();
    const launch = launchSchema.parse({
      bankRevisionId: "revision-a",
      target:
        kind === "external"
          ? draft.externalTarget
          : {
              kind: "managed",
              agent: { harness: "codex", model: "synthetic-model" },
            },
      limits: { timeoutMs },
    });
    const run = {
      id: "source-run",
      name: "Saved source",
      manifest: {
        ...launch,
        bank: { id: "revision-a", bankId: "a" },
        evaluator: { id: "evaluator-a" },
        questions: [{ id: "q1" }],
      },
    };
    const before = JSON.stringify(run),
      launches: Array<{ limits: { timeoutMs: number } }> = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("runs.get")) return Response.json({ run });
      if (url.endsWith("banks.get")) return Response.json(detail());
      if (url.endsWith("runtime.discover"))
        return Response.json({
          harnesses: [],
          connectionProviders: [],
          maxConcurrency: 8,
        });
      if (url.endsWith("runs.launch")) {
        launches.push(JSON.parse(String(init.body)));
        return Response.json({ run: { id: "accepted-run" } });
      }
      throw Error("Unexpected request: " + url);
    });
    await render("source-run");
    const evaluation = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Evaluation"),
    )!;
    await act(async () => evaluation.click());
    const timeout = container.querySelector<HTMLInputElement>(
      '[aria-label="Question timeout"]',
    )!;
    expect(timeout.value).toBe(String(timeoutMs / 1000));
    expect(timeout.min).toBe(kind === "external" ? "1" : "0.1");
    expect(timeout.max).toBe(kind === "external" ? "600" : "3600");
    expect(timeout.step).toBe("0.001");
    expect(start().disabled).toBe(false);
    expect(createLaunch(savedDraft()).limits.timeoutMs).toBe(timeoutMs);
    await act(async () => start().click());
    expect(launches).toHaveLength(1);
    expect(launches[0]!.limits.timeoutMs).toBe(timeoutMs);
    expect(JSON.stringify(run)).toBe(before);
  },
);
it("retains unsupported submillisecond precision and prevents submission", async () => {
  sessionStorage.setItem(
    key,
    encodeSetupDraft({ ...draft, timeoutSeconds: 1.0001 }, "evaluation", ""),
  );
  fetchMock.mockResolvedValue(Response.json(detail()));
  await render();
  const timeout = container.querySelector<HTMLInputElement>(
    '[aria-label="Question timeout"]',
  )!;
  expect(timeout.value).toBe("1.0001");
  expect(savedDraft().timeoutSeconds).toBe(1.0001);
  expect(start().disabled).toBe(true);
  expect(container.textContent).toContain("Use increments of 0.001 seconds.");
  expect(() => createLaunch(savedDraft())).toThrow(
    "Use increments of 0.001 seconds.",
  );
  await act(async () => start().click());
  expect(
    fetchMock.mock.calls.every(([url]) => String(url).endsWith("banks.get")),
  ).toBe(true);
});
