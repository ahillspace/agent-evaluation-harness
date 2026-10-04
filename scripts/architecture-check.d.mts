export function inspectSource(file: string, source: string): string[];
export function checkArchitecture(
  root: string,
): Promise<{ checked: number; failures: string[] }>;
