// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BankDetail, JevProfileRevision } from "../contracts.js";
import { jevProfileSettingsSchema } from "../contracts.js";
import { JevConfiguration } from "./jev-configuration.js";

let root: Root;
let container: HTMLDivElement;
const published = vi.fn();
const profile = (bankId: string, id: string): JevProfileRevision => ({
  bankId,
  id,
  name: id,
  number: 1,
  createdAt: "2026-10-09",
  settings: jevProfileSettingsSchema.parse({}),
  digest: id,
});
function Fixture() {
  const [bankId, setBankId] = useState("bank-a");
  const [selection, setSelection] = useState({
    connectionId: "jev",
    model: "jev-1.13.0",
    profileRevisionId: "profile-a",
  });
  const bank = {
    bank: { id: bankId },
    jevProfiles: [
      profile(bankId, bankId === "bank-a" ? "profile-a" : "profile-b"),
    ],
  } as BankDetail;
  return (
    <>
      <button
        onClick={() => {
          setBankId("bank-b");
          setSelection({ ...selection, profileRevisionId: "profile-b" });
        }}
      >
        Switch bank
      </button>
      <output>{JSON.stringify(selection)}</output>
      <JevConfiguration
        value={selection}
        onChange={(value) =>
          setSelection({
            ...value,
            profileRevisionId: value.profileRevisionId ?? "",
          })
        }
        connections={[]}
        bank={bank}
        onPublished={published}
      />
    </>
  );
}
function button(label: string) {
  const element = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function delayedPublication() {
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  return async (bankId: string, id: string) => {
    await act(async () => resolve(Response.json(profile(bankId, id))));
  };
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  published.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Fixture />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("ignores late publication after closing the editor and switching banks", async () => {
  const finish = delayedPublication();
  await click("Edit instructions and criteria");
  await click("Publish and activate profile");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!
      .click(),
  );
  await click("Switch bank");
  await finish("bank-a", "late-profile-a");
  expect(container.querySelector("output")!.textContent).toContain(
    '"profileRevisionId":"profile-b"',
  );
  expect(published).not.toHaveBeenCalled();
});
it("ignores a closed editor's completion after reopening for the same bank", async () => {
  const finish = delayedPublication();
  await click("Edit instructions and criteria");
  await click("Publish and activate profile");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!
      .click(),
  );
  await click("Edit instructions and criteria");
  await finish("bank-a", "late-profile-a");
  expect(container.querySelector("output")!.textContent).toContain(
    '"profileRevisionId":"profile-a"',
  );
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(published).not.toHaveBeenCalled();
});
it("invalidates an open editor when the selected bank changes", async () => {
  const finish = delayedPublication();
  await click("Edit instructions and criteria");
  await click("Publish and activate profile");
  await click("Switch bank");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await finish("bank-a", "late-profile-a");
  expect(container.querySelector("output")!.textContent).toContain(
    '"profileRevisionId":"profile-b"',
  );
  expect(published).not.toHaveBeenCalled();
});
it("uses current connection and model settings when a publication completes", async () => {
  const finish = delayedPublication();
  await click("Edit instructions and criteria");
  await click("Publish and activate profile");
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(
      '[aria-label="Jev model version"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "jev-1.14.0");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await finish("bank-a", "new-profile-a");
  expect(container.querySelector("output")!.textContent).toContain(
    '"model":"jev-1.14.0"',
  );
  expect(container.querySelector("output")!.textContent).toContain(
    '"profileRevisionId":"new-profile-a"',
  );
  expect(published).toHaveBeenCalledOnce();
});
