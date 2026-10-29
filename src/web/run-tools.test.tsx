// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RunTools } from "./run-tools.js";
import { initialSetup, createLaunch, type SetupDraft } from "./drafts.js";

it("selects readable datasources across pages and preserves exact identity, metadata, and manual recovery", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const first = {
    id: "fe44d2e5-3631-4426-bd97-a5a9a0d6ced6",
    name: "Supply chain",
    projectName: "Sandbox",
  };
  const second = {
    id: "38bf6eb9-2093-4f41-a228-516a3a97abde",
    name: "Supply chain",
    projectName: "Production",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body)) as {
        page: number;
        search?: string;
      };
      return {
        ok: input.search !== "fail",
        status: 503,
        json: async () =>
          input.search === "fail"
            ? { error: { message: "Catalog unavailable" } }
            : input.search
              ? { resources: [], nextPage: null, total: 0 }
              : {
                  resources: [input.page === 2 ? second : first],
                  nextPage: input.page === 2 ? null : 2,
                  total: 2,
                },
      };
    }),
  );
  let draft: SetupDraft = {
    ...initialSetup(),
    bankRevisionId: "bank-revision",
    model: "test",
    connectionId: "tableau",
  };
  function Fixture() {
    const [value, setValue] = useState(draft);
    draft = value;
    return (
      <RunTools
        draft={value}
        set={(key, next) =>
          setValue((previous) => ({ ...previous, [key]: next }))
        }
        workspace={{
          connections: [
            {
              id: "tableau",
              name: "Analytics",
              provider: "tableau",
              settings: {},
              credentialFields: [],
              hasCredentials: true,
            },
          ],
        }}
        discoveredTools={[]}
        discoveringTools={false}
        discoverTools={async () => {}}
      />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === label,
    )!;
    await act(async () => button.click());
  };
  const search = async (value: string) => {
    const field = container.querySelector<HTMLInputElement>(
      '[aria-label="Exact datasource name"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Find datasource");
  };
  try {
    await act(async () => root.render(<Fixture />));
    expect(container.textContent).toContain("Supply chain / Sandbox");
    await click("Next page");
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Datasource"]',
    )!;
    await act(async () => {
      select.value = second.id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Previous page");
    expect(select.value).toBe(second.id);
    expect(select.selectedOptions[0]?.textContent).toBe(
      "Supply chain / Production",
    );
    const launch = createLaunch(draft);
    expect(
      launch.target?.kind === "managed" && launch.target.agent.connections[0],
    ).toMatchObject({
      resourceId: second.id,
      resourceName: second.name,
      resourceProjectName: second.projectName,
    });
    expect(container.textContent).toContain("does not restrict access");
    await search("missing");
    expect(container.textContent).toContain(
      "No datasources match this exact name",
    );
    expect(select.value).toBe(second.id);
    await search("fail");
    expect(container.textContent).toContain("Catalog unavailable");
    expect(container.textContent).not.toContain(
      "No datasources match this exact name",
    );
    expect(
      container.querySelector('[aria-label="Datasource or resource ID"]'),
    ).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
