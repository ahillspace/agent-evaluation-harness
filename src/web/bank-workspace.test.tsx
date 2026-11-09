// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  evaluatorSettingsSchema,
  type BankDetail,
  type WorkspaceView,
} from "../contracts.js";
import { BankWorkspace } from "./bank-workspace.js";
import {
  bankDraftKey,
  decodeBankDraft,
  encodeBankDraft,
  initialBankDraft,
} from "./bank-draft.js";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("./api.js", () => ({
  command,
  useResource: () => ({ data: [], error: null, refresh: vi.fn() }),
}));
const settings = evaluatorSettingsSchema.parse({});
const questions = [
  { id: "q1", text: "Count?", expected: 1, tags: ["finance"] },
  { id: "q2", text: "Region?", expected: "West", tags: ["geography"] },
];
const detail = {
  bank: {
    id: "b1",
    name: "Sales",
    latestRevisionId: "v1",
    activeEvaluatorRevisionId: "e1",
  },
  revisions: [
    {
      id: "v1",
      bankId: "b1",
      name: "Sales",
      number: 1,
      questions,
      createdAt: "2026-10-11",
      digest: "v1",
    },
  ],
  evaluatorRevisions: [
    {
      id: "e1",
      bankId: "b1",
      name: "Rules",
      number: 1,
      settings,
      createdAt: "2026-10-11",
      digest: "e1",
    },
  ],
  evaluatorDrafts: [],
  jevProfiles: [],
} as unknown as BankDetail;
const workspace = {
  workspaceId: "workspace",
  banks: [detail.bank],
  runs: [],
  connections: [],
} as unknown as WorkspaceView;
let root: Root;
let container: HTMLDivElement;
const published = vi.fn();
const refresh = vi.fn();
const render = async (value = detail, bankId = "b1") => {
  await act(async () =>
    root.render(
      <BankWorkspace
        workspace={workspace}
        bankId={bankId}
        detail={bankId === "new" ? undefined : value}
        refresh={refresh}
        onPublished={published}
      />,
    ),
  );
};
async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}
async function input(label: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  command.mockReset();
  published.mockReset();
  refresh.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("persists focused question edits and reloads the same bank draft", async () => {
  const question = container.querySelector<HTMLButtonElement>(
    ".bank-question-button",
  )!;
  await act(async () => question.click());
  await input("Question", "Updated count?");
  await input("Reference answer", "2");
  await click("Save draft");
  expect(container.textContent).toContain("Updated count?");
  expect(sessionStorage.getItem(bankDraftKey("workspace", "b1")!)).toContain(
    "Updated count?",
  );
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).toContain("Updated count?");
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
});
it("publishes questions and grading together only after review", async () => {
  await input("Bank name", "Updated bank");
  command.mockResolvedValueOnce({
    revision: { ...detail.revisions[0], id: "v2" },
    evaluatorRevision: { ...detail.evaluatorRevisions[0], id: "e2" },
  });
  await click("Publish changes");
  expect(command).not.toHaveBeenCalled();
  await click("Publish question bank and rules");
  expect(command).toHaveBeenCalledWith(
    "banks.publish",
    expect.objectContaining({
      bankId: "b1",
      baseRevisionId: "v1",
      baseEvaluatorRevisionId: "e1",
      name: "Updated bank",
      questions,
      evaluatorSettings: settings,
    }),
  );
  expect(published).toHaveBeenCalledWith("b1");
});
it("blocks publication of a draft whose published base changes", async () => {
  await input("Bank name", "Updated bank");
  await render({ ...detail, bank: { ...detail.bank, latestRevisionId: "v2" } });
  expect(container.textContent).toContain("changed after this draft started");
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === "Publish changes",
  )!;
  expect(button.disabled).toBe(true);
  expect(command).not.toHaveBeenCalled();
});
it("refreshes after a publication conflict and reloads actual latest content without losing the draft on failure", async () => {
  await input("Bank name", "Unsaved second editor");
  command.mockRejectedValueOnce(
    new Error(
      "The published bank changed. Reload before publishing your draft.",
    ),
  );
  await click("Publish changes");
  await click("Publish question bank and rules");
  expect(refresh).toHaveBeenCalled();
  expect(sessionStorage.getItem(bankDraftKey("workspace", "b1")!)).toContain(
    "Unsaved second editor",
  );
  await click("Keep editing");
  await click("Discard bank draft");
  command.mockRejectedValueOnce(new Error("Connection unavailable"));
  await click("Discard draft");
  expect(sessionStorage.getItem(bankDraftKey("workspace", "b1")!)).toContain(
    "Unsaved second editor",
  );
  const latest = {
    ...detail,
    bank: {
      ...detail.bank,
      name: "Published by first editor",
      latestRevisionId: "v2",
      activeEvaluatorRevisionId: "e2",
    },
    revisions: [
      {
        ...detail.revisions[0]!,
        id: "v2",
        name: "Published by first editor",
        questions: [{ ...questions[0]!, text: "Latest task?" }],
      },
    ],
    evaluatorRevisions: [{ ...detail.evaluatorRevisions[0]!, id: "e2" }],
  };
  command.mockResolvedValueOnce(latest);
  await click("Discard draft");
  expect(command).toHaveBeenLastCalledWith("banks.get", { bankId: "b1" });
  expect(container.textContent).toContain("Latest task?");
  expect(sessionStorage.getItem(bankDraftKey("workspace", "b1")!)).toContain(
    '"baseRevisionId":"v2"',
  );
});
it("imports pasted content in one action and retains optional profile criteria for later publication", async () => {
  await click("Import");
  await input(
    "Question import content",
    '{"format":"agent-evaluation-harness/question-bank","version":1,"name":"Package","questions":[{"id":"q3","text":"Total?","expected":3}],"evaluator":{"name":"Precision","settings":{"questionOverrides":{"q3":{"decimalPlaces":1}}}},"jevProfile":{"name":"Private criteria","settings":{}}}',
  );
  expect(document.body.textContent).not.toContain("Review import");
  await click("Import into draft");
  expect(container.textContent).toContain("Total?");
  expect(container.textContent).toContain(
    "Review imported Jev profile: Private criteria",
  );
  expect(command).not.toHaveBeenCalled();
});

