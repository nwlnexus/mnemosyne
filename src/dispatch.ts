import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashLearning } from "./ledger.js";
import type { Learning } from "./types.js";

// moneta is the sole memory sink for captures now (see monetaWriter.ts
// captureSession) — this module only writes the local second-brain inbox
// doc for learnings drainOnce routes there (decisions + lessons).

function defaultSlug(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "note"
	);
}

function inboxDoc(l: Learning): string {
	const title = l.title ?? l.text.slice(0, 60);
	const why = `routed as ${l.kind} (confidence ${l.confidence})`;
	return [
		"---",
		"type: source",
		`title: ${JSON.stringify(title)}`,
		"status: new",
		`captured: ${l.provenance.ts.slice(0, 10)}`,
		"provenance:",
		`  session: ${JSON.stringify(l.provenance.session)}`,
		`  cwd: ${JSON.stringify(l.provenance.cwd)}`,
		`  why: ${JSON.stringify(why)}`,
		"---",
		"",
		l.text,
		"",
	].join("\n");
}

// Write the second-brain inbox doc for `l`. Filename is `${slug}-${hash8}.md`
// (slug from the title/text, hash from hashLearning) so re-dispatching the
// same learning overwrites rather than duplicating.
export function writeBrainDoc(
	l: Learning,
	brainInboxDir: string,
	slugify: (s: string) => string = defaultSlug,
): string {
	const slug = slugify(l.title ?? l.text);
	const hash = hashLearning(l).slice(0, 8);
	const filename = `${slug}-${hash}.md`;
	writeFileSync(join(brainInboxDir, filename), inboxDoc(l));
	return filename;
}
