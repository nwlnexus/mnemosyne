import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import {
	AGENTS,
	detectAgents,
	installHooksForAgent,
	normalizePayload,
	renderInjection,
} from "../src/agents.js";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "agents-home-"));
});

// --- detection --------------------------------------------------------------

test("detectAgents finds only agents whose markers exist", () => {
	mkdirSync(join(home, ".claude"), { recursive: true });
	mkdirSync(join(home, ".gemini"), { recursive: true });
	// codex dir alone is NOT enough (vestigial installs leave an empty dir)
	mkdirSync(join(home, ".codex"), { recursive: true });
	const found = detectAgents({ home, binaryExists: (b) => b === "gemini" });
	expect(found).toContain("claude");
	expect(found).toContain("gemini");
	expect(found).not.toContain("codex");
	expect(found).not.toContain("cursor");
});

test("detectAgents accepts codex when config.toml exists even without binary", () => {
	mkdirSync(join(home, ".codex"), { recursive: true });
	writeFileSync(join(home, ".codex", "config.toml"), 'model = "o4"\n');
	const found = detectAgents({ home, binaryExists: () => false });
	expect(found).toContain("codex");
});

// --- payload normalization ---------------------------------------------------

test("normalizePayload: claude payload carries transcript, session, cwd", () => {
	const n = normalizePayload(
		"claude",
		JSON.stringify({
			session_id: "s1",
			transcript_path: "/t/x.jsonl",
			cwd: "/repo",
		}),
		{ home },
	);
	expect(n).toEqual({ session: "s1", cwd: "/repo", transcript: "/t/x.jsonl" });
});

test("normalizePayload: cursor stop payload uses conversation_id and workspace root", () => {
	const n = normalizePayload(
		"cursor",
		JSON.stringify({
			conversation_id: "c-9",
			transcript_path: "/t/c.jsonl",
			workspace_roots: ["/ws"],
			status: "completed",
		}),
		{ home },
	);
	expect(n).toEqual({ session: "c-9", cwd: "/ws", transcript: "/t/c.jsonl" });
});

test("normalizePayload: codex discovers the rollout by session-id suffix walk", () => {
	const day = join(home, ".codex", "sessions", "2026", "07", "14");
	mkdirSync(day, { recursive: true });
	const rollout = join(day, "rollout-2026-07-14T01-02-03-sess-42.jsonl");
	writeFileSync(rollout, "{}");
	const n = normalizePayload(
		"codex",
		JSON.stringify({ session_id: "sess-42", cwd: "/repo" }),
		{ home },
	);
	expect(n.transcript).toBe(rollout);
	expect(n.session).toBe("sess-42");
});

test("normalizePayload: gemini finds the newest chat under the project-hash dir", () => {
	const { createHash } = require("node:crypto");
	const hash = createHash("sha256").update("/repo").digest("hex");
	const chats = join(home, ".gemini", "tmp", hash, "chats");
	mkdirSync(chats, { recursive: true });
	writeFileSync(join(chats, "session-2026-07-13T09-00-aa.json"), "{}");
	const newest = join(chats, "session-2026-07-14T01-00-bb.json");
	writeFileSync(newest, "{}");
	const n = normalizePayload(
		"gemini",
		JSON.stringify({ session_id: "g1", cwd: "/repo" }),
		{ home },
	);
	expect(n.transcript).toBe(newest);
});

test("normalizePayload: copilot-cli has no transcript surface", () => {
	const n = normalizePayload(
		"copilot-cli",
		JSON.stringify({ sessionId: "cp1", cwd: "/repo" }),
		{ home },
	);
	expect(n).toEqual({ session: "cp1", cwd: "/repo", transcript: null });
});

test("normalizePayload survives junk stdin (fail-open)", () => {
	const n = normalizePayload("claude", "not json", { home });
	expect(n.transcript).toBeNull();
	expect(typeof n.session).toBe("string");
});

// --- injection formats --------------------------------------------------------

test("renderInjection emits each agent's expected shape", () => {
	expect(JSON.parse(renderInjection("claude", "ctx"))).toEqual({
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: "ctx",
		},
	});
	expect(JSON.parse(renderInjection("codex", "ctx"))).toEqual({
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: "ctx",
		},
	});
	expect(JSON.parse(renderInjection("cursor", "ctx"))).toEqual({
		additional_context: "ctx",
	});
	expect(JSON.parse(renderInjection("copilot-cli", "ctx"))).toEqual({
		additionalContext: "ctx",
	});
	expect(JSON.parse(renderInjection("gemini", "ctx"))).toEqual({
		hookSpecificOutput: { additionalContext: "ctx" },
	});
	// cursor rejects empty stdout — the empty injection must still carry the key
	expect(JSON.parse(renderInjection("cursor", ""))).toEqual({
		additional_context: "",
	});
});

