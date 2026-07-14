#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { mnemosyneHome } from "./config.js";
import { writeBrainDoc } from "./dispatch.js";
import { PermanentDrainError } from "./errors.js";
import { hashLearning, Ledger } from "./ledger.js";
import type {
	CaptureSessionPayload,
	SessionCaptureResult,
} from "./monetaWriter.js";
import { parseTranscript } from "./transcript.js";
import type { Learning } from "./types.js";

export type DrainDeps = {
	captureSession: (
		payload: CaptureSessionPayload,
	) => Promise<SessionCaptureResult>;
	brainInboxDir: string;
	ledgerDir: string;
	// Where per-entry failure breadcrumbs go. Defaults to stderr; `main` routes
	// them to the drain log file instead so a manual `mnemosyne drain` prints
	// only the one summary line to the terminal (not thousands of breadcrumbs).
	log?: (msg: string) => void;
};

type QueueEntry = {
	transcript: string;
	session: string;
	cwd: string;
	ts: string;
	agent?: string;
};

/**
 * Drain one queue entry via moneta's /capture-session endpoint, which does
 * ALL extraction/embedding server-side. mnemosyne's job here is just to:
 *   1. read the transcript and hand its turns to moneta;
 *   2. route the decision/lesson learnings moneta returns to the local
 *      second-brain inbox (moneta already stored what it wants to moneta).
 * `written` lists a "brain" entry per new inbox doc written; `skipped`
 * counts learnings that were already in the local dedup ledger.
 */
export async function drainOnce(
	entryPath: string,
	deps: DrainDeps,
): Promise<{ written: string[]; skipped: number }> {
	const entry = JSON.parse(readFileSync(entryPath, "utf8")) as QueueEntry;
	// Throws PermanentDrainError when the transcript was GC'd — never retried.
	const turns = parseTranscript(entry.transcript);
	if (turns.length === 0) return { written: [], skipped: 0 };

	const resp = await deps.captureSession({
		turns,
		session: entry.session,
		cwd: entry.cwd,
		ts: entry.ts,
		source: "mnemosyne",
	});

	// moneta withheld its receipt for at least one learning (e.g. its own
	// storage write failed) — it will re-extract on the next attempt, so keep
	// this entry queued rather than routing a possibly-incomplete set to brain.
	if (resp.learnings.some((l) => l.reason === "capture_failed")) {
		throw new Error("moneta capture incomplete — retrying");
	}

	mkdirSync(deps.brainInboxDir, { recursive: true });
	const ledger = new Ledger(deps.ledgerDir);
	const written: string[] = [];
	let skipped = 0;
	for (const l of resp.learnings) {
		if (l.kind !== "decision" && l.kind !== "lesson") continue;
		if (l.reason === "below_min_confidence" || l.reason === "secret_detected")
			continue;
		const learning: Learning = {
			text: l.text,
			kind: l.kind,
			confidence: l.confidence,
			provenance: { session: entry.session, cwd: entry.cwd, ts: entry.ts },
			...(l.title ? { title: l.title } : {}),
		};
		const h = hashLearning(learning);
		if (ledger.has(h)) {
			skipped++;
			continue;
		}
		writeBrainDoc(learning, deps.brainInboxDir);
		ledger.add(h);
		written.push("brain");
	}
	return { written, skipped };
}

export type DrainSummary = { drained: number; dead: number; retried: number };

/**
 * Move a dead-lettered queue entry into `deadDir`. Tolerant of the entry
 * having already been claimed (and removed) by a concurrent drain between
 * this drain reading it and attempting to dead-letter it: returns `false`
 * instead of throwing when the source file is already gone.
 */
export function moveToDead(p: string, deadDir: string, f: string): boolean {
	mkdirSync(deadDir, { recursive: true });
	try {
		renameSync(p, join(deadDir, f));
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
		throw err;
	}
}

/**
 * True when `err` is the ENOENT thrown by reading the queue entry itself
 * (as opposed to, say, the session transcript it references) — i.e. a
 * concurrent drain claimed and removed this entry between `readdirSync`
 * listing it and this drain attempting to read it.
 */
export function isEntryClaimedByConcurrentDrain(
	err: unknown,
	entryPath: string,
): boolean {
	const e = err as NodeJS.ErrnoException;
	return e?.code === "ENOENT" && e.path === entryPath;
}

/**
 * Drain every `*.json` entry in `queueDir`, classifying failures:
 *   - success            → entry removed from the queue;
 *   - PermanentDrainError → entry moved to `deadDir` (never requeued);
 *   - claimed by a concurrent drain → skipped silently (breadcrumb only,
 *     not counted as drained/dead/retried);
 *   - any other error     → entry left in the queue for the next drain (retry).
 * Every failure writes a `drain: <file> failed: <reason>` breadcrumb to stderr.
 */
