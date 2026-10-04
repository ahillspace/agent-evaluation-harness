import { getQuickJS } from "quickjs-emscripten";
import type { Json, Verdict } from "../contracts.js";
import { errorMessage } from "../domain/errors.js";

export async function gradeCustom(
  expected: Json,
  answer: Json,
  code: string,
): Promise<Verdict> {
  const serialized = JSON.stringify({ expected, answer });
  if (serialized.length > 2_000_000)
    return {
      status: "error",
      explanation: "Evaluator input exceeds the 2 MB limit.",
    };
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 100;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const result = context.evalCode(
      `JSON.stringify((function(input) { "use strict"; ${code}\n})(${serialized}))`,
    );
    if (result.error) {
      const error = context.dump(result.error) as unknown;
      result.error.dispose();
      throw new Error(JSON.stringify(error));
    }
    const output = context.getString(result.value);
    result.value.dispose();
    if (output.length > 64_000)
      throw new Error("Evaluator output exceeds the 64 KB limit.");
    const parsed = JSON.parse(output) as {
      verdict?: unknown;
      explanation?: unknown;
      details?: Json;
    };
    if (typeof parsed.verdict !== "boolean")
      throw new Error(
        "Custom evaluator must return { verdict: boolean, explanation?: string }.",
      );
    if (
      parsed.explanation !== undefined &&
      typeof parsed.explanation !== "string"
    )
      throw new Error("Evaluator explanation must be a string.");
    return {
      status: parsed.verdict ? "correct" : "incorrect",
      explanation:
        (parsed.explanation as string | undefined) ??
        "Custom evaluator verdict.",
      ...(parsed.details === undefined ? {} : { details: parsed.details }),
    };
  } catch (error) {
    return { status: "error", explanation: errorMessage(error) };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
