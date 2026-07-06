import type { Turn } from "./types.js";

export function buildExtractionPrompt(turns: Turn[]): string {
	const convo = turns
		.map((t) => `${t.role.toUpperCase()}: ${t.text}`)
		.join("\n");
	return [
		"You extract durable learnings from a coding session transcript.",
		"Return ONLY a JSON array. Each item: {text, kind, confidence, title?}.",
		'kind ∈ {"fact","decision","lesson","noise"}. confidence ∈ [0,1].',
		"fact = concrete current-state (PR merged, deployed, root-caused).",
		"decision = a choice made and why. lesson = a durable gotcha/rule.",
		"noise = chatter. Do NOT include secrets/tokens. Be terse.",
		"TRANSCRIPT:",
		convo,
	].join("\n");
}
