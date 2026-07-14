import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Agent-agnostic hook layer. mnemosyne detects which AI coding agents are
// installed and inserts its lifecycle hooks into each one's config — the
// gitnexus/context-mode pattern. Every installed hook invokes the SAME
// entrypoint (`mnemosyne hook <agent> <event>`), and this module normalizes
// each agent's payload into { session, cwd, transcript }.
//
// Per-agent reality (researched from context-mode adapters + gitnexus
// editor-targets + local installs, 2026-07):
//   claude       transcript_path on stdin; SessionStart/SessionEnd/PreCompact
//   codex        no transcript on stdin — rollout discovered by walking
//                ~/.codex/sessions/**/rollout-*-<session_id>.jsonl; needs
//                `[features] hooks = true` in config.toml
//   cursor       transcript_path on the `stop` payload; flat hooks.json
//   copilot-cli  NO transcript surface — session-start (drain+recall) only;
//                per-tool file ~/.copilot/hooks/mnemosyne.json
//   gemini       no transcript on stdin — newest chat under
//                ~/.gemini/tmp/<sha256(cwd)>/chats/; hooks live in
//                ~/.gemini/settings.json (shared with Antigravity IDE)

export type AgentId = "claude" | "codex" | "cursor" | "copilot-cli" | "gemini";

export type AgentIo = {
	home: string;
	binaryExists?: (name: string) => boolean;
};

export type NormalizedPayload = {
	session: string;
	cwd: string;
	transcript: string | null;
};

type ConfigStyle = "claude-nested" | "cursor-flat" | "own-file";

type AgentSpec = {
	/** relative dir whose presence suggests the agent (joined to home) */
	markerDir: string;
	/** binary that confirms the install (markerDir alone can be vestigial) */
	binary: string | null;
	/** file (relative to home) that ALSO confirms install without the binary */
	markerFile: string | null;
	/** hook config file, relative to home */
	configFile: string;
	configStyle: ConfigStyle;
	/** event name → mnemosyne hook event */
	events: Record<string, "session-start" | "enqueue">;
};

export const AGENTS: Record<AgentId, AgentSpec> = {
	claude: {
		markerDir: ".claude",
		binary: null, // the dir is created by the CLI itself; presence suffices
		markerFile: null,
		configFile: join(".claude", "settings.json"),
		configStyle: "claude-nested",
		events: {
			SessionStart: "session-start",
			SessionEnd: "enqueue",
			PreCompact: "enqueue",
		},
	},
	codex: {
		markerDir: ".codex",
		binary: "codex",
		markerFile: join(".codex", "config.toml"),
		configFile: join(".codex", "hooks.json"),
		configStyle: "claude-nested",
		events: {
			SessionStart: "session-start",
			// Stop fires per assistant turn, not process exit — enqueue is
			// idempotent (content-hashed queue entries; drain dedupes), so
			// turn-level firing is safe.
			Stop: "enqueue",
			PreCompact: "enqueue",
		},
	},
	cursor: {
		markerDir: ".cursor",
		binary: null,
		markerFile: null,
		configFile: join(".cursor", "hooks.json"),
		configStyle: "cursor-flat",
		events: {
			sessionStart: "session-start",
			stop: "enqueue",
		},
	},
	"copilot-cli": {
		markerDir: ".copilot",
		binary: null,
		markerFile: null,
		configFile: join(".copilot", "hooks", "mnemosyne.json"),
		configStyle: "own-file",
		// copilot exposes no transcript surface — drain + recall only.
		events: {
			sessionStart: "session-start",
		},
	},
	gemini: {
		markerDir: ".gemini",
		binary: "gemini",
		markerFile: join(".gemini", "settings.json"),
		configFile: join(".gemini", "settings.json"),
		configStyle: "claude-nested",
		events: {
			SessionStart: "session-start",
			// Gemini has no session-end/stop event; PreCompress is the nearest
			// "about to lose context" signal.
			PreCompress: "enqueue",
		},
	},
};

/** Any hook command containing one of these belongs to mnemosyne already —
 * covers both this CLI's entries and the legacy nix-managed shell scripts. */
const NEEDLES = [
	"mnemosyne hook",
	"mnemosyne-drain.sh",
	"mnemosyne-enqueue.sh",
];

function defaultBinaryExists(name: string): boolean {
	const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	return paths.some((p) => existsSync(join(p, name)));
}

export function detectAgents(io: AgentIo): AgentId[] {
	const binaryExists = io.binaryExists ?? defaultBinaryExists;
	const found: AgentId[] = [];
	for (const [id, spec] of Object.entries(AGENTS) as [AgentId, AgentSpec][]) {
		if (!existsSync(join(io.home, spec.markerDir))) continue;
		const confirmed =
			(spec.binary === null && spec.markerFile === null) ||
			(spec.binary !== null && binaryExists(spec.binary)) ||
			(spec.markerFile !== null && existsSync(join(io.home, spec.markerFile)));
		if (confirmed) found.push(id);
	}
	return found;
}

// ─── payload normalization ──────────────────────────────────────────────────

function str(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v : null;
}

/** codex: walk $CODEX_HOME/sessions for rollout-*-<sessionId>.jsonl */
function findCodexRollout(home: string, sessionId: string): string | null {
	const root = join(home, ".codex", "sessions");
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop() as string;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const n of names) {
			const p = join(dir, n);
			let isDir = false;
			try {
				isDir = statSync(p).isDirectory();
			} catch {
				continue;
			}
			if (isDir) stack.push(p);
			else if (n.startsWith("rollout-") && n.endsWith(`-${sessionId}.jsonl`))
				return p;
		}
	}
	return null;
}