async function importProfile(name: string, questionId: string) {
  await click("Import");
  await input(
    "Question import content",
    JSON.stringify({
      format: "agent-evaluation-harness/question-bank",
      version: 1,
      name: "Package",
      questions: [{ id: questionId, text: "Imported question?", expected: 3 }],
      evaluator: { name: "Rules", settings: {} },
      jevProfile: { name, settings: {} },
    }),
  );
  await click("Import into draft");
}

const packageSource = JSON.stringify({
  format: "agent-evaluation-harness/question-bank",
  version: 1,
  name: "Imported package",
  questions: [{ id: "q3", text: "Imported total?", expected: 3 }],
  evaluator: {
    name: "Imported precision",
    settings: {
      decimalPlaces: 2,
      questionOverrides: { q3: { decimalPlaces: 1 } },
    },
  },
  jevProfile: { name: "Imported criteria", settings: {} },
});
async function chooseFile(text: () => Promise<string>) {
  const field = document.querySelector<HTMLInputElement>(
    '[aria-label="Import question file"]',
  )!;
  await act(async () => {
    Object.defineProperty(field, "files", {
      configurable: true,
      value: [{ name: "questions.json", text }],
    });
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function newBank(stored = initialBankDraft()) {
  await act(async () => root.unmount());
  sessionStorage.clear();
  sessionStorage.setItem(
    bankDraftKey("workspace", "new")!,
    encodeBankDraft(stored),
  );
  root = createRoot(container);
  await render(detail, "new");
}
function savedDraft(bankId = "b1") {
  return decodeBankDraft(
    sessionStorage.getItem(bankDraftKey("workspace", bankId)!),
  )!;
}

it("imports a selected file directly after the existing-draft action choice", async () => {
  await click("Import");
  const mode = document.querySelector('[aria-label="Import action"]')!;
  const file = document.querySelector('[aria-label="Import question file"]')!;
  expect(
    mode.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await chooseFile(async () => packageSource);
  expect(
    document.querySelector('[aria-label="Import question file"]'),
  ).toBeNull();
  expect(savedDraft().questions.map((item) => item.id)).toEqual([
    "q1",
    "q2",
    "q3",
  ]);
  expect(savedDraft().settings.decimalPlaces).toBeUndefined();
  expect(savedDraft().settings.questionOverrides.q3).toEqual({
    decimalPlaces: 1,
  });
  expect(command).not.toHaveBeenCalled();
});
it("imports the complete package into a pristine new draft without a mode choice", async () => {
  await newBank();
  await click("Import");
  expect(document.querySelector('[aria-label="Import action"]')).toBeNull();
  await chooseFile(async () => packageSource);
  expect(savedDraft("new")).toMatchObject({
    name: "Imported package",
    evaluatorName: "Imported precision",
    settings: {
      decimalPlaces: 2,
      questionOverrides: { q3: { decimalPlaces: 1 } },
    },
    importedJevProfile: { name: "Imported criteria" },
  });
  expect(command).not.toHaveBeenCalled();
});
it("preserves authored settings and name in an empty draft unless replacement is selected", async () => {
  await newBank({
    ...initialBankDraft(),
    name: "Authored bank",
    settings: evaluatorSettingsSchema.parse({ decimalPlaces: 4 }),
  });
  await click("Import");
  expect(document.querySelector('[aria-label="Import action"]')).not.toBeNull();
  await chooseFile(async () => packageSource);
  expect(savedDraft("new").questions).toHaveLength(1);
  expect(savedDraft("new").name).toBe("Authored bank");
  expect(savedDraft("new").settings.decimalPlaces).toBe(4);
});
it("replaces draft questions and shared rules when selected before file import", async () => {
  await click("Import");
  const mode = document.querySelector<HTMLSelectElement>(
    '[aria-label="Import action"]',
  )!;
  await act(async () => {
    mode.value = "replace";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await chooseFile(async () => packageSource);
  expect(savedDraft().questions.map((item) => item.id)).toEqual(["q3"]);
  expect(savedDraft().settings.decimalPlaces).toBe(2);
  expect(command).not.toHaveBeenCalled();
});
it.each(["[]", "question,expected\n"])(
  "retains the draft and import dialog when a replacement file has no questions: %s",
  async (source) => {
    await click("Import");
    const mode = document.querySelector<HTMLSelectElement>(
      '[aria-label="Import action"]',
    )!;
    await act(async () => {
      mode.value = "replace";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await chooseFile(async () => source);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "at least one question",
    );
    expect(
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Question import content"]',
      )!.value,
    ).toBe(source);
    expect(savedDraft().questions).toEqual(questions);
    expect(command).not.toHaveBeenCalled();
  },
);
it.each([
  [
    "unsupported CSV",
    "question,expected,private\nCount?,1,secret",
    "Unsupported CSV columns: private",
  ],
  [
    "invalid CSV",
    'question,expected\n"Unclosed,1',
    "The CSV contains an unclosed quoted value.",
  ],
  ["invalid package", '{"format":"unsupported"}', "Invalid"],
  [
    "duplicate IDs",
    '[{"id":"q1","text":"Duplicate?","expected":1}]',
    "Question ID q1 already exists",
  ],
])(
  "keeps %s input and the draft intact when direct file import fails",
  async (_name, source, message) => {
    await click("Import");
    await chooseFile(async () => source);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      message,
    );
    expect(
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Question import content"]',
      )!.value,
    ).toBe(source);
    expect(savedDraft().questions).toEqual(questions);
    expect(command).not.toHaveBeenCalled();
  },
);
it("keeps pasted content after a file read failure", async () => {
  await click("Import");
  await input("Question import content", "Authored import content");
  await chooseFile(async () => {
    throw new Error("Cannot read file");
  });
  expect(document.body.textContent).toContain("Cannot read file");
  expect(
    document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Question import content"]',
    )!.value,
  ).toBe("Authored import content");
  expect(command).not.toHaveBeenCalled();
});
it("ignores an older file read after another file is selected", async () => {
  await click("Import");
  let finish!: (value: string) => void;
  await chooseFile(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await chooseFile(async () => packageSource);
  await act(async () => finish('[{"id":"old","text":"Old?","expected":0}]'));
  expect(savedDraft().questions.map((item) => item.id)).toEqual([
    "q1",
    "q2",
    "q3",
  ]);
});
it("ignores a pending file read after pasted content changes", async () => {
  await click("Import");
  let finish!: (value: string) => void;
  await chooseFile(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await input(
    "Question import content",
    '[{"id":"pasted","text":"Pasted?","expected":0}]',
  );
  await act(async () => finish(packageSource));
  expect(
    document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Question import content"]',
    )!.value,
  ).toContain("pasted");
  await click("Import into draft");
  expect(savedDraft().questions.map((item) => item.id)).toEqual([
    "q1",
    "q2",
    "pasted",
  ]);
});
it("ignores a pending file read after the import dialog closes", async () => {
  await click("Import");
  let finish!: (value: string) => void;
  await chooseFile(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const close = document.querySelector<HTMLButtonElement>(
    '[aria-label="Close dialog"]',
  )!;
  await act(async () => close.click());
  await act(async () => finish(packageSource));
  expect(savedDraft().questions).toEqual(questions);
  expect(command).not.toHaveBeenCalled();
});
it("retains a newly imported profile when an older profile publication completes", async () => {
  await importProfile("Profile A", "q3");
  let finish!: (value: unknown) => void;
  command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Publish and activate imported Jev profile");
  await importProfile("Profile B", "q4");
  await act(async () => finish({ id: "profile-a" }));
  expect(container.textContent).toContain(
    "Review imported Jev profile: Profile B",
  );
  expect(sessionStorage.getItem(bankDraftKey("workspace", "b1")!)).toContain(
    "Profile B",
  );
});
it("does not restore a published profile when a file started reading before publication completed", async () => {
  await importProfile("Profile A", "q3");
  let finishPublication!: (value: unknown) => void;
  command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPublication = resolve;
      }),
  );
  await click("Publish and activate imported Jev profile");
  await click("Import");
  let finishFile!: (value: string) => void;
  await chooseFile(
    () =>
      new Promise((resolve) => {
        finishFile = resolve;
      }),
  );
  await act(async () => finishPublication({ id: "profile-a" }));
  expect(savedDraft().importedJevProfile).toBeUndefined();
  await act(async () =>
    finishFile('[{"id":"q4","text":"New question?","expected":4}]'),
  );
  expect(savedDraft().questions.map((item) => item.id)).toEqual([
    "q1",
    "q2",
    "q3",
    "q4",
  ]);
  expect(savedDraft().importedJevProfile).toBeUndefined();
  expect(container.textContent).not.toContain(
    "Review imported Jev profile: Profile A",
  );
  expect(command).toHaveBeenCalledTimes(1);
});
it("preserves a reopened draft when an old bank publication completes after navigation", async () => {
  await input("Bank name", "Original publication");
  let finish!: (value: unknown) => void;
  command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click("Publish changes");
  await click("Publish question bank and rules");
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  await input("Bank name", "Latest reopened edits");
  await act(async () =>
    finish({
      revision: { ...detail.revisions[0], id: "v2", bankId: "b1" },
      evaluatorRevision: { ...detail.evaluatorRevisions[0], id: "e2" },
    }),
  );
  expect(sessionStorage.getItem(bankDraftKey("workspace", "b1")!)).toContain(
    "Latest reopened edits",
  );
  expect(published).not.toHaveBeenCalled();
});
it("saves unfinished sort settings across navigation and reload", async () => {
  await click("Grading");
  await click("Add sort column");
  expect(container.textContent).not.toContain("browser storage cannot save");
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  await click("Grading");
  expect(
    container.querySelector<HTMLInputElement>('[aria-label="Sort column 1"]')
      ?.value,
  ).toBe("");
});
it("marks a newly published, reloaded bank clean despite draft schema key ordering", async () => {
  const canonicalDetail = {
    ...detail,
    evaluatorRevisions: [
      {
        ...detail.evaluatorRevisions[0]!,
        settings: Object.fromEntries(
          Object.entries(settings).reverse(),
        ) as typeof settings,
      },
    ],
  };
  await act(async () => root.unmount());
  sessionStorage.clear();
  root = createRoot(container);
  await render(canonicalDetail);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(canonicalDetail);
  expect(container.textContent).not.toContain("Draft changes");
  expect(
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Publish changes",
    )?.disabled,
  ).toBe(true);
  await input("Bank name", "Actual name change");
  await click("Publish changes");
  expect(document.body.textContent).toContain("Grading rules stay the same");
  expect(document.body.textContent).not.toContain("Review exact rule changes");
});
