import { expect, it, vi } from "vitest";
import { hydrateSetupSource } from "./setup-source.js";
import {
  researchSchema,
  type RunRecord,
  type Blueprint,
} from "../contracts.js";
import { initialSetup, createLaunch } from "./drafts.js";

const launch = createLaunch({
  ...initialSetup(),
  bankRevisionId: "b1",
  model: "candidate",
});
const run = {
  name: "Original",
  researchSessionId: "research1",
  manifest: {
    ...launch,
    bank: { id: "b1", bankId: "bank1" },
    evaluator: { id: "eval1" },
    questions: [{ id: "q1" }],
  },
} as unknown as RunRecord;
const research = researchSchema.parse({
  baseline: launch,
  researcher: {
    harness: "codex",
    model: "luna",
    settings: { maxTurns: 23 },
    systemPrompt: "Improve carefully",
  },
  objective: "Accuracy",
  maxCandidates: 7,
});
it("hydrates blueprint research and source question selection without replacing blueprint target settings", async () => {
  const blueprint = {
    ...launch,
    id: "blueprint",
    name: "Saved blueprint",
    sourceRunId: "run1",
    target: {
      kind: "managed",
      agent: {
        ...(launch.target!.kind === "managed" ? launch.target.agent : {}),
        model: "blueprint-model",
        systemPrompt: "Blueprint instructions",
      },
    },
  } as unknown as Blueprint;
  const restored = await hydrateSetupSource(
    { blueprint },
    {
      run: vi.fn().mockResolvedValue(run),
      research: vi.fn().mockResolvedValue(research),
    },
  );
  expect(restored).toMatchObject({
    name: "Saved blueprint copy",
    model: "blueprint-model",
    prompt: "Blueprint instructions",
    bankId: "bank1",
    bankRevisionId: "b1",
    questionIds: ["q1"],
    research: true,
    researcherModel: "luna",
    maxCandidates: 7,
  });
});
it("propagates missing source and research errors rather than silently changing reuse settings", async () => {
  const blueprint = {
    ...launch,
    id: "b",
    name: "Saved",
    sourceRunId: "missing",
  } as unknown as Blueprint;
  await expect(
    hydrateSetupSource(
      { blueprint },
      {
        run: vi.fn().mockRejectedValue(new Error("Source unavailable")),
        research: vi.fn(),
      },
    ),
  ).rejects.toThrow("Source unavailable");
  await expect(
    hydrateSetupSource(
      { runId: "run1" },
      {
        run: vi.fn().mockResolvedValue(run),
        research: vi.fn().mockRejectedValue(new Error("Research unavailable")),
      },
    ),
  ).rejects.toThrow("Research unavailable");
});
