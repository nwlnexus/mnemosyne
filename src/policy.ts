import type { Learning } from "./types.js";

export type Target = "mem0" | "brain";

const MIN_CONFIDENCE = 0.6;

// Credential-shaped: long high-entropy tokens, key=secret pairs, PEM headers.
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{8,}\b/,
  /\b[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)\b\s*[:=]\s*\S{6,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
];

export function isSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function route(learning: Learning): Target[] {
  if (isSecret(learning.text)) return [];
  if (learning.kind === "noise") return [];
  if (learning.confidence < MIN_CONFIDENCE) return [];

  const targets: Target[] = [];
  // Atomic current-state facts → mem0.
  if (learning.kind === "fact" || learning.kind === "decision") targets.push("mem0");
  // Durable, distilled truth → second-brain.
  if (learning.kind === "decision" || learning.kind === "lesson") targets.push("brain");
  return targets;
}