/** gemini: newest session-*.json under ~/.gemini/tmp/<sha256(cwd)>/chats */
function findGeminiChat(home: string, cwd: string): string | null {
	const hash = createHash("sha256").update(cwd).digest("hex");
	const dir = join(home, ".gemini", "tmp", hash, "chats");
	let names: string[];
	try {
		names = readdirSync(dir).filter(
			(n) => n.startsWith("session-") && n.endsWith(".json"),
		);
	} catch {
		return null;
	}
	if (!names.length) return null;
	let newest: { p: string; m: number } | null = null;
	for (const n of names) {
		const p = join(dir, n);
		let m = 0;
		try {
			m = statSync(p).mtimeMs;
		} catch {
			continue;
		}
		if (!newest || m > newest.m) newest = { p, m };
	}
	return newest?.p ?? null;
}

export function normalizePayload(
	agent: AgentId,
	stdin: string,
	io: AgentIo,
): NormalizedPayload {
	let p: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(stdin);
		if (parsed && typeof parsed === "object") p = parsed;
	} catch {
		// fail-open: junk stdin still yields a usable (transcript-less) payload
	}
	const session =
		str(p.session_id) ??
		str(p.sessionId) ??
		str(p.conversation_id) ??
		str(p.conversationId) ??
		`pid-${process.ppid}`;
	const cwd =
		str(p.cwd) ??
		(Array.isArray(p.workspace_roots) ? str(p.workspace_roots[0]) : null) ??
		process.cwd();

	let transcript: string | null =
		str(p.transcript_path) ?? str(p.transcriptPath);
	if (!transcript && agent === "codex")
		transcript = findCodexRollout(io.home, session);
	if (!transcript && agent === "gemini")
		transcript = findGeminiChat(io.home, cwd);
	if (agent === "copilot-cli") transcript = null;

	return { session, cwd, transcript };
}

// ─── injection formats ───────────────────────────────────────────────────────

/** Render the agent-specific stdout that injects `text` at session start.
 * Cursor rejects empty stdout, so even text="" emits the key. */
export function renderInjection(agent: AgentId, text: string): string {
	switch (agent) {
		case "cursor":
			return JSON.stringify({ additional_context: text });
		case "copilot-cli":
			return JSON.stringify({ additionalContext: text });
		case "gemini":
			return JSON.stringify({
				hookSpecificOutput: { additionalContext: text },
			});
		default:
			// claude + codex — codex REQUIRES hookEventName
			return JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: text,
				},
			});
	}
}

// ─── install / merge ─────────────────────────────────────────────────────────

export type InstallResult = {
	agent: AgentId;
	changed: boolean;
	notes: string[];
};

function hookCommand(
	agent: AgentId,
	event: "session-start" | "enqueue",
): string {
	return `mnemosyne hook ${agent} ${event}`;
}

function hasNeedle(json: string): boolean {
	return NEEDLES.some((n) => json.includes(n));
}

function readJson(path: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** Append `[features]\nhooks = true` to codex's config.toml when safe; note a
 * manual step when a [features] section already exists (naive TOML edits into
 * an existing table risk corrupting it). */
function ensureCodexHooksFeature(home: string, notes: string[]): void {
	const toml = join(home, ".codex", "config.toml");
	let raw = "";
	try {
		raw = readFileSync(toml, "utf8");
	} catch {
		// no config.toml — create one holding just the feature flag
	}
	if (/^\s*hooks\s*=\s*true/m.test(raw)) return;
	if (raw.includes("[features]")) {
		notes.push(
			"codex: add `hooks = true` under the existing [features] section of ~/.codex/config.toml manually",
		);
		return;
	}
	writeFileSync(
		toml,
		`${raw}${raw.endsWith("\n") || !raw ? "" : "\n"}\n[features]\nhooks = true\n`,
	);
	notes.push("codex: enabled [features] hooks = true in config.toml");
}

export function installHooksForAgent(
	agent: AgentId,
	io: AgentIo,
	dryRun = false,
): InstallResult {
	const spec = AGENTS[agent];
	const cfgPath = join(io.home, spec.configFile);
	const notes: string[] = [];
	const cfg = readJson(cfgPath);
	const before = JSON.stringify(cfg);
	if (hasNeedle(before)) return { agent, changed: false, notes };

	if (cfg.hooks === undefined) cfg.hooks = {};
	const hooks = cfg.hooks as Record<string, unknown[]>;
	for (const [event, kind] of Object.entries(spec.events)) {
		if (hooks[event] === undefined) hooks[event] = [];
		const entries = hooks[event];
		const cmd = hookCommand(agent, kind);
		if (spec.configStyle === "claude-nested") {
			entries.push({ hooks: [{ type: "command", command: cmd, timeout: 20 }] });
		} else if (spec.configStyle === "cursor-flat") {
			entries.push({ command: cmd });
		} else {
			entries.push({ type: "command", command: cmd });
		}
	}
	if (spec.configStyle !== "claude-nested" && cfg.version === undefined)
		cfg.version = 1;

	if (!dryRun) {
		mkdirSync(join(cfgPath, ".."), { recursive: true });
		writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
		if (agent === "codex") ensureCodexHooksFeature(io.home, notes);
	}
	return { agent, changed: true, notes };
}

export function installHooks(
	io?: Partial<AgentIo>,
	dryRun = false,
): InstallResult[] {
	const resolved: AgentIo = {
		home: io?.home ?? homedir(),
		binaryExists: io?.binaryExists,
	};
	return detectAgents(resolved).map((a) =>
		installHooksForAgent(a, resolved, dryRun),
	);
}
