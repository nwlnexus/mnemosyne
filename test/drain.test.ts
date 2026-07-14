import * as fs from "node:fs";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import {
	acquireDrainLock,
	drainQueue,
	isEntryClaimedByConcurrentDrain,
	moveToDead,
} from "../src/cli.js";
import type { SessionCaptureResult } from "../src/monetaWriter.js";

// `statSync` is wrapped (not fully replaced) so every test still gets the
// real filesystem; only the one `acquireDrainLock` race test below overrides
// it for a single call via `mockImplementationOnce`.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

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

function factCaptureSession(extra?: Partial<SessionCaptureResult>) {
	return vi.fn(
		async (): Promise<SessionCaptureResult> => ({
			status: "captured",
			learnings: [
				{ text: "PR #201 merged", kind: "fact", confidence: 0.9, stored: true },
			],
			...extra,
		}),
	);
}

test("missing transcript is moved to dead/ and removed from queue", async () => {
	const { queueDir, deadDir, inbox, ledgerDir } = makeDirs();
	writeEntry(queueDir, "dead-1.json", "/does/not/exist.jsonl");
	const captureSession = vi.fn();
	const deps = { captureSession, brainInboxDir: inbox, ledgerDir };

	const res = await drainQueue(queueDir, deadDir, deps);

	expect(res).toEqual({ drained: 0, dead: 1, retried: 0 });
	expect(readdirSync(queueDir)).toEqual([]);
	expect(readdirSync(deadDir)).toEqual(["dead-1.json"]);
	expect(captureSession).not.toHaveBeenCalled();
});

test("transient failure (captureSession rejects) leaves entry in queue", async () => {
	const { queueDir, deadDir, inbox, ledgerDir } = makeDirs();
	writeEntry(queueDir, "transient-1.json", HEALTHY_TRANSCRIPT);
	const captureSession = vi.fn(async () => {
		throw new Error("moneta unreachable");
	});
	const deps = { captureSession, brainInboxDir: inbox, ledgerDir };

	const res = await drainQueue(queueDir, deadDir, deps);

	expect(res).toEqual({ drained: 0, dead: 0, retried: 1 });
	expect(readdirSync(queueDir)).toEqual(["transient-1.json"]);
	expect(existsSync(deadDir)).toBe(false);
});

test("a capture_failed learning leaves the entry queued (transient) and writes no brain doc", async () => {
	const { queueDir, deadDir, inbox, ledgerDir } = makeDirs();
	writeEntry(queueDir, "incomplete-1.json", HEALTHY_TRANSCRIPT);
	const captureSession = vi.fn(
		async (): Promise<SessionCaptureResult> => ({
			status: "captured",
			learnings: [
				{
					text: "chose D1 over Neon",
					kind: "decision",
					confidence: 0.9,
					stored: false,
					reason: "capture_failed",
				},
			],
		}),
	);
	const deps = { captureSession, brainInboxDir: inbox, ledgerDir };

	const res = await drainQueue(queueDir, deadDir, deps);

	expect(res).toEqual({ drained: 0, dead: 0, retried: 1 });
	expect(readdirSync(queueDir)).toEqual(["incomplete-1.json"]);
	expect(readdirSync(inbox).length).toBe(0);
});

test("healthy entry is drained and removed from queue (regression)", async () => {
	const { queueDir, deadDir, inbox, ledgerDir } = makeDirs();
	writeEntry(queueDir, "healthy-1.json", HEALTHY_TRANSCRIPT);
	const captureSession = factCaptureSession();
	const deps = { captureSession, brainInboxDir: inbox, ledgerDir };

	const res = await drainQueue(queueDir, deadDir, deps);

	expect(res).toEqual({ drained: 1, dead: 0, retried: 0 });
	expect(readdirSync(queueDir)).toEqual([]);
	expect(captureSession).toHaveBeenCalledOnce();
	expect(existsSync(deadDir)).toBe(false);
});

// --- bounded concurrency ---------------------------------------------------

test("MNEMOSYNE_DRAIN_CONCURRENCY=4: classification is unaffected by running entries concurrently", async () => {
	const { queueDir, deadDir, inbox, ledgerDir } = makeDirs();
	const healthyNames = [
		"healthy-1.json",
		"healthy-2.json",
		"healthy-3.json",
		"healthy-4.json",
	];
	for (const [i, name] of healthyNames.entries()) {
		writeFileSync(
			join(queueDir, name),
			JSON.stringify({
				transcript: HEALTHY_TRANSCRIPT,
				session: `s-healthy-${i}`,
				cwd: "/repo",
				ts: "2026-07-05T00:00:00Z",
			}),
		);
	}
	writeEntry(queueDir, "dead-1.json", "/does/not/exist.jsonl");
	writeFileSync(
		join(queueDir, "transient-1.json"),
		JSON.stringify({
			transcript: HEALTHY_TRANSCRIPT,
			session: "s-transient",
			cwd: "/repo",
			ts: "2026-07-05T00:00:00Z",
		}),
	);

	const captureSession = vi.fn(
		async ({ session }: { session: string }): Promise<SessionCaptureResult> => {
			if (session === "s-transient") throw new Error("moneta unreachable");
			return {
				status: "captured",
				learnings: [
					{
						text: `PR #201 merged (${session})`,
						kind: "fact",
						confidence: 0.9,
						stored: true,
					},
				],
			};
		},
	);
	const deps = { captureSession, brainInboxDir: inbox, ledgerDir };

	const prevConcurrency = process.env.MNEMOSYNE_DRAIN_CONCURRENCY;
	process.env.MNEMOSYNE_DRAIN_CONCURRENCY = "4";
	let res: Awaited<ReturnType<typeof drainQueue>>;
	try {
		res = await drainQueue(queueDir, deadDir, deps);
	} finally {
		if (prevConcurrency === undefined)
			delete process.env.MNEMOSYNE_DRAIN_CONCURRENCY;
		else process.env.MNEMOSYNE_DRAIN_CONCURRENCY = prevConcurrency;
	}

	// Don't assert on completion order — only the aggregate classification.
	expect(res).toEqual({ drained: 4, dead: 1, retried: 1 });
	expect(readdirSync(queueDir)).toEqual(["transient-1.json"]);
	expect(readdirSync(deadDir)).toEqual(["dead-1.json"]);
	expect(captureSession).toHaveBeenCalledTimes(5);
});

