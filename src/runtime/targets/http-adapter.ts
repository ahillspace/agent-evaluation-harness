import type {
  ExternalTargetConfig,
  TargetConfig,
  PublicQuestion,
} from "../../contracts.js";
import { externalCapabilities } from "../../contracts/targets.js";
import { httpTargetSchema } from "../../contracts/http-target.js";
import { executeHttpTarget } from "./http.js";
import type {
  TargetAdapter,
  TargetAdapterOutput,
  TargetInvocation,
} from "./contracts.js";
import { buildHttpRequest } from "./http-mapping.js";

export class HttpTargetAdapter implements TargetAdapter {
  readonly id = "http";
  readonly version = 1;
  readonly capabilities = externalCapabilities;
  constructor(
    private readonly resolveConfiguration: (
      target: ExternalTargetConfig,
    ) => Promise<ExternalTargetConfig>,
    private readonly credential: (
      target: ExternalTargetConfig,
    ) => Promise<string | undefined>,
  ) {}
  validate(target: TargetConfig): ExternalTargetConfig {
    if (
      target.kind !== "external" ||
      target.adapterId !== this.id ||
      target.adapterVersion !== this.version
    )
      throw new Error("Unsupported HTTP target version.");
    return {
      ...target,
      configuration: httpTargetSchema.parse(target.configuration),
    };
  }
  async resolve(target: TargetConfig): Promise<TargetConfig> {
    return this.resolveConfiguration(this.validate(target));
  }
  credentials(target: ExternalTargetConfig) {
    const configuration = httpTargetSchema.parse(
      this.validate(target).configuration,
    );
    return {
      required: configuration.authentication.kind !== "none",
      reference:
        configuration.authentication.kind === "none"
          ? undefined
          : configuration.authentication.credentialReference,
      bind: (reference: string | undefined): ExternalTargetConfig => ({
        ...target,
        configuration: {
          ...configuration,
          authentication:
            configuration.authentication.kind === "none"
              ? { kind: "none" }
              : {
                  ...configuration.authentication,
                  credentialReference: reference ?? "unbound",
                },
        },
      }),
    };
  }
  preview(target: TargetConfig, question: PublicQuestion) {
    return buildHttpRequest(
      httpTargetSchema.parse(this.validate(target).configuration),
      { question, runId: "preview", attemptId: "preview", repetition: 1 },
    );
  }
  async invoke(input: TargetInvocation): Promise<TargetAdapterOutput> {
    if (input.target.kind !== "external")
      throw new Error("Expected an external target.");
    const configuration = httpTargetSchema.parse(input.target.configuration);
    const credential = await this.credential(input.target);
    const result = await executeHttpTarget({
      ...input,
      configuration,
      credential,
      async onDispatch() {
        await input.checkpoint({
          dispatched: true,
          adapterId: "http",
          version: 1,
        });
      },
    });
    const { answer: _answer, ...transport } = result;
    return {
      answer: result.answer,
      text:
        typeof result.answer === "string"
          ? result.answer
          : JSON.stringify(result.answer),
      evidenceScope: "answer-only" as const,
      cleanup: "complete" as const,
      transport: {
        schemaVersion: 1,
        adapterId: this.id,
        adapterVersion: this.version,
        ...transport,
      },
      terminalReason: "completed",
    };
  }
  async recover() {
    return {
      cleanup: "complete" as const,
      remoteCompletion: "unknown" as const,
    };
  }
  async close() {}
}
