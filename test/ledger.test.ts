import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { hashLearning, Ledger } from "../src/ledger.js";

const prov = { session: "s", cwd: "/x", ts: "t" };

test("hashLearning is stable across whitespace differences", () => {
	const a = hashLearning({
		text: "PR  #201  merged",
		kind: "fact",
		confidence: 1,
		provenance: prov,
	});
	const b = hashLearning({
		text: "PR #201 merged",
		kind: "fact",
		confidence: 1,
		provenance: prov,
	});
	expect(a).toBe(b);
});

test("Ledger persists seen hashes", () => {
	const dir = mkdtempSync(join(tmpdir(), "mnemo-"));
	const led = new Ledger(dir);
	expect(led.has("abc")).toBe(false);
	led.add("abc");
	expect(new Ledger(dir).has("abc")).toBe(true);
});
