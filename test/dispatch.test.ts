import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeBrainDoc } from "../src/dispatch.js";
import type { Learning } from "../src/types.js";

const prov = { session: "s1", cwd: "/repo", ts: "2026-07-05T00:00:00Z" };

test("writeBrainDoc writes an inbox file named after the slug + content hash", () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const l: Learning = {
		text: "chose D1 over Neon for cost",
		kind: "decision",
		confidence: 0.9,
		title: "D1 vs Neon",
		provenance: prov,
	};
	const filename = writeBrainDoc(l, inbox);
	expect(filename).toMatch(/^d1-vs-neon-[0-9a-f]{8}\.md$/);
	const files = readdirSync(inbox);
	expect(files).toEqual([filename]);
	const body = readFileSync(join(inbox, filename), "utf8");
	expect(body).toContain("status: new");
	expect(body).toContain('session: "s1"');
	expect(body).toContain("chose D1 over Neon for cost");
});

test("writeBrainDoc falls back to the text when there is no title", () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const l: Learning = {
		text: "D1 timestamps must be integers",
		kind: "lesson",
		confidence: 0.9,
		provenance: prov,
	};
	const filename = writeBrainDoc(l, inbox);
	expect(filename).toMatch(/^d1-timestamps-must-be-integers-[0-9a-f]{8}\.md$/);
});

test("writeBrainDoc prevents slug collision by appending the content hash", () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const l1: Learning = {
		text: "chose D1 for cost savings",
		kind: "decision",
		confidence: 0.9,
		title: "Dup Title",
		provenance: prov,
	};
	const l2: Learning = {
		text: "chose D1 for performance",
		kind: "decision",
		confidence: 0.85,
		title: "Dup Title",
		provenance: { session: "s2", cwd: "/repo", ts: "2026-07-05T01:00:00Z" },
	};

	writeBrainDoc(l1, inbox);
	writeBrainDoc(l2, inbox);

	const files = readdirSync(inbox).filter((f) => f.startsWith("dup-title-"));
	expect(files).toHaveLength(2);
	const allContent = files
		.map((f) => readFileSync(join(inbox, f), "utf8"))
		.join("\n");
	expect(allContent).toContain("chose D1 for cost savings");
	expect(allContent).toContain("chose D1 for performance");
});
