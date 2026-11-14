// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Help, Modal } from "./ui.js";

// Happy DOM models open/close, but native browser QA owns focus and inertness proof.
let root: Root, container: HTMLDivElement;
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

it("keeps the same dirty draft while dismissal is refused and closes only after acceptance", async () => {
  let accept = false;
  const requests = vi.fn();
  function Fixture() {
    const [open, setOpen] = useState(true);
    return open ? (
      <Modal
        title="Controlled draft"
        onClose={() => {
          requests();
          if (accept) setOpen(false);
        }}
      >
        <input aria-label="Draft" defaultValue="Original" />
      </Modal>
    ) : (
      <p>Accepted close</p>
    );
  }
  await act(async () => root.render(<Fixture />));
  const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
  expect(dialog).not.toBeNull();
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute("closedby")).toBe("none");
  const draft = dialog.querySelector<HTMLInputElement>("input")!;
  draft.value = "Unsaved edit";
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  const cancel = new Event("cancel", { bubbles: false, cancelable: true });
  await act(async () => {
    dialog.dispatchEvent(escape);
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    dialog.dispatchEvent(cancel);
    dialog
      .querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!
      .click();
    dialog.click();
  });
  expect(escape.defaultPrevented).toBe(true);
  expect(cancel.defaultPrevented).toBe(true);
  expect(requests).toHaveBeenCalledTimes(5);
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector("input")).toBe(draft);
  expect(draft.value).toBe("Unsaved edit");
  await act(async () => draft.click());
  expect(requests).toHaveBeenCalledTimes(5);
  accept = true;
  await act(async () =>
    dialog.dispatchEvent(new Event("cancel", { cancelable: true })),
  );
  expect(document.querySelector("dialog")).toBeNull();
  expect(dialog.open).toBe(false);
  expect(container.textContent).toBe("Accepted close");
});

it("closes a departing native dialog before replacement or route teardown without requesting dismissal", async () => {
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <Modal title="Loading" onClose={onClose}>
        Loading...
      </Modal>,
    ),
  );
  const loading = document.querySelector<HTMLDialogElement>("dialog")!;
  expect(loading.open).toBe(true);
  await act(async () =>
    root.render(
      <div>
        <Modal title="Ready" onClose={onClose}>
          <input defaultValue="Ready draft" />
        </Modal>
      </div>,
    ),
  );
  const ready = document.querySelector<HTMLDialogElement>("dialog")!;
  expect(loading.open).toBe(false);
  expect(ready).not.toBe(loading);
  expect(ready.open).toBe(true);
  await act(async () => root.render(<p>Different route</p>));
  expect(ready.open).toBe(false);
  expect(document.querySelector("dialog[open]")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

it("isolates child dismissal and keeps Help tooltips in the owning native dialog", async () => {
  const parentClose = vi.fn();
  await act(async () =>
    root.render(
      <Modal title="Parent draft" onClose={parentClose}>
        <input defaultValue="Preserved parent" />
        <Help label="Draft help" tooltip="Short explanation">
          <p>Full explanation</p>
        </Help>
      </Modal>,
    ),
  );
  const parent = document.querySelector<HTMLDialogElement>("dialog")!;
  expect(parent).not.toBeNull();
  const draft = parent.querySelector<HTMLInputElement>("input")!;
  const help = parent.querySelector<HTMLButtonElement>(
    '[aria-label="About Draft help"]',
  )!;
  await act(async () => help.focus());
  expect(parent.querySelector(".help-popover")?.textContent).toBe(
    "Short explanation",
  );
  await act(async () => help.click());
  const child = Array.from(
    document.querySelectorAll<HTMLDialogElement>("dialog"),
  ).find((dialog) => dialog !== parent)!;
  expect(child.open).toBe(true);
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => child.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true);
  expect(child.open).toBe(false);
  expect(parent.open).toBe(true);
  expect(parent.querySelector("input")).toBe(draft);
  expect(draft.value).toBe("Preserved parent");
  expect(parentClose).not.toHaveBeenCalled();
  await act(async () => help.click());
  const reopened = Array.from(
    document.querySelectorAll<HTMLDialogElement>("dialog"),
  ).find((dialog) => dialog !== parent)!;
  const cancel = new Event("cancel", { cancelable: true });
  await act(async () => reopened.dispatchEvent(cancel));
  expect(cancel.defaultPrevented).toBe(true);
  expect(reopened.open).toBe(false);
  expect(parent.open).toBe(true);
  expect(parentClose).not.toHaveBeenCalled();
});
