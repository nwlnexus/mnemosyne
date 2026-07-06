import type { LLMDeps } from "./llm.js";
import { callLLM } from "./llm.js";
import { buildExtractionPrompt } from "./prompt.js";
import { parseTranscript } from "./transcript.js";
import type { Learning, LearningKind, Provenance } from "./types.js";

const KINDS: LearningKind[] = ["fact", "decision", "lesson", "noise"];

type RawLearning = { text?: unknown; kind?: unknown; confidence?: unknown; title?: unknown };

function firstJsonArray(text: string): string {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "[]";
}

function coerce(raw: RawLearning, prov: Provenance): Learning | null {
  if (typeof raw.text !== "string" || !raw.text.trim()) return null;
  if (typeof raw.kind !== "string" || !KINDS.includes(raw.kind as LearningKind)) return null;
  const c = typeof raw.confidence === "number" ? raw.confidence : 0;
  const learning: Learning = {
    text: raw.text.trim(),
    kind: raw.kind as LearningKind,
    confidence: Math.min(1, Math.max(0, c)),
    provenance: prov,
  };
  if (typeof raw.title === "string" && raw.title.trim()) learning.title = raw.title.trim();
  return learning;
}

export async function extract(
  transcriptPath: string,
  prov: Provenance,
  deps: LLMDeps = {},
): Promise<Learning[]> {
  const turns = parseTranscript(transcriptPath);
  if (turns.length === 0) return [];
  const out = await callLLM(buildExtractionPrompt(turns), deps);
  let parsed: RawLearning[];
  try {
    parsed = JSON.parse(firstJsonArray(out)) as RawLearning[];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((r) => coerce(r, prov)).filter((l): l is Learning => l !== null);
}
