import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { isSecret, route } from "../src/policy.js";
import type { Learning } from "../src/types.js";

const prov = { session: "s", cwd: "/x", ts: "2026-07-05T00:00:00Z" };
const golden = JSON.parse(
	readFileSync("test/fixtures/golden-routing.json", "utf8"),
) as Array<{
	kind: Learning["kind"];
	confidence: number;
	text: string;
	expect: string[];
}>;

test.each(golden)(
	"route: $text",
	({ kind, confidence, text, expect: want }) => {
		const l: Learning = { text, kind, confidence, provenance: prov };
		expect(route(l).sort()).toEqual([...want].sort());
	},
);

test("isSecret flags token-shaped strings", () => {
	expect(isSecret("sk-abc123deadbeef")).toBe(true);
	expect(isSecret("PR #201 merged")).toBe(false);
	expect(
		isSecret("connected via postgresql://admin:hunter2@ep-foo.neon.tech/db"),
	).toBe(true);
	expect(isSecret("see https://example.com/docs")).toBe(false);
});

test("route sends a learning to moneta iff it is a routable fact or decision", () => {
	for (const { kind, confidence, text } of golden) {
		const l: Learning = { text, kind, confidence, provenance: prov };
		const targets = route(l);
		// moneta is the sole memory sink: exactly the facts/decisions that
		// survive the noise/confidence/secret gates land there.
		expect(targets.includes("moneta")).toBe(
			(kind === "fact" || kind === "decision") && targets.length > 0,
		);
	}
});

test("route drops a learning whose title is secret even if text is clean", () => {
	const l: Learning = {
		text: "rotated the database password",
		kind: "decision",
		confidence: 0.9,
		title: "HERMES_INTERNAL_KEY=sk-abc123deadbeef",
		provenance: prov,
	};
	expect(route(l)).toEqual([]);
});
