import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionEditor } from "./connection-editor.js";
import { JevAssessment, jevErrorLabel } from "./jev-assessment.js";
import { RoleProvider } from "./model-fields.js";
import { JevProfileEditor } from "./jev-profile.js";
import { JudgeSavedAnswers } from "./judge-saved.js";
import { AgentSettings } from "./agent-settings.js";
import { initialSetup } from "./drafts.js";
import {
  jevProfileSettingsSchema,
  type JevAssessmentSummary,
} from "../contracts.js";

describe("Jev presentation boundaries", () => {
  it("distinguishes provider token capacity from an incorrect answer", () => {
    expect(jevErrorLabel("token_limit_exceeded")).toBe(
      "Not judged: token limit exceeded",
    );
    expect(jevErrorLabel("capacity_exceeded")).toBe(
      "Not judged: request limit exceeded",
    );
  });
  it("exposes versioned instructions, three check criteria, and question overrides", () => {
    const html = renderToStaticMarkup(
      <JevProfileEditor bankId="b" profiles={[]} onSaved={() => {}} />,
    );
    expect(html).toContain("Publish and activate profile");
    expect(html).toContain("Answer correctness criteria");
    expect(html).toContain("Evidence support criteria");
    expect(html).toContain("Reference consistency criteria");
    expect(html).toContain('aria-label="Jev question overrides"');
    expect(html).toContain('aria-label="Jev confidence threshold"');
    expect(html).toContain("Allow answer-only fallback");
    expect(html).not.toContain('aria-label="Fallback shared instructions"');
  });
  it("loads saved evidence before offering a new assessment", () => {
    const html = renderToStaticMarkup(
      <JudgeSavedAnswers
        runId="r"
        workspace={{
          banks: [],
          runs: [],
          totalRuns: 0,
          blueprints: [],
          researchSessions: [],
          connections: [],
        }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(html).toContain("Score saved answers");
    expect(html).toContain("Loading saved answers");
  });
  it("exposes separate fallback criteria only when enabled in the saved profile", () => {
    const html = renderToStaticMarkup(
      <JevProfileEditor
        bankId="b"
        profiles={[
          {
            id: "p",
            bankId: "b",
            number: 1,
            name: "Trace checks",
            createdAt: "2026-10-08",
            digest: "profile-digest",
            settings: jevProfileSettingsSchema.parse({
              evidenceRequirement: "internal-activity",
              answerOnlyFallback: {},
            }),
          },
        ]}
        onSaved={() => {}}
      />,
    );
    expect(html).toContain("Allow answer-only fallback");
    expect(html).toContain('aria-label="Fallback shared instructions"');
    expect(html).toContain('aria-label="Fallback answer instructions"');
    expect(html).toContain('aria-label="Fallback acceptable criterion"');
    expect(html).toContain("Not assessed");
  });
  it("shows omitted fallback checks as not assessed without invented confidence", () => {
    const html = renderToStaticMarkup(
      <JevAssessment
        assessment={{
          id: "a",
          runId: "r",
          resultId: "q",
          attemptId: "t",
          createdAt: "2026-10-08",
          kind: "original",
          profileRevisionId: "p",
          profileRevisionNumber: 1,
          profileName: "Trace checks",
          confidenceThreshold: 0.7,
          status: "completed",
          published: true,
          reviewRequired: true,
          fallbackApplied: true,
          checks: {
            answer: {
              choice: "acceptable",
              confidence: 0.9,
              probabilities: { acceptable: 0.9, incorrect: 0.1 },
            },
          },
        }}
      />,
    );
    expect(html).toContain("Answer-only fallback");
    expect(html.match(/Not assessed/g)).toHaveLength(2);
    expect(html.match(/confidence<\/span>/g)).toHaveLength(1);
    expect(html).not.toContain("insufficient evidence");
  });
  it("renders three independent classifications and probabilities without creating a pass verdict", () => {
    const value = {
      id: "a",
      runId: "r",
      resultId: "q",
      attemptId: "t",
      createdAt: "today",
      kind: "original",
      profileRevisionId: "p",
      profileRevisionNumber: 2,
      profileName: "Criteria",
      confidenceThreshold: 0.7,
      status: "completed",
      published: true,
      reviewRequired: true,
      checks: {
        answer: {
          choice: "acceptable",
          confidence: 0.6,
          probabilities: {
            acceptable: 0.6,
            incorrect: 0.3,
            insufficient_evidence: 0.1,
          },
        },
        evidence: {
          choice: "supported",
          confidence: 0.8,
          probabilities: { supported: 0.8 },
        },
        reference: {
          choice: "unknown",
          confidence: 0.7,
          probabilities: { unknown: 0.7 },
        },
      },
    } satisfies JevAssessmentSummary;
    const html = renderToStaticMarkup(<JevAssessment assessment={value} />);
    expect(html).toContain("Answer correctness");
    expect(html).toContain("Evidence support");
    expect(html).toContain("Reference consistency");
    expect(html).toContain("60.0%");
    expect(html).toContain("Needs review");
    expect(html).not.toContain("Pass");
  });
  it("keeps capacity errors separate from classifications", () => {
    const html = renderToStaticMarkup(
      <JevAssessment
        assessment={
          {
            id: "a",
            status: "error",
            published: false,
            error: { code: "capacity", message: "Provider has no capacity" },
          } as JevAssessmentSummary
        }
      />,
    );
    expect(html).toContain("capacity");
    expect(html).toContain("Provider has no capacity");
    expect(html).not.toContain("Answer correctness");
  });
  it("does not offer judge-only credentials to target, LLM judge, or researcher roles", () => {
    const target = renderToStaticMarkup(
      <AgentSettings
        draft={initialSetup()}
        set={() => {}}
        connections={[
          {
            id: "j",
            name: "Judge-only secret",
            provider: "typesafe",
            settings: {},
            credentialFields: ["apiKey"],
            hasCredentials: true,
          },
        ]}
      />,
    );
    expect(target).not.toContain("Judge-only secret");
    const html = renderToStaticMarkup(
      <RoleProvider
        label="Role authentication"
        value=""
        onChange={() => {}}
        connections={[
          {
            id: "j",
            name: "Judge-only secret",
            provider: "typesafe",
            settings: {},
            credentialFields: ["apiKey"],
            hasCredentials: true,
          },
        ]}
      />,
    );
    expect(html).not.toContain("Judge-only secret");
  });
  it("offers TypeSafe credentials without accepting custom endpoints", () => {
    const html = renderToStaticMarkup(
      <ConnectionEditor
        connection={{
          id: "j",
          name: "Jev",
          provider: "typesafe",
          settings: {},
          credentialFields: ["apiKey"],
          hasCredentials: true,
        }}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    expect(html).toContain("TypeSafe / Jev");
    expect(html).toContain('type="password"');
    expect(html).not.toContain('aria-label="API base URL"');
    expect(html).not.toContain("Advanced connection settings");
  });
});
