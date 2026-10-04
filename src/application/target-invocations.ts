import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { jsonSchema, targetSchema, type RuntimePort } from "../contracts.js";
import { AppError } from "../domain/errors.js";

const checkpointSchema = z
  .object({
    version: z.literal(1),
    attemptId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    target: targetSchema,
    checkpoint: jsonSchema,
  })
  .strict();
type Recovery = Awaited<ReturnType<RuntimePort["recoverTarget"]>>;

/** Durable resource ownership is separate from immutable answer evidence. */
export class TargetInvocations {
  private readonly directory: string;
  constructor(
    directory: string,
    private readonly runtime: Pick<RuntimePort, "execute" | "recoverTarget">,
  ) {
    this.directory = join(directory, "target-invocations");
  }
  async recover(): Promise<Map<string, Recovery>> {
    const reports = new Map<string, Recovery>();
    const files = await readdir(this.directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const checkpoint = checkpointSchema.parse(
        JSON.parse(await readFile(join(this.directory, file), "utf8")),
      );
      const report = await this.runtime.recoverTarget(
        checkpoint.target,
        checkpoint.checkpoint,
      );
      if (report.cleanup !== "complete")
        throw new AppError(
          "cleanup_failed",
          "Target resource recovery requires attention before new work.",
        );
      reports.set(checkpoint.attemptId, report);
      await rm(join(this.directory, file));
    }
    return reports;
  }
  async execute(input: Parameters<RuntimePort["execute"]>[0]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.attemptId))
      throw new Error("Invalid invocation ID.");
    const filename = join(this.directory, `${input.attemptId}.json`);
    let output;
    try {
      output = await this.runtime.execute({
        ...input,
        checkpoint: async (value) => {
          input.signal.throwIfAborted();
          const record = checkpointSchema.parse({
            version: 1,
            attemptId: input.attemptId,
            target: input.target,
            checkpoint: value,
          });
          await mkdir(this.directory, { recursive: true });
          await writeFile(`${filename}.pending`, JSON.stringify(record), {
            mode: 0o600,
          });
          await rename(`${filename}.pending`, filename);
          await input.checkpoint(value);
        },
      });
    } catch (error) {
      // The adapter contract reserves cleanup_failed for unresolved resources.
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "cleanup_failed"
      ))
        await rm(filename, { force: true });
      throw error;
    }
    if (output.cleanup !== "unavailable") await rm(filename, { force: true });
    return output;
  }
}
