import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { drainQueue } from "../src/cli.js";

const HEALTHY_TRANSCRIPT = resolve("test/fixtures/session-basic.jsonl");

function makeDirs() {
	return {
		queueDir: mkdtempSync(join(tmpdir(), "queue-")),
		deadDir: join(mkdtempSync(join(tmpdir(), "home-")), "dead"),
		inbox: mkdtempSync(join(tmpdir(), "inbox-")),
		ledgerDir: mkdtempSync(join(tmpdir(), "ledger-")),
	};
}

function writeEntry(dir: string, name: string, transcript: string): void {
	writeFileSync(
		join(dir, name),
		JSON.stringify({
			transcript,
			session: "s1",
			cwd: "/repo",
			ts: "2026-07-05T00:00:00Z",
		}),
	);
}

function factDeps(writeMem0: (json: string) => Promise<void>, extra = {}) {
	return {
		llm: {
			fetchImpl: (async () =>
				new Response("x", { status: 500 })) as unknown as typeof fetch,
			runClaude: async () =>
				JSON.stringify([
					{ text: "PR #201 merged", kind: "fact", confidence: 0.9 },
				]),
		},
		writeMem0,
		writeMoneta: vi.fn(async () => {}),
		...extra,
	};
}

test("missing transcript is moved to dead/ and removed from queue", async () => {
	const { queueDir, deadDir, inbox, ledgerDir } = makeDirs();
	writeEntry(queueDir, "dead-1.json", "/does/not/exist.jsonl");
	const writeMem0 = vi.fn(async () => {});
	const writeMoneta = vi.fn(async () => {});
	const deps = { writeMem0, writeMoneta, brainInboxDir: inbox, ledgerDir };

	const res = await drainQueue(queueDir, deadDir, deps);

	expect(res).toEqual({ drained: 0, dead: 1, retried: 0 });
	expect(readdirSync(queueDir)).toEqual([]);
	expect(readdirSync(deadDir)).toEqual(["dead-1.json"]);
	expect(writeMem0).not.toHaveBeenCalled();
});

test("transient failure leaves entry in queue and does not move it to dead/", async () => {
	const { queueDir, deadDir, inbox, ledgerDir } = makeDirs();
	writeEntry(queueDir, "transient-1.json", HEALTHY_TRANSCRIPT);
	const writeMem0 = vi.fn(async () => {
		throw new Error("mem0 unreachable");
	});
	const deps = factDeps(writeMem0, { brainInboxDir: inbox, ledgerDir });

	const res = await drainQueue(queueDir, deadDir, deps);

	expect(res).toEqual({ drained: 0, dead: 0, retried: 1 });
	expect(readdirSync(queueDir)).toEqual(["transient-1.json"]);
	expect(existsSync(deadDir)).toBe(false);
});

test("healthy entry is drained and removed from queue (regression)", async () => {
	const { queueDir, deadDir, inbox, ledgerDir } = makeDirs();
	writeEntry(queueDir, "healthy-1.json", HEALTHY_TRANSCRIPT);
	const writeMem0 = vi.fn(async () => {});
	const deps = factDeps(writeMem0, { brainInboxDir: inbox, ledgerDir });

	const res = await drainQueue(queueDir, deadDir, deps);

	expect(res).toEqual({ drained: 1, dead: 0, retried: 0 });
	expect(readdirSync(queueDir)).toEqual([]);
	expect(writeMem0).toHaveBeenCalledOnce();
	expect(existsSync(deadDir)).toBe(false);
});
