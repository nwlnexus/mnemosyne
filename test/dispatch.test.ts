import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { dispatch } from "../src/dispatch.js";
import type { Learning } from "../src/types.js";

const prov = { session: "s1", cwd: "/repo", ts: "2026-07-05T00:00:00Z" };

test("dispatch writes mem0 payload and brain inbox file for a decision", async () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const writeMem0 = vi.fn(async () => {});
	const l: Learning = {
		text: "chose D1 over Neon for cost",
		kind: "decision",
		confidence: 0.9,
		title: "D1 vs Neon",
		provenance: prov,
	};
	const targets = await dispatch(l, { writeMem0, brainInboxDir: inbox });
	expect(targets.sort()).toEqual(["brain", "mem0"]);
	expect(writeMem0).toHaveBeenCalledOnce();
	expect(JSON.parse(writeMem0.mock.calls[0][0]).text).toBe(
		"chose D1 over Neon for cost",
	);
	const file = join(inbox, "d1-vs-neon.md");
	expect(existsSync(file)).toBe(true);
	const body = readFileSync(file, "utf8");
	expect(body).toContain("status: new");
	expect(body).toContain("session: s1");
});
