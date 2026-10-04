import { sameTarget } from "./targets.js";
import { expect, it } from "vitest";
import { agentSchema, launchSchema, targetSchema } from "../contracts.js";
import { savedTarget, managedAgent, targetLabel } from "./targets.js";

const agent = agentSchema.parse({ harness: "codex", model: "luna" });
it("normalizes legacy launch input to the canonical managed target", () => {
  const input = launchSchema.parse({ bankRevisionId: "bank", agent });
  expect(input.target).toEqual({ kind: "managed", agent });
  expect(input).not.toHaveProperty("agent");
  expect(() =>
    launchSchema.parse({
      bankRevisionId: "bank",
      agent,
      target: { kind: "managed", agent },
    }),
  ).toThrow();
});
it("reads historical target settings without modifying their source", () => {
  const manifest = { agent, digest: "unchanged" };
  const before = JSON.stringify(manifest);
  expect(savedTarget(manifest)).toEqual({ kind: "managed", agent });
  expect(JSON.stringify(manifest)).toBe(before);
});
it("external targets have no managed agent configuration", () => {
  const target = targetSchema.parse({
    kind: "external",
    adapterId: "http",
    adapterVersion: 1,
    name: "Production agent",
    configuration: {},
  });
  expect(targetLabel(target)).toBe("Production agent");
  expect(() => managedAgent(target)).toThrow("managed");
  expect(() =>
    targetSchema.parse({ ...target, systemPrompt: "hidden" }),
  ).toThrow();
});

it("defaults external deadlines independently from managed targets", () => {
  const target = {
    kind: "external",
    adapterId: "http",
    adapterVersion: 1,
    name: "Endpoint",
    configuration: { endpoint: "https://example.com" },
  };
  expect(
    launchSchema.parse({ bankRevisionId: "bank", target }).limits.timeoutMs,
  ).toBe(120000);
  expect(
    launchSchema.parse({
      bankRevisionId: "bank",
      target,
      limits: { concurrency: 2 },
    }).limits.timeoutMs,
  ).toBe(120000);
  expect(
    launchSchema.parse({
      bankRevisionId: "bank",
      target,
      limits: { timeoutMs: 5000 },
    }).limits.timeoutMs,
  ).toBe(5000);
});

it("matches a saved target regardless of persisted object key order", () => {
  const left = {
    kind: "external" as const,
    adapterId: "http",
    adapterVersion: 1,
    name: "Endpoint",
    configuration: {
      endpoint: "https://example.com",
      headers: { a: "x", b: "y" },
    },
  };
  const right = {
    configuration: {
      headers: { b: "y", a: "x" },
      endpoint: "https://example.com",
    },
    name: "Endpoint",
    adapterVersion: 1,
    adapterId: "http",
    kind: "external" as const,
  };
  expect(sameTarget(left, right)).toBe(true);
  expect(
    sameTarget(left, {
      ...right,
      configuration: { endpoint: "https://other.example.com" },
    }),
  ).toBe(false);
});
