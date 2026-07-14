import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { drainOnce } from "../src/cli.js";
import type { SessionCaptureResult } from "../src/monetaWriter.js";

function makeDeps(captureSession: ReturnType<typeof vi.fn>) {
	return {
		captureSession,
		brainInboxDir: mkdtempSync(join(tmpdir(), "inbox-")),
		ledgerDir: mkdtempSync(join(tmpdir(), "ledger-")),
	};
}

test("drainOnce routes decision + lesson learnings to the brain inbox, facts stay moneta-only", async () => {
	const captureSession = vi.fn(
		async (): Promise<SessionCaptureResult> => ({
			status: "captured",
			learnings: [
				{ text: "PR #201 merged", kind: "fact", confidence: 0.9, stored: true },
				{
					text: "chose D1 over Neon for cost",
					kind: "decision",
					confidence: 0.9,
					title: "D1 vs Neon",
					stored: true,
				},
				{
					text: "D1 timestamps must be integers",
					kind: "lesson",
					confidence: 0.8,
					stored: true,
				},
			],
		}),
	);
	const deps = makeDeps(captureSession);

	const res = await drainOnce("test/fixtures/queue-entry.json", deps);

	expect(res.written).toEqual(["brain", "brain"]);
	expect(res.skipped).toBe(0);
	const files = readdirSync(deps.brainInboxDir);
	expect(files).toHaveLength(2);
	expect(captureSession).toHaveBeenCalledOnce();
	const [payload] = captureSession.mock.calls[0];
	expect(payload.session).toBe("s1");
	expect(payload.cwd).toBe("/repo");
	expect(payload.source).toBe("mnemosyne");
	expect(Array.isArray(payload.turns)).toBe(true);
});

test("re-draining the same response is idempotent (ledger dedup)", async () => {
	const response: SessionCaptureResult = {
		status: "captured",
		learnings: [
			{
				text: "chose D1 over Neon for cost",
				kind: "decision",
				confidence: 0.9,
				title: "D1 vs Neon",
				stored: true,
			},
		],
	};
	const captureSession = vi.fn(async () => response);
	const deps = makeDeps(captureSession);

	const first = await drainOnce("test/fixtures/queue-entry.json", deps);
	expect(first.written).toEqual(["brain"]);
	expect(first.skipped).toBe(0);
	expect(readdirSync(deps.brainInboxDir)).toHaveLength(1);

	const second = await drainOnce("test/fixtures/queue-entry.json", deps);
	expect(second.written).toEqual([]);
	expect(second.skipped).toBe(1);
	expect(readdirSync(deps.brainInboxDir)).toHaveLength(1); // still just one file
});

test("a fact-only response writes no brain file", async () => {
	const captureSession = vi.fn(
		async (): Promise<SessionCaptureResult> => ({
			status: "captured",
			learnings: [
				{ text: "PR #201 merged", kind: "fact", confidence: 0.9, stored: true },
			],
		}),
	);
	const deps = makeDeps(captureSession);

	const res = await drainOnce("test/fixtures/queue-entry.json", deps);

	expect(res.written).toEqual([]);
	expect(readdirSync(deps.brainInboxDir)).toHaveLength(0);
});

test("below_min_confidence and secret_detected reasons are dropped even for decision/lesson kinds", async () => {
	const captureSession = vi.fn(
		async (): Promise<SessionCaptureResult> => ({
			status: "captured",
			learnings: [
				{
					text: "maybe rotate keys?",
					kind: "decision",
					confidence: 0.3,
					stored: false,
					reason: "below_min_confidence",
				},
				{
					text: "HERMES_INTERNAL_KEY=sk-abc123deadbeef",
					kind: "lesson",
					confidence: 0.9,
					stored: false,
					reason: "secret_detected",
				},
			],
		}),
	);
	const deps = makeDeps(captureSession);

	const res = await drainOnce("test/fixtures/queue-entry.json", deps);

	expect(res.written).toEqual([]);
	expect(readdirSync(deps.brainInboxDir)).toHaveLength(0);
});

test("an empty transcript captures nothing and never calls captureSession", async () => {
	const inbox = mkdtempSync(join(tmpdir(), "inbox-"));
	const ledgerDir = mkdtempSync(join(tmpdir(), "ledger-"));
	const emptyEntryDir = mkdtempSync(join(tmpdir(), "queue-"));
	const emptyTranscript = join(emptyEntryDir, "empty.jsonl");
	writeFileSync(emptyTranscript, "");
	const entryPath = join(emptyEntryDir, "entry.json");
	writeFileSync(
		entryPath,
		JSON.stringify({
			transcript: emptyTranscript,
			session: "s1",
			cwd: "/repo",
			ts: "2026-07-05T00:00:00Z",
		}),
	);
	const captureSession = vi.fn();

	const res = await drainOnce(entryPath, {
		captureSession,
		brainInboxDir: inbox,
		ledgerDir,
	});

	expect(res).toEqual({ written: [], skipped: 0 });
	expect(captureSession).not.toHaveBeenCalled();
	expect(readdirSync(inbox)).toHaveLength(0);
});

test("readFileSync brain doc content includes provenance", async () => {
	const captureSession = vi.fn(
		async (): Promise<SessionCaptureResult> => ({
			status: "captured",
			learnings: [
				{
					text: "chose D1 over Neon for cost",
					kind: "decision",
					confidence: 0.9,
					title: "D1 vs Neon",
					stored: true,
				},
			],
		}),
	);
	const deps = makeDeps(captureSession);

	await drainOnce("test/fixtures/queue-entry.json", deps);

	const [file] = readdirSync(deps.brainInboxDir);
	const body = readFileSync(join(deps.brainInboxDir, file), "utf8");
	expect(body).toContain('session: "s1"');
	expect(body).toContain("chose D1 over Neon for cost");
});
