import type { Json } from "../contracts.js";
import { expectedAnswerSize } from "../contracts/answer-size.js";
import { Help } from "./ui.js";

export function AnswerSize({ answer }: { answer: Json }) {
  const size = expectedAnswerSize(answer);
  return (
    <span className={`answer-size ${size.severity}`}>
      <span>
        {size.severity === "danger"
          ? "Expected answer exceeds Jev context estimate"
          : size.severity === "warning"
            ? "Large expected answer"
            : "Expected answer"}
        : ~{size.tokens.toLocaleString()} tokens
      </span>
      <Help label="Expected answer size">
        Approximate tokens from serialized answer bytes, not a model tokenizer.
        Jev also receives the actual answer, instructions, and trace. The
        complete request can exceed its context limit before this answer reaches
        32,000 tokens. Smaller answers do not guarantee that the request fits.
      </Help>
    </span>
  );
}
