export type EvidenceRequirement =
  "answer" | "internal-activity" | "unspecified";
export function evaluatorEvidenceRequirement(settings: {
  mode: string;
  evidenceRequirement?: EvidenceRequirement;
}): EvidenceRequirement {
  return (
    settings.evidenceRequirement ??
    (settings.mode === "custom" ? "unspecified" : "answer")
  );
}
export function evidenceSupports(
  observation: "answer-only" | "internal-activity",
  requirement: EvidenceRequirement,
): boolean {
  return observation === "internal-activity" || requirement === "answer";
}
