import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { dispatch } from "../src/dispatch.js";
import type { Learning } from "../src/types.js";

const prov = { session: "s1", cwd: "/repo", ts: "2026-07-05T00:00:00Z" };

test("dispatch writes mem0 payload and brain inbox file for a decision", async () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const writeMem0 = vi.fn(async () => {});
	const writeMoneta = vi.fn(async () => {});
	const l: Learning = {
		text: "chose D1 over Neon for cost",
		kind: "decision",
		confidence: 0.9,
		title: "D1 vs Neon",
		provenance: prov,
	};
	const targets = await dispatch(l, {
		writeMem0,
		writeMoneta,
		brainInboxDir: inbox,
	});
	expect(targets.sort()).toEqual(["brain", "mem0", "moneta"]);
	expect(writeMem0).toHaveBeenCalledOnce();
	expect(JSON.parse(writeMem0.mock.calls[0][0]).text).toBe(
		"chose D1 over Neon for cost",
	);
	const files = readdirSync(inbox);
	const matchingFiles = files.filter((f) => f.startsWith("d1-vs-neon-"));
	expect(matchingFiles).toHaveLength(1);
	const body = readFileSync(join(inbox, matchingFiles[0]), "utf8");
	expect(body).toContain("status: new");
	expect(body).toContain('session: "s1"');
});

test("dispatch dual-writes a moneta capture alongside mem0", async () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const writeMem0 = vi.fn(async () => {});
	const writeMoneta = vi.fn(async () => {});
	const l: Learning = {
		text: "chose D1 over Neon for cost",
		kind: "decision",
		confidence: 0.9,
		title: "D1 vs Neon",
		provenance: prov,
	};
	const targets = await dispatch(l, {
		writeMem0,
		writeMoneta,
		brainInboxDir: inbox,
	});
	expect(targets).toContain("moneta");
	expect(writeMoneta).toHaveBeenCalledOnce();
	const capture = JSON.parse(writeMoneta.mock.calls[0][0]);
	// content carries the learning text + its provenance (mem0 payload spirit)
	expect(capture.content).toContain("chose D1 over Neon for cost");
	expect(capture.content).toContain("s1");
	expect(capture.content).toContain("/repo");
	// tags include the mnemosyne marker plus the learning kind
	expect(capture.tags).toContain("mnemosyne");
	expect(capture.tags).toContain("decision");
	expect(capture.source).toBe("mnemosyne");
});

test("dispatch does not invoke moneta or mem0 for a brain-only lesson", async () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const writeMem0 = vi.fn(async () => {});
	const writeMoneta = vi.fn(async () => {});
	const l: Learning = {
		text: "D1 timestamps must be integers",
		kind: "lesson",
		confidence: 0.9,
		provenance: prov,
	};
	const targets = await dispatch(l, {
		writeMem0,
		writeMoneta,
		brainInboxDir: inbox,
	});
	expect(targets).toEqual(["brain"]);
	expect(writeMem0).not.toHaveBeenCalled();
	expect(writeMoneta).not.toHaveBeenCalled();
});

test("dispatch prevents slug collision by appending content hash", async () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const writeMem0 = vi.fn(async () => {});
	const writeMoneta = vi.fn(async () => {});

	// Two distinct learnings with the same title
	const l1: Learning = {
		text: "chose D1 for cost savings",
		kind: "decision",
		confidence: 0.9,
		title: "Dup Title",
		provenance: { session: "s1", cwd: "/repo", ts: "2026-07-05T00:00:00Z" },
	};

	const l2: Learning = {
		text: "chose D1 for performance",
		kind: "decision",
		confidence: 0.85,
		title: "Dup Title",
		provenance: { session: "s2", cwd: "/repo", ts: "2026-07-05T01:00:00Z" },
	};

	await dispatch(l1, { writeMem0, writeMoneta, brainInboxDir: inbox });
	await dispatch(l2, { writeMem0, writeMoneta, brainInboxDir: inbox });

	const files = readdirSync(inbox);
	const matchingFiles = files.filter((f) => f.startsWith("dup-title-"));

	// Both distinct learnings should produce distinct files
	expect(matchingFiles).toHaveLength(2);

	// Verify content of both files - read all files and check both texts are present
	const allBodies = matchingFiles.map((f) =>
		readFileSync(join(inbox, f), "utf8"),
	);
	const allContent = allBodies.join("\n");

	// Both files should have status: new
	expect(allBodies).toHaveLength(2);
	allBodies.forEach((body) => {
		expect(body).toContain("status: new");
	});

	// Both distinct texts should be in the inbox files
	expect(allContent).toContain("chose D1 for cost savings");
	expect(allContent).toContain("chose D1 for performance");
});
