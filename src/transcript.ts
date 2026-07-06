import { readFileSync } from "node:fs";
import type { Turn } from "./types.js";

type ContentPart = { type?: string; text?: string };
type Record = {
	type?: string;
	message?: { role?: string; content?: string | ContentPart[] };
};

function partsToText(content: string | ContentPart[] | undefined): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p.type === "text" || typeof p.text === "string")
		.map((p) => p.text ?? "")
		.join(" ")
		.trim();
}

export function parseTranscript(path: string): Turn[] {
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	const turns: Turn[] = [];
	for (const line of lines) {
		let rec: Record;
		try {
			rec = JSON.parse(line) as Record;
		} catch {
			continue;
		}
		if (rec.type !== "user" && rec.type !== "assistant") continue;
		const role = rec.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = partsToText(rec.message?.content);
		if (text) turns.push({ role, text });
	}
	return turns;
}
