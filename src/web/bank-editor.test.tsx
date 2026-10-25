// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { evaluatorSettingsSchema, type Question } from "../contracts.js";
import { BankEditor } from "./bank-editor.js";
const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("./api.js", () => ({ command }));
it("saves the latest reference input and public context without relying on blur", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const saved = vi.fn();
  try {
    await act(async () =>
      root.render(
        <BankEditor
          question={{ id: "q1", text: "Count?", expected: 1, tags: [] }}
          settings={evaluatorSettingsSchema.parse({})}
          onClose={() => {}}
          onSaved={saved}
        />,
      ),
    );
    expect(
      Array.from(document.querySelectorAll("h3")).filter(
        (item) => item.textContent === "How this question is graded",
      ),
    ).toHaveLength(1);
    const edit = async (label: string, value: string) => {
      const input = document.querySelector<HTMLTextAreaElement>(
        `[aria-label="${label}"]`,
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await edit("Reference answer", "2");
    await edit("Public context", "Use the public data.");
    await edit("Public answer instructions", "Return the count.");
    await act(async () =>
      Array.from(document.querySelectorAll("button"))
        .find((item) => item.textContent === "Save draft")!
        .click(),
    );
    expect(saved).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: 2,
        context: "Use the public data.",
        evaluationGuidance: "Return the count.",
      }),
      expect.anything(),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

async function mountEditor(expected: Question["expected"]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  command.mockReset();
  command.mockResolvedValue({ status: "correct", explanation: "Matches." });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const saved = vi.fn();
  await act(async () =>
    root.render(
      <BankEditor
        question={{
          id: "q1",
          text: "Count?",
          expected,
          tags: [],
          ...(typeof expected === "number"
            ? {
                answerFormat: {
                  type: "scalar",
                  valueType: "decimal",
                  nullable: false,
                },
              }
            : {}),
        }}
        settings={evaluatorSettingsSchema.parse({})}
        onClose={() => {}}
        onSaved={saved}
      />,
    ),
  );
  return {
    saved,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}
async function editField(label: string, value: string) {
  const field = document.querySelector<HTMLTextAreaElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function clickButton(label: string) {
  await act(async () =>
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === label)!
      .click(),
  );
}
it("starts numeric references and sample checks as numbers", async () => {
  const editor = await mountEditor(49.1);
  try {
    expect(
      document.querySelector<HTMLSelectElement>(
        '[aria-label="Reference value type"]',
      )!.value,
    ).toBe("number");
    expect(
      document.querySelector<HTMLSelectElement>(
        '[aria-label="Sample value type"]',
      )!.value,
    ).toBe("number");
    await editField("Sample answer", "49.1");
    await clickButton("Check answer");
    expect(command).toHaveBeenCalledWith(
      "banks.check-answer",
      expect.objectContaining({
        answer: 49.1,
        question: expect.objectContaining({ expected: 49.1 }),
      }),
    );
  } finally {
    await editor.close();
  }
});
it("aligns empty samples with the reference kind and preserves entered sample choices", async () => {
  const editor = await mountEditor("Text");
  try {
    await editField("Reference value type", "number");
    expect(
      document.querySelector<HTMLSelectElement>(
        '[aria-label="Sample value type"]',
      )!.value,
    ).toBe("number");
    await editField("Sample answer", "12");
    await editField("Reference value type", "json");
    expect(
      document.querySelector<HTMLSelectElement>(
        '[aria-label="Sample value type"]',
      )!.value,
    ).toBe("number");
    expect(
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Sample answer"]',
      )!.value,
    ).toBe("12");
  } finally {
    await editor.close();
  }
});
it("rejects blank and non-finite numbers before saving or checking", async () => {
  const editor = await mountEditor(1);
  try {
    await clickButton("Check answer");
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "Sample answer cannot be blank",
    );
    expect(command).not.toHaveBeenCalled();
    await editField("Sample answer", "Infinity");
    await clickButton("Check answer");
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "finite number",
    );
    expect(command).not.toHaveBeenCalled();
    await editField("Reference answer", "");
    await clickButton("Save draft");
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "Reference answer cannot be blank",
    );
    expect(editor.saved).not.toHaveBeenCalled();
    await editField("Reference answer", "NaN");
    await clickButton("Save draft");
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "finite number",
    );
    expect(editor.saved).not.toHaveBeenCalled();
  } finally {
    await editor.close();
  }
});