export async function drainQueue(
	queueDir: string,
	deadDir: string,
	deps: DrainDeps,
): Promise<DrainSummary> {
	const summary: DrainSummary = { drained: 0, dead: 0, retried: 0 };
	if (!existsSync(queueDir)) return summary;
	const log = deps.log ?? ((m: string) => process.stderr.write(m));
	for (const f of readdirSync(queueDir).filter((n) => n.endsWith(".json"))) {
		const p = join(queueDir, f);
		try {
			await drainOnce(p, deps);
			// force: another drain may have already removed this entry.
			rmSync(p, { force: true });
			summary.drained++;
		} catch (err) {
			if (isEntryClaimedByConcurrentDrain(err, p)) {
				log(`drain: ${f} already handled by a concurrent drain — skipping\n`);
				continue;
			}
			const reason = err instanceof Error ? err.message : String(err);
			if (err instanceof PermanentDrainError) {
				if (!moveToDead(p, deadDir, f)) {
					log(`drain: ${f} already handled by a concurrent drain — skipping\n`);
					continue;
				}
				summary.dead++;
				log(`drain: ${f} failed: ${reason} (discarded to dead/)\n`);
			} else {
				// transient (network / LLM / moneta) — leave for the next drain
				summary.retried++;
				log(`drain: ${f} failed: ${reason} (left for retry)\n`);
			}
		}
	}
	return summary;
}

const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * Take an exclusive drain lock via atomic `mkdirSync` so concurrent drains
 * (routine: the SessionStart hook backgrounds one on every session start)
 * serialize instead of racing each other's queue/dead-letter operations.
 *
 * Returns `true` if the lock was acquired (caller must release it in a
 * `finally`). Returns `false` if another drain currently holds a fresh
 * (< 10 min old) lock — the caller should exit without draining. A lock
 * older than that is assumed to be left behind by a crashed drain and is
 * taken over.
 */
export function acquireDrainLock(home: string): boolean {
	const lockDir = join(home, "drain.lock");
	const take = (): boolean => {
		try {
			mkdirSync(lockDir);
			writeFileSync(join(lockDir, "pid"), String(process.pid));
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
			throw err;
		}
	};
	if (take()) return true;
	// Lock exists — stale (crashed drain) or fresh (active drain)?
	let ageMs: number;
	try {
		ageMs = Date.now() - statSync(lockDir).mtimeMs;
	} catch (err) {
		// The lock vanished between our failed take() and this stat — the
		// other drain just finished. Race for it again rather than crash.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return take();
		throw err;
	}
	if (ageMs < STALE_LOCK_MS) return false;
	rmSync(lockDir, { recursive: true, force: true });
	return take();
}

/** Release the drain lock taken by {@link acquireDrainLock}. */
export function releaseDrainLock(home: string): void {
	rmSync(join(home, "drain.lock"), { recursive: true, force: true });
}

// Dead-lettered entries (permanent failures, e.g. GC'd temp-dir transcripts)
// are never retried, so without a cap `dead/` grows forever. Prune anything
// older than this on every drain; recent failures stay for inspection.
export const DEAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delete `dead/` entries whose mtime is older than `ttlMs`. Returns the number
 * pruned. Tolerant of a missing dir (returns 0) and of individual stat/unlink
 * races (skips that entry) so a prune never breaks a drain.
 */
export function pruneDead(
	deadDir: string,
	ttlMs = DEAD_TTL_MS,
	now = Date.now(),
): number {
	let files: string[];
	try {
		files = readdirSync(deadDir);
	} catch {
		return 0;
	}
	let pruned = 0;
	for (const f of files) {
		const p = join(deadDir, f);
		try {
			if (now - statSync(p).mtimeMs > ttlMs) {
				rmSync(p, { force: true });
				pruned++;
			}
		} catch {
			// vanished or unstattable — nothing to prune here
		}
	}
	return pruned;
}

