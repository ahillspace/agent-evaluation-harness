// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Setup } from "./setup.js";
import { initialSetup } from "./drafts.js";
import { encodeSetupDraft, setupDraftKey } from "./setup-draft.js";
import { evaluatorSettingsSchema, type WorkspaceView } from "../contracts.js";

it.each([false, true])(
  "retries the accepted %s launch after a lost response and reload with the same payload and key",
  async (research) => {
    const credentialBinding = {
      version: 1 as const,
      reference: "retained-research-credential",
      identity: "a".repeat(64),
    };
    const researcherConnection = {
      connectionId: "research-provider",
      provider: "openai",
      settings: {},
      credentialFields: ["apiKey"],
      credentialBinding,
    };
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    sessionStorage.clear();
    const bank = {
      id: "bank",
      name: "Questions",
      createdAt: "2026-10-22",
      latestRevisionId: "revision",
      activeEvaluatorRevisionId: "evaluator",
      questionCount: 1,
      latestRevisionNumber: 1,
    };
    const workspace: WorkspaceView = {
      workspaceId: "launch-workspace",
      banks: [bank],
      runs: [],
      totalRuns: 0,
      blueprints: [],
      researchSessions: [],
      connections: [
        {
          id: researcherConnection.connectionId,
          name: "Research provider",
          provider: "openai",
          settings: {},
          credentialFields: ["apiKey"],
          hasCredentials: true,
        },
      ],
    };
    const key = setupDraftKey(workspace.workspaceId)!;
    sessionStorage.setItem(
      key,
      encodeSetupDraft(
        {
          ...initialSetup(),
          bankId: bank.id,
          bankRevisionId: bank.latestRevisionId,
          model: "test",
          researcherModel: "test",
          researcherProviderConnectionId: researcherConnection.connectionId,
          researcherProviderConnectionProvider: "openai",
          originalResearcher: {
            harness: "codex",
            model: "test",
            systemPrompt: "",
            settings: {},
            tools: [],
            connections: [researcherConnection],
          },
          research,
        },
        "agent",
        "",
      ),
    );
    const requests: unknown[] = [];
    const accepted = new Map<string, unknown>();
    let loseResponse = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        let result: unknown;
        if (url.endsWith("runtime.discover"))
          result = {
            harnesses: [],
            connectionProviders: [],
            maxConcurrency: 1,
          };
        else if (url.endsWith("banks.get"))
          result = {
            bank,
            revisions: [
              {
                id: "revision",
                bankId: "bank",
                name: "Questions",
                number: 1,
                questions: [
                  { id: "q1", text: "Count?", expected: 1, tags: [] },
                ],
              },
            ],
            evaluatorRevisions: [
              {
                id: "evaluator",
                name: "Rules",
                settings: evaluatorSettingsSchema.parse({}),
              },
            ],
            evaluatorDrafts: [],
            jevProfiles: [],
          };
        else if (url.endsWith(".launch")) {
          const input = JSON.parse(String(init.body)) as {
            idempotencyKey: string;
          };
          requests.push(input);
          if (!accepted.has(input.idempotencyKey))
            accepted.set(
              input.idempotencyKey,
              research
                ? { session: { id: "session", currentRunId: "run" } }
                : { run: { id: "run" } },
            );
          result = accepted.get(input.idempotencyKey);
          if (loseResponse) {
            loseResponse = false;
            throw new TypeError("Network response lost");
          }
        } else result = [];
        return { ok: true, json: async () => result };
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    const start = async () => {
      const button = container.querySelector<HTMLButtonElement>(
        ".setup-footer .button.primary",
      )!;
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
    };
    try {
      await act(async () =>
        root.render(<Setup workspace={workspace} refresh={() => {}} />),
      );
      await start();
      if (research)
        expect(requests[0]).toHaveProperty(
          "researcher.connections.0.credentialBinding",
          credentialBinding,
        );
      expect(accepted.size).toBe(1);
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () =>
        root.render(<Setup workspace={workspace} refresh={() => {}} />),
      );
      await start();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(accepted.size).toBe(1);
      expect(sessionStorage.getItem(key)).toBeNull();
      expect(window.location.hash).toContain("/observe/run");
      await start();
      expect(requests).toHaveLength(3);
      expect(requests[2]).not.toEqual(requests[0]);
      expect(accepted.size).toBe(2);
      expect(sessionStorage.getItem(key)).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
      vi.unstubAllGlobals();
    }
  },
);