// --- concurrent-drain race tolerance -------------------------------------

test("moveToDead: source already gone (claimed by a concurrent drain) returns false and does not throw", () => {
	const { queueDir, deadDir } = makeDirs();
	const missing = join(queueDir, "already-gone.json");

	expect(() => moveToDead(missing, deadDir, "already-gone.json")).not.toThrow();
	expect(moveToDead(missing, deadDir, "already-gone.json")).toBe(false);
	expect(readdirSync(deadDir)).toEqual([]);
});

test("moveToDead: normal case still moves the file and returns true", () => {
	const { queueDir, deadDir } = makeDirs();
	writeEntry(queueDir, "dead-1.json", "/does/not/exist.jsonl");
	const p = join(queueDir, "dead-1.json");

	expect(moveToDead(p, deadDir, "dead-1.json")).toBe(true);
	expect(readdirSync(deadDir)).toEqual(["dead-1.json"]);
});

test("success path: rm tolerates the entry already being removed by a concurrent drain", async () => {
	const { queueDir, deadDir, inbox, ledgerDir } = makeDirs();
	writeEntry(queueDir, "healthy-1.json", HEALTHY_TRANSCRIPT);
	const p = join(queueDir, "healthy-1.json");
	// Simulate another drain claiming (and removing) this entry while this
	// drain's captureSession call is in flight.
	const captureSession = vi.fn(async (): Promise<SessionCaptureResult> => {
		rmSync(p, { force: true });
		return { status: "captured", learnings: [] };
	});
	const deps = { captureSession, brainInboxDir: inbox, ledgerDir };

	const res = await drainQueue(queueDir, deadDir, deps);

	expect(res).toEqual({ drained: 1, dead: 0, retried: 0 });
	expect(existsSync(deadDir)).toBe(false);
});

test("isEntryClaimedByConcurrentDrain: true only for an ENOENT on the entry path itself", () => {
	const entryPath = "/home/.claude/mnemosyne/queue/x.json";
	const enoentOnEntry = Object.assign(new Error("ENOENT"), {
		code: "ENOENT",
		path: entryPath,
	});
	const enoentElsewhere = Object.assign(new Error("ENOENT"), {
		code: "ENOENT",
		path: "/tmp/some-transcript.jsonl",
	});
	const otherError = new Error("moneta unreachable");

	expect(isEntryClaimedByConcurrentDrain(enoentOnEntry, entryPath)).toBe(true);
	expect(isEntryClaimedByConcurrentDrain(enoentElsewhere, entryPath)).toBe(
		false,
	);
	expect(isEntryClaimedByConcurrentDrain(otherError, entryPath)).toBe(false);
});

test("missing transcript is still moved to dead/ (PermanentDrainError regression, unaffected by race tolerance)", async () => {
	const { queueDir, deadDir, inbox, ledgerDir } = makeDirs();
	writeEntry(queueDir, "dead-1.json", "/does/not/exist.jsonl");
	const captureSession = vi.fn();
	const deps = { captureSession, brainInboxDir: inbox, ledgerDir };

	const res = await drainQueue(queueDir, deadDir, deps);

	expect(res).toEqual({ drained: 0, dead: 1, retried: 0 });
	expect(readdirSync(deadDir)).toEqual(["dead-1.json"]);
});

// --- drain lock -----------------------------------------------------------

test("acquireDrainLock: acquires when no lock exists", () => {
	const home = mkdtempSync(join(tmpdir(), "home-"));

	expect(acquireDrainLock(home)).toBe(true);
	expect(existsSync(join(home, "drain.lock"))).toBe(true);
	expect(readdirSync(join(home, "drain.lock")).includes("pid")).toBe(true);
});

test("acquireDrainLock: refuses when a fresh lock is already held", () => {
	const home = mkdtempSync(join(tmpdir(), "home-"));
	expect(acquireDrainLock(home)).toBe(true);

	expect(acquireDrainLock(home)).toBe(false);
});

test("acquireDrainLock: takes over a stale (> 10 min old) lock", () => {
	const home = mkdtempSync(join(tmpdir(), "home-"));
	expect(acquireDrainLock(home)).toBe(true);
	const lockDir = join(home, "drain.lock");
	const old = new Date(Date.now() - 11 * 60 * 1000);
	utimesSync(lockDir, old, old);

	expect(acquireDrainLock(home)).toBe(true);
});

test("acquireDrainLock: tolerates the lock vanishing between the failed take() and the stale-check stat", () => {
	const home = mkdtempSync(join(tmpdir(), "home-"));
	expect(acquireDrainLock(home)).toBe(true);
	const lockDir = join(home, "drain.lock");

	// Simulate the other drain releasing its lock in the window between our
	// failed mkdirSync (EEXIST) and our statSync call: statSync throws ENOENT
	// even though the directory is (about to be) gone for real, so remove it
	// for real too — the subsequent take() retry inside acquireDrainLock must
	// then succeed rather than the whole call throwing.
	vi.mocked(fs.statSync).mockImplementationOnce(() => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	});
	rmSync(lockDir, { recursive: true, force: true });

	expect(acquireDrainLock(home)).toBe(true);
});
