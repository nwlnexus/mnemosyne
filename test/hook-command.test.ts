import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { handleHook } from "../src/cli.js";

let home: string;
let mnemoHome: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hook-home-"));
	mnemoHome = mkdtempSync(join(tmpdir(), "hook-mnemo-"));
	process.env.MNEMOSYNE_HOME = mnemoHome;
});

const noDeps = {
	home: "",
	kickDrain: vi.fn(),
	recall: vi.fn(async () => null),
};

test("enqueue writes a queue entry from a claude payload", async () => {
	const out = await handleHook(
		"claude",
		"enqueue",
		JSON.stringify({
			session_id: "s1",
			transcript_path: "/t/x.jsonl",
			cwd: "/repo",
		}),
		{ ...noDeps, home },
	);
	const files = readdirSync(join(mnemoHome, "queue"));
	expect(files).toHaveLength(1);
	expect(files[0]).toMatch(/-s1\.json$/);
	const entry = JSON.parse(
		readFileSync(join(mnemoHome, "queue", files[0]), "utf8"),
	);
	expect(entry).toMatchObject({
		transcript: "/t/x.jsonl",
		session: "s1",
		cwd: "/repo",
		agent: "claude",
	});
	expect(typeof entry.ts).toBe("string");
	expect(out).toBe("");
});

test("enqueue without a transcript is a no-op (copilot-cli)", async () => {
	const out = await handleHook(
		"copilot-cli",
		"enqueue",
		JSON.stringify({ sessionId: "cp", cwd: "/repo" }),
		{ ...noDeps, home },
	);
	expect(readdirSync(mnemoHome)).not.toContain("queue");
	expect(out).toBe("");
});

test("cursor enqueue emits non-empty stdout (cursor rejects empty)", async () => {
	const out = await handleHook(
		"cursor",
		"enqueue",
		JSON.stringify({
			conversation_id: "c",
			transcript_path: "/t/c.jsonl",
			workspace_roots: ["/w"],
		}),
		{ ...noDeps, home },
	);
	expect(out).toBe("{}");
});

test("session-start kicks the drain and injects recall results", async () => {
	const kickDrain = vi.fn();
	const recall = vi.fn(async () => [
		{ content: "memory one" },
		{ content: "memory two" },
	]);
	const out = await handleHook(
		"claude",
		"session-start",
		JSON.stringify({ session_id: "s1", cwd: "/repos/olympus-sdk" }),
		{ home, kickDrain, recall },
	);
	expect(kickDrain).toHaveBeenCalledOnce();
	expect(recall).toHaveBeenCalledWith("olympus-sdk");
	const parsed = JSON.parse(out);
	const ctx = parsed.hookSpecificOutput.additionalContext;
	expect(ctx).toContain("Recalled 2 memories for olympus-sdk");
	expect(ctx).toContain("1. memory one");
});

test("session-start with no recall results stays silent (except cursor)", async () => {
	const out = await handleHook(
		"claude",
		"session-start",
		JSON.stringify({ session_id: "s1", cwd: "/repo" }),
		{ ...noDeps, home },
	);
	expect(out).toBe("");
	const cursorOut = await handleHook(
		"cursor",
		"session-start",
		JSON.stringify({ conversation_id: "c", workspace_roots: ["/repo"] }),
		{ ...noDeps, home },
	);
	expect(JSON.parse(cursorOut)).toEqual({ additional_context: "" });
});

test("handleHook fails open on junk stdin", async () => {
	const kickDrain = vi.fn();
	const out = await handleHook("claude", "session-start", "garbage{{", {
		...noDeps,
		home,
		kickDrain,
	});
	expect(kickDrain).toHaveBeenCalledOnce(); // drain still kicked
	expect(out).toBe("");
});
