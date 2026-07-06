import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { drainOnce } from "../src/cli.js";

test("drainOnce dispatches once and is a no-op on re-run (idempotent)", async () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const ledgerDir = mkdtempSync(join(tmpdir(), "ledger-"));
	const writeMem0 = vi.fn(async () => {});
	const runClaude = async () =>
		JSON.stringify([{ text: "PR #201 merged", kind: "fact", confidence: 0.9 }]);
	const deps = {
		llm: {
			fetchImpl: (async () =>
				new Response("x", { status: 500 })) as unknown as typeof fetch,
			runClaude,
		},
		writeMem0,
		brainInboxDir: inbox,
		ledgerDir,
	};
	const first = await drainOnce("test/fixtures/queue-entry.json", deps);
	expect(first.written).toContain("mem0");
	expect(writeMem0).toHaveBeenCalledOnce();

	const second = await drainOnce("test/fixtures/queue-entry.json", deps);
	expect(second.written).toEqual([]);
	expect(second.skipped).toBe(1);
	expect(writeMem0).toHaveBeenCalledOnce(); // still once
	expect(readdirSync(inbox).length).toBe(0); // fact -> mem0 only, no inbox file
});
