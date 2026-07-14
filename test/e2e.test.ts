import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { drainOnce } from "../src/cli.js";

test("drainOnce dispatches once and is a no-op on re-run (idempotent)", async () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const ledgerDir = mkdtempSync(join(tmpdir(), "ledger-"));
	const writeMoneta = vi.fn(async () => {});
	const runClaude = async () =>
		JSON.stringify([{ text: "PR #201 merged", kind: "fact", confidence: 0.9 }]);
	const deps = {
		llm: {
			fetchImpl: (async () =>
				new Response("x", { status: 500 })) as unknown as typeof fetch,
			runClaude,
		},
		writeMoneta,
		brainInboxDir: inbox,
		ledgerDir,
	};
	const first = await drainOnce("test/fixtures/queue-entry.json", deps);
	expect(first.written).toContain("moneta");
	expect(writeMoneta).toHaveBeenCalledOnce();

	const second = await drainOnce("test/fixtures/queue-entry.json", deps);
	expect(second.written).toEqual([]);
	expect(second.skipped).toBe(1);
	expect(writeMoneta).toHaveBeenCalledOnce(); // still once
	expect(readdirSync(inbox).length).toBe(0); // fact -> moneta only, no inbox file
});
