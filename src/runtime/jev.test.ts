import { afterEach, expect, it, vi } from "vitest";
import {
  jevProfileSettingsSchema,
  type FrozenJevJudge,
  type JudgeEvidence,
} from "../contracts.js";
import { JevClassifier } from "./jev.js";

afterEach(() => vi.unstubAllGlobals());
const criteria = jevProfileSettingsSchema.parse({});
const connection = {
  connectionId: "key",
  provider: "typesafe",
  settings: {},
  credentialFields: ["apiKey"],
};
const configuration: FrozenJevJudge = {
  connection,
  model: "jev-1.13.0",
  profile: {
    id: "profile",
    bankId: "bank",
    number: 1,
    name: "Default",
    createdAt: "",
    settings: criteria,
    digest: "digest",
  },
};
const evidence: JudgeEvidence = {
  schemaVersion: 1,
  runId: "run",
  resultId: "result",
  attemptId: "attempt",
  repetition: 1,
  question: { id: "q", text: "How many?", tags: [] },
  expected: 42,
  referenceCriteria: { absoluteTolerance: 0, relativeTolerance: 0 },
  finalAnswer: 42,
  finalText: "42",
  publicAgent: {
    harness: "codex",
    model: "model",
    systemPrompt: "",
    tools: [],
    settings: {},
    connections: [],
  },
  startedAt: "",
  finishedAt: "",
  trace: {
    format: "provider_transcript",
    entries: [{ type: "tool", data: "complete trace marker" }],
  },
};
const make = () =>
  new JevClassifier({
    freeze: async () => connection,
    credentials: async () => ({ apiKey: "fixture-secret" }),
    redactionSecrets: async () => ["other-secret"],
  });
const response = () => ({
  model: "jev-1.13.0",
  answers: Object.fromEntries(
    Object.entries(criteria.checks).map(([key, check]) => {
      const labels = Object.keys(check.criteria);
      return [
        key,
        {
          type: "choice",
          choice: labels[0],
          confidence: 0.73,
          probabilities: Object.fromEntries(
            labels.map((label, index) => [label, index === 0 ? 0.8 : 0.1]),
          ),
        },
      ];
    }),
  ),
  usage: { input_tokens: 1200, output_tokens: 52 },
});
const invoke = (judge: JevClassifier, overrides = {}) =>
  judge.evaluate({
    configuration,
    criteria,
    evidence,
    timeoutMs: 2000,
    signal: new AbortController().signal,
    onRequest: () => {},
    ...overrides,
  });

it("judges answer-only evidence without inventing an agent or internal activity", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(response())),
  );
  const result = await invoke(make(), {
    criteria: { ...criteria, evidenceRequirement: "answer" },
    evidence: {
      ...evidence,
      publicAgent: undefined,
      publicTarget: {
        kind: "external",
        adapterId: "http",
        adapterVersion: 1,
        name: "Endpoint",
        configuration: {},
      },
      observationLevel: "answer-only",
      trace: { format: "unavailable", entries: null },
    },
  });
  expect(JSON.stringify(result.request)).toContain(
    "absence of internal activity does not show that an action was omitted",
  );
  expect(result.request).toHaveProperty("state.trace.entries", null);
});

it("sends all evidence, three standalone Choice questions, and checkpoints the exact sanitized body before HTTP", async () => {
  let checkpoint: unknown;
  const http = vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(String(options.body))).toEqual(checkpoint);
    return Response.json(response());
  });
  vi.stubGlobal("fetch", http);
  const result = await invoke(make(), {
    evidence: { ...evidence, finalText: "other-secret fixture-secret" },
    onRequest: (request: unknown) => {
      checkpoint = request;
    },
  });
  expect(result.request).toHaveProperty(
    "state.trace.entries",
    evidence.trace.entries,
  );
  expect(JSON.stringify(result.request)).not.toContain("other-secret");
  expect(JSON.stringify(result.request)).not.toContain("fixture-secret");
  expect(result.checks.answer).toEqual({
    choice: "acceptable",
    confidence: 0.73,
    probabilities: {
      acceptable: 0.8,
      incorrect: 0.1,
      insufficient_evidence: 0.1,
    },
  });
  expect(result.usage).toMatchObject({ inputTokens: 1200, outputTokens: 52 });
  expect(result.response).toEqual(response());
  expect(http).toHaveBeenCalledTimes(1);
});
it("rejects oversized complete evidence before HTTP without truncation", async () => {
  const http = vi.fn();
  vi.stubGlobal("fetch", http);
  await expect(
    invoke(make(), {
      evidence: {
        ...evidence,
        trace: {
          format: "provider_transcript",
          entries: ["x".repeat(2_100_000)],
        },
      },
    }),
  ).rejects.toMatchObject({ code: "capacity_exceeded" });
  expect(http).not.toHaveBeenCalled();
});
it("accepts complete traces over 32k bytes without pretending bytes are tokens", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(response())),
  );
  const trace = {
    format: "provider_transcript" as const,
    entries: ["x".repeat(100_000)],
  };
  const result = await invoke(make(), { evidence: { ...evidence, trace } });
  expect(result.request).toHaveProperty("state.trace", trace);
});
it("close interrupts and drains HTTP work, retaining checkpoint provenance", async () => {
  let admitted!: () => void;
  const entered = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options: RequestInit) => {
      admitted();
      return new Promise<Response>((_resolve, reject) =>
        options.signal!.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    }),
  );
  const judge = make();
  const pending = invoke(judge);
  const failure = expect(pending).rejects.toMatchObject({
    code: "interrupted",
    request: { model: "jev-1.13.0" },
  });
  await entered;
  await judge.close();
  await failure;
});
it.each(["confidence", "probabilities", "choice", "model"])(
  "rejects invalid %s with raw provenance and reported usage",
  async (field) => {
    const raw = response();
    if (field === "model") raw.model = "jev-1.14.0";
    else if (field === "confidence")
      delete (raw.answers.answer! as { confidence?: number }).confidence;
    else if (field === "probabilities")
      raw.answers.answer!.probabilities.acceptable = 0.2;
    else raw.answers.answer!.choice = "unsupported";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(raw)),
    );
    await expect(invoke(make())).rejects.toMatchObject({
      code: "invalid_provider_response",
      response: raw,
      usage: { inputTokens: 1200, outputTokens: 52 },
    });
  },
);
it("discovers official model names and rejects further work after close", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toBe("https://api.typesafe.ai/v1/models");
      return Response.json({
        models: [
          {
            name: "jev-latest",
            description: "Current",
            release_date: "2026-09-15",
          },
        ],
      });
    }),
  );
  const judge = make();
  expect(await judge.testConnection("key")).toMatchObject({
    ok: true,
    resources: { models: [{ id: "jev-latest", provider: "typesafe" }] },
  });
  await judge.close();
  await expect(invoke(judge)).rejects.toMatchObject({ code: "unavailable" });
});
