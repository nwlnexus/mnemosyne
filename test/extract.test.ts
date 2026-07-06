import { expect, test } from "vitest";
import { extract } from "../src/extract.js";

const prov = { session: "s1", cwd: "/repo", ts: "2026-07-05T00:00:00Z" };

test("extract parses LLM JSON into Learnings and attaches provenance", async () => {
	const runClaude = async () =>
		JSON.stringify([
			{
				text: "PR #201 merged",
				kind: "fact",
				confidence: 0.9,
				title: "PR 201",
			},
			{ text: "junk", kind: "not-a-kind", confidence: 5 },
		]);
	const fetchImpl = async () => new Response("x", { status: 500 });
	const learnings = await extract("test/fixtures/session-basic.jsonl", prov, {
		fetchImpl: fetchImpl as unknown as typeof fetch,
		runClaude,
	});
	expect(learnings).toEqual([
		{
			text: "PR #201 merged",
			kind: "fact",
			confidence: 0.9,
			title: "PR 201",
			provenance: prov,
		},
	]);
});

test("extract drops null/non-object array elements without throwing", async () => {
	const prov = { session: "s2", cwd: "/repo", ts: "2026-07-05T00:00:00Z" };
	const runClaude = async () =>
		JSON.stringify([
			null,
			42,
			{ text: "PR #7 merged", kind: "fact", confidence: 0.8 },
		]);
	const fetchImpl = async () => new Response("x", { status: 500 });
	const learnings = await extract("test/fixtures/session-basic.jsonl", prov, {
		fetchImpl: fetchImpl as unknown as typeof fetch,
		runClaude,
	});
	expect(learnings).toEqual([
		{ text: "PR #7 merged", kind: "fact", confidence: 0.8, provenance: prov },
	]);
});
