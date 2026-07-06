import type { LLMDeps } from "./llm.js";
import { callLLM } from "./llm.js";
import { buildExtractionPrompt } from "./prompt.js";
import { parseTranscript } from "./transcript.js";
import type { Learning, LearningKind, Provenance } from "./types.js";

const KINDS: LearningKind[] = ["fact", "decision", "lesson", "noise"];

type RawLearning = {
	text?: unknown;
	kind?: unknown;
	confidence?: unknown;
	title?: unknown;
};

function firstJsonArray(text: string): string {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	return start >= 0 && end > start ? text.slice(start, end + 1) : "[]";
}

function coerce(raw: unknown, prov: Provenance): Learning | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as RawLearning;
	if (typeof r.text !== "string" || !r.text.trim()) return null;
	if (typeof r.kind !== "string" || !KINDS.includes(r.kind as LearningKind))
		return null;
	const c =
		typeof r.confidence === "number" && Number.isFinite(r.confidence)
			? r.confidence
			: 0;
	const learning: Learning = {
		text: r.text.trim(),
		kind: r.kind as LearningKind,
		confidence: Math.min(1, Math.max(0, c)),
		provenance: prov,
	};
	if (typeof r.title === "string" && r.title.trim())
		learning.title = r.title.trim();
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
	return parsed
		.map((r) => coerce(r, prov))
		.filter((l): l is Learning => l !== null);
}