/** Count `*.json` entries in `dir` (0 if the dir is absent). */
export function countEntries(dir: string): number {
	try {
		return readdirSync(dir).filter((n) => n.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

/** Age in ms of the oldest entry in `dir`, or null if empty/absent. */
export function oldestAgeMs(dir: string, now = Date.now()): number | null {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return null;
	}
	let oldest: number | null = null;
	for (const f of files) {
		try {
			const m = statSync(join(dir, f)).mtimeMs;
			if (oldest === null || m < oldest) oldest = m;
		} catch {
			// skip unstattable entry
		}
	}
	return oldest === null ? null : now - oldest;
}

async function main(): Promise<void> {
	const home = mnemosyneHome();
	if (!existsSync(home)) return;
	const queueDir = join(home, "queue");
	const deadDir = join(home, "dead");
	// The SessionStart hook backgrounds a drain on every session start, so
	// concurrent drains are routine — serialize on a lock instead of racing.
	if (!acquireDrainLock(home)) {
		process.stderr.write("drain: another drain is active — exiting\n");
		return;
	}
	try {
		const { replayOutbox, replayLegacyOutbox, captureSession } = await import(
			"./monetaWriter.js"
		);
		const { brainInboxDir: defaultInbox } = await import("./config.js");
		// Replay/migrate spooled captures FIRST: these are already-extracted
		// payloads that need only a POST (no LLM), so they must never sit behind
		// the transcript queue. Delete a spool file only on a confirmed 2xx; a
		// still-failing capture stays for the next drain (moneta dedupes
		// server-side, so re-posts are safe).
		const outbox = await replayOutbox();
		// Convert + migrate anything still spooled in the legacy mem0 outbox,
		// same 2xx-or-keep contract. No-op once the directory is empty or gone.
		const legacy = await replayLegacyOutbox();
		// Cap the dead-letter directory so permanent failures don't accumulate
		// forever (see pruneDead / DEAD_TTL_MS).
		const deadPruned = pruneDead(deadDir);
		// Breadcrumbs from a failed entry go to the log file only; the one
		// summary line below goes to both the log and the terminal, so a manual
		// `mnemosyne drain` prints a single line instead of thousands.
		const logToFile = (msg: string) => {
			try {
				appendFileSync(join(home, "drain.log"), msg);
			} catch {
				// log best-effort; never fail the drain on a logging error
			}
		};
		// Transcript queue: extraction/embedding is now moneta's job
		// (/capture-session) — mnemosyne only posts turns and routes the
		// returned decision/lesson learnings to the second-brain inbox.
		const queue = await drainQueue(queueDir, deadDir, {
			captureSession,
			brainInboxDir: defaultInbox(),
			ledgerDir: join(home, "processed"),
			log: logToFile,
		});
		const summary =
			`drain: moneta-outbox replayed=${outbox.replayed} kept=${outbox.kept}; ` +
			`legacy-outbox replayed=${legacy.replayed} kept=${legacy.kept} skipped=${legacy.skipped}; ` +
			`dead pruned=${deadPruned}; ` +
			`queue drained=${queue.drained} dead=${queue.dead} retried=${queue.retried}\n`;
		logToFile(summary);
		process.stdout.write(summary);
	} finally {
		releaseDrainLock(home);
	}
}

// ─── agent-agnostic hook entrypoint ─────────────────────────────────────────
// Installed configs across agents all invoke `mnemosyne hook <agent> <event>`
// (see src/agents.ts). Behavior is fail-open end to end: a hook must never
// break a session, so every path resolves to exit 0 with agent-safe stdout.

export type HookDeps = {
	home: string;
	kickDrain: () => void;
	recall: (query: string) => Promise<{ content: string }[] | null>;
};

const RECALL_TOP_K = 5;

function recallBlock(project: string, results: { content: string }[]): string {
	const shown = Math.min(RECALL_TOP_K, results.length);
	const lines = [
		`Recalled ${results.length} memories for ${project} — top ${shown}:`,
	];
	for (const [i, r] of results.slice(0, RECALL_TOP_K).entries()) {
		const one = r.content.split(/\s+/).join(" ").trim();
		if (one)
			lines.push(
				`${i + 1}. ${one.length > 200 ? `${one.slice(0, 199).trimEnd()}…` : one}`,
			);
	}
	return lines.length > 1 ? lines.join("\n") : "";
}

export async function handleHook(
	agent: import("./agents.js").AgentId,
	event: string,
	stdin: string,
	deps: HookDeps,
): Promise<string> {
	const { normalizePayload, renderInjection } = await import("./agents.js");
	const io = { home: deps.home };
	const p = normalizePayload(agent, stdin, io);

	if (event === "enqueue") {
		if (p.transcript) {
			const queueDir = join(mnemosyneHome(), "queue");
			mkdirSync(queueDir, { recursive: true });
			const stamp = new Date()
				.toISOString()
				.replace(/[-:]/g, "")
				.replace(/\..*/, "");
			writeFileSync(
				join(queueDir, `${stamp}-${p.session}.json`),
				JSON.stringify({
					transcript: p.transcript,
					session: p.session,
					cwd: p.cwd,
					ts: new Date().toISOString(),
					agent,
				}),
			);
		}
		// cursor rejects empty stdout on some events; a bare object is inert
		return agent === "cursor" ? "{}" : "";
	}

	// session-start: kick a background drain, then inject recall context.
	try {
		deps.kickDrain();
	} catch {
		// fail-open
	}
	const project = p.cwd.replace(/\/+$/, "").split("/").pop() || p.cwd;
	let block = "";
	try {
		const results = await deps.recall(project);
		if (results?.length) block = recallBlock(project, results);
	} catch {
		// fail-open
	}
	if (!block) return agent === "cursor" ? renderInjection("cursor", "") : "";
	return renderInjection(agent, block);
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	try {
		for await (const c of process.stdin) chunks.push(c as Buffer);
	} catch {
		// fail-open
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function hookMain(): Promise<void> {
	const agentArg = process.argv[3] ?? "";
	const event = process.argv[4] ?? "";
	const { AGENTS } = await import("./agents.js");
	if (!(agentArg in AGENTS)) return; // unknown agent → silent fail-open
	const { homedir } = await import("node:os");
	const { recallMoneta } = await import("./monetaWriter.js");
	const out = await handleHook(
		agentArg as import("./agents.js").AgentId,
		event,
		await readStdin(),
		{
			home: homedir(),
			kickDrain: () => {
				const self = process.argv[1] ?? "mnemosyne";
				const child = spawn(process.execPath, [self, "drain"], {
					detached: true,
					stdio: "ignore",
				});
				child.unref();
			},
			recall: (q) => recallMoneta(q, RECALL_TOP_K),
		},
	);
	if (out) process.stdout.write(`${out}\n`);
}

async function installMain(): Promise<void> {
	const { installHooks, detectAgents } = await import("./agents.js");
	const { homedir } = await import("node:os");
	const dryRun = process.argv.includes("--dry-run");
	const detected = detectAgents({ home: homedir() });
	if (!detected.length) {
		process.stdout.write("install-hooks: no supported agents detected\n");
		return;
	}
	for (const r of installHooks({ home: homedir() }, dryRun)) {
		const state = r.changed
			? dryRun
				? "would install"
				: "installed"
			: "already wired";
		process.stdout.write(
			`${r.agent}: ${state}${r.notes.length ? ` (${r.notes.join("; ")})` : ""}\n`,
		);
	}
}

async function agentsMain(): Promise<void> {
	const { AGENTS, detectAgents } = await import("./agents.js");
	const { homedir } = await import("node:os");
	const found = new Set(detectAgents({ home: homedir() }));
	for (const id of Object.keys(AGENTS))
		process.stdout.write(
			`${id}: ${found.has(id as import("./agents.js").AgentId) ? "detected" : "not found"}\n`,
		);
}

// ─── status ─────────────────────────────────────────────────────────────────
// `mnemosyne status`: a terse snapshot of the local spool + the moneta total,
// so the backlog is inspectable without eyeballing directory listings.

function fmtAge(ms: number | null): string {
	if (ms === null) return "—";
	const d = Math.floor(ms / 86_400_000);
	const h = Math.floor((ms % 86_400_000) / 3_600_000);
	return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

async function statusMain(): Promise<void> {
	const home = mnemosyneHome();
	const { monetaCount } = await import("./monetaWriter.js");
	const dead = countEntries(join(home, "dead"));
	const lines = [
		`mnemosyne status (${home})`,
		`  queue (awaiting drain):          ${countEntries(join(home, "queue"))}`,
		`  moneta-outbox (to replay):       ${countEntries(join(home, "moneta-outbox"))}`,
		`  legacy mem0 outbox (to migrate): ${countEntries(join(home, "outbox"))}`,
		`  dead (permanent failures):       ${dead}${
			dead
				? ` (oldest ${fmtAge(oldestAgeMs(join(home, "dead")))}, TTL ${DEAD_TTL_MS / 86_400_000}d)`
				: ""
		}`,
		`  drain lock:                      ${existsSync(join(home, "drain.lock")) ? "held" : "free"}`,
	];
	const total = await monetaCount();
	lines.push(
		`  moneta total entries:            ${total === null ? "unreachable" : total}`,
	);
	process.stdout.write(`${lines.join("\n")}\n`);
}

const command = process.argv[2];
if (command === "drain") void main();
else if (command === "status") void statusMain();
else if (command === "hook") void hookMain();
else if (command === "install-hooks") void installMain();
else if (command === "agents") void agentsMain();
