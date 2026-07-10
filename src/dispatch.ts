import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashLearning } from "./ledger.js";
import type { Target } from "./policy.js";
import { route } from "./policy.js";
import type { Learning } from "./types.js";

export type DispatchDeps = {
	writeMem0: (json: string) => Promise<void>;
	writeMoneta: (json: string) => Promise<void>;
	brainInboxDir: string;
	slugify?: (s: string) => string;
};

function defaultSlug(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "note"
	);
}

function mem0Payload(l: Learning): string {
	return JSON.stringify({
		user_id: "mnemosyne",
		text: l.text,
		infer: false,
		app: "claude-code",
		metadata: {
			kind: l.kind,
			session: l.provenance.session,
			cwd: l.provenance.cwd,
			ts: l.provenance.ts,
		},
	});
}

// Payload for moneta's POST /capture ({ content, tags, source, metadata }).
// `content` is just the learning text — moneta embeds this, so provenance
// must stay out of it to avoid diluting recall. Provenance instead rides in
// `metadata` (stored + returned, never embedded; requires moneta >= v1.4.0).
// `tags` encodes the mnemosyne marker plus the learning kind.
function monetaPayload(l: Learning): string {
	return JSON.stringify({
		content: l.text,
		tags: ["mnemosyne", l.kind],
		source: "mnemosyne",
		metadata: {
			kind: l.kind,
			session: l.provenance.session,
			cwd: l.provenance.cwd,
			ts: l.provenance.ts,
		},
	});
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

export async function dispatch(
	l: Learning,
	deps: DispatchDeps,
): Promise<Target[]> {
	const slugify = deps.slugify ?? defaultSlug;
	const targets = route(l);
	for (const t of targets) {
		if (t === "mem0") await deps.writeMem0(mem0Payload(l));
		if (t === "moneta") await deps.writeMoneta(monetaPayload(l));
		if (t === "brain") {
			const slug = slugify(l.title ?? l.text);
			const hash = hashLearning(l).slice(0, 8);
			const filename = `${slug}-${hash}.md`;
			writeFileSync(join(deps.brainInboxDir, filename), inboxDoc(l));
		}
	}
	return targets;
}
