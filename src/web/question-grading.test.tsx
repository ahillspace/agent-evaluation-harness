// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  evaluatorSettingsSchema,
  type EvaluatorSettings,
} from "../contracts.js";
import {
  QuestionGradingFields,
  SharedGradingFields,
  AppliedRulesJson,
} from "./question-grading.js";

let root: Root;
let container: HTMLDivElement;
function Fixture({
  shared = false,
  initial = {},
}: {
  shared?: boolean;
  initial?: Partial<EvaluatorSettings>;
}) {
  const [settings, setSettings] = useState(
    evaluatorSettingsSchema.parse(initial),
  );
  return (
    <>
      <output>{JSON.stringify(settings)}</output>
      {shared ? (
        <SharedGradingFields settings={settings} onSettings={setSettings} />
      ) : (
        <QuestionGradingFields
          questionId="q1"
          settings={settings}
          onSettings={setSettings}
        />
      )}
    </>
  );
}
function current() {
  return JSON.parse(
    container.querySelector("output")!.textContent!,
  ) as EvaluatorSettings;
}
async function change(label: string, value: string) {
  await act(async () => {
    const input = document.querySelector<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  )!;
  await act(async () => button.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("shows the engine defaults without adding a question override", async () => {
  await act(async () => root.render(<Fixture />));
  expect(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Absolute tolerance"]',
    )!.value,
  ).toBe("0.000001");
  expect(
    container.querySelector<HTMLInputElement>('[aria-label="Decimal places"]')!
      .value,
  ).toBe("");
  expect(current().questionOverrides).toEqual({});
  expect(container.textContent).toContain("Inherits bank defaults");
});
it("keeps effective rules visible and question customization collapsed", async () => {
  await act(async () => root.render(<Fixture />));
  const customization = Array.from(container.querySelectorAll("details")).find(
    (item) =>
      item.querySelector("summary")?.textContent === "Customize grading rules",
  )!;
  expect(customization).toBeDefined();
  expect(customization.open).toBe(false);
  expect(
    customization.querySelector('[aria-label="Absolute tolerance"]'),
  ).not.toBeNull();
  expect(
    customization.querySelector('[aria-label="Question rules current JSON"]'),
  ).not.toBeNull();
  expect(container.querySelector(".notice")?.closest("details")).toBeNull();
  await act(async () => root.render(<Fixture shared />));
  expect(
    container
      .querySelector('[aria-label="Absolute tolerance"]')
      ?.closest("details"),
  ).toBeNull();
});
it("edits only the selected rule and resets the question to inherited rules", async () => {
  await act(async () =>
    root.render(
      <Fixture
        initial={{ questionOverrides: { q2: { caseSensitive: true } } }}
      />,
    ),
  );
  await change("Decimal places", "1");
  expect(current().questionOverrides).toEqual({
    q1: { decimalPlaces: 1 },
    q2: { caseSensitive: true },
  });
  expect(current().decimalPlaces).toBeUndefined();
  await click("Use bank defaults");
  expect(current().questionOverrides).toEqual({ q2: { caseSensitive: true } });
});
it("updates inherited values when bank defaults change", async () => {
  await act(async () =>
    root.render(<Fixture initial={{ decimalPlaces: 2 }} />),
  );
  expect(
    container.querySelector<HTMLInputElement>('[aria-label="Decimal places"]')!
      .value,
  ).toBe("2");
  await change("Absolute tolerance", "0.1");
  expect(current().questionOverrides.q1).toEqual({ absoluteTolerance: 0.1 });
  expect(container.textContent).toContain(
    "Round numeric values to 2 decimal places",
  );
});
it("keeps advanced JSON out of settings until explicit validated apply", async () => {
  await act(async () => root.render(<Fixture shared />));
  await click("Edit column comparison rules");
  await change(
    "Column comparison rules JSON",
    '{"amount":{"decimalPlaces":2}}',
  );
  expect(current().columnRules).toBeUndefined();
  await click("Apply column comparison rules");
  expect(current().columnRules).toEqual({ amount: { decimalPlaces: 2 } });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click("Edit column comparison rules");
  await change(
    "Column comparison rules JSON",
    '{"amount":{"decimalPlaces":-1}}',
  );
  await click("Apply column comparison rules");
  expect(current().columnRules).toEqual({ amount: { decimalPlaces: 2 } });
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
});
it("preserves unrelated overrides when advanced question JSON is applied", async () => {
  await act(async () =>
    root.render(
      <Fixture
        initial={{ questionOverrides: { q2: { absoluteTolerance: 0.2 } } }}
      />,
    ),
  );
  await click("Edit question rules");
  await change(
    "Question rules JSON",
    '{"decimalPlaces":1,"columnAliases":{"amount":["total"]}}',
  );
  expect(current().questionOverrides.q1).toBeUndefined();
  await click("Apply question rules");
  expect(current().questionOverrides.q1).toEqual({
    decimalPlaces: 1,
    columnAliases: { amount: ["total"] },
  });
  expect(current().questionOverrides.q2).toEqual({ absoluteTolerance: 0.2 });
});
it("preserves copyable JSON when external rules change and requires a fresh basis", async () => {
  const apply = vi.fn();
  const render = async (value: unknown) => {
    await act(async () =>
      root.render(
        <AppliedRulesJson
          label="Question rules"
          value={value}
          onApply={apply}
          help="Private evaluator overrides."
        />,
      ),
    );
  };
  await render({ decimalPlaces: 1 });
  await click("Edit question rules");
  await change("Question rules JSON", '{"decimalPlaces":2}');
  await render({ decimalPlaces: 3 });
  expect(
    document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Question rules JSON"]',
    )!.value,
  ).toBe('{"decimalPlaces":2}');
  expect(document.body.textContent).toContain(
    "changed while this editor was open",
  );
  const applyButton = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === "Apply question rules",
  )!;
  expect(applyButton.disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  await click("Load current JSON");
  expect(
    JSON.parse(
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Question rules JSON"]',
      )!.value,
    ),
  ).toEqual({ decimalPlaces: 3 });
  await change("Question rules JSON", '{"decimalPlaces":4}');
  await click("Apply question rules");
  expect(apply).toHaveBeenCalledWith({ decimalPlaces: 4 });
});
it("discards modal JSON only after cancel and reopens from current rules", async () => {
  await act(async () => root.render(<Fixture shared />));
  await click("Edit column comparison rules");
  await change("Column comparison rules JSON", '{"unfinished":');
  expect(document.body.textContent).toContain(
    "Closing this dialog discards unapplied edits",
  );
  await click("Cancel");
  expect(current().columnRules).toBeUndefined();
  await click("Edit column comparison rules");
  expect(
    document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Column comparison rules JSON"]',
    )!.value,
  ).toBe("");
});