// --- install / merge -----------------------------------------------------------

test("installHooksForAgent writes claude-nested entries and is idempotent", () => {
	const settings = join(home, ".claude", "settings.json");
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(
		settings,
		JSON.stringify({
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "other-tool" }] }],
			},
		}),
	);
	const r1 = installHooksForAgent("claude", { home });
	expect(r1.changed).toBe(true);
	const cfg = JSON.parse(readFileSync(settings, "utf8"));
	expect(JSON.stringify(cfg)).toContain("mnemosyne hook claude session-start");
	expect(JSON.stringify(cfg)).toContain("mnemosyne hook claude enqueue");
	// pre-existing entry preserved
	expect(JSON.stringify(cfg)).toContain("other-tool");
	// second run: no duplicates
	const r2 = installHooksForAgent("claude", { home });
	expect(r2.changed).toBe(false);
	const cfg2 = JSON.parse(readFileSync(settings, "utf8"));
	expect(
		JSON.stringify(cfg2).split("mnemosyne hook claude session-start").length,
	).toBe(2);
});

test("installHooksForAgent respects legacy shell-script wiring as already-installed", () => {
	const settings = join(home, ".claude", "settings.json");
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(
		settings,
		JSON.stringify({
			hooks: {
				SessionStart: [
					{ hooks: [{ type: "command", command: "/x/mnemosyne-drain.sh" }] },
				],
				SessionEnd: [
					{ hooks: [{ type: "command", command: "/x/mnemosyne-enqueue.sh" }] },
				],
				PreCompact: [
					{ hooks: [{ type: "command", command: "/x/mnemosyne-enqueue.sh" }] },
				],
			},
		}),
	);
	const r = installHooksForAgent("claude", { home });
	expect(r.changed).toBe(false);
});

test("installHooksForAgent writes cursor flat schema", () => {
	mkdirSync(join(home, ".cursor"), { recursive: true });
	installHooksForAgent("cursor", { home });
	const cfg = JSON.parse(
		readFileSync(join(home, ".cursor", "hooks.json"), "utf8"),
	);
	expect(cfg.version).toBe(1);
	expect(cfg.hooks.sessionStart[0].command).toBe(
		"mnemosyne hook cursor session-start",
	);
	expect(cfg.hooks.stop[0].command).toBe("mnemosyne hook cursor enqueue");
	// flat schema: no nested hooks array, no type field
	expect(cfg.hooks.sessionStart[0].hooks).toBeUndefined();
	expect(cfg.hooks.sessionStart[0].type).toBeUndefined();
});

test("installHooksForAgent owns its whole file for copilot-cli", () => {
	mkdirSync(join(home, ".copilot"), { recursive: true });
	installHooksForAgent("copilot-cli", { home });
	const cfg = JSON.parse(
		readFileSync(join(home, ".copilot", "hooks", "mnemosyne.json"), "utf8"),
	);
	expect(cfg.hooks.sessionStart[0].command).toBe(
		"mnemosyne hook copilot-cli session-start",
	);
	// no enqueue event: copilot exposes no transcript surface
	expect(cfg.hooks.agentStop).toBeUndefined();
});

test("installHooksForAgent flags codex config.toml hooks feature", () => {
	mkdirSync(join(home, ".codex"), { recursive: true });
	writeFileSync(join(home, ".codex", "config.toml"), 'model = "o4"\n');
	const r = installHooksForAgent("codex", { home });
	const cfg = JSON.parse(
		readFileSync(join(home, ".codex", "hooks.json"), "utf8"),
	);
	expect(JSON.stringify(cfg)).toContain("mnemosyne hook codex session-start");
	// feature flag appended to a config.toml without a [features] section
	expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
		"hooks = true",
	);
	expect(r.notes.join(" ")).toContain("features");
});

test("AGENTS spec covers exactly the supported set", () => {
	expect(Object.keys(AGENTS).sort()).toEqual([
		"claude",
		"codex",
		"copilot-cli",
		"cursor",
		"gemini",
	]);
});
