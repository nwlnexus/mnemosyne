#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
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
import { brainInboxDir as defaultInbox, mnemosyneHome } from "./config.js";
import { dispatch } from "./dispatch.js";
import { PermanentDrainError } from "./errors.js";
import { extract } from "./extract.js";
import { hashLearning, Ledger } from "./ledger.js";
import type { LLMDeps } from "./llm.js";
import type { Target } from "./policy.js";
import type { Provenance } from "./types.js";

export type DrainDeps = {
	llm?: LLMDeps;
	writeMoneta: (json: string) => Promise<void>;
	brainInboxDir: string;
	ledgerDir: string;
};

type QueueEntry = {
	transcript: string;
	session: string;
	cwd: string;
	ts: string;
};

export async function drainOnce(
	entryPath: string,
	deps: DrainDeps,
): Promise<{ written: Target[]; skipped: number }> {
	const entry = JSON.parse(readFileSync(entryPath, "utf8")) as QueueEntry;
	const prov: Provenance = {
		session: entry.session,
		cwd: entry.cwd,
		ts: entry.ts,
	};
	mkdirSync(deps.brainInboxDir, { recursive: true });
	const ledger = new Ledger(deps.ledgerDir);
	const learnings = await extract(entry.transcript, prov, deps.llm);
	const written: Target[] = [];
	let skipped = 0;
	for (const l of learnings) {
		const h = hashLearning(l);
		if (ledger.has(h)) {
			skipped++;
			continue;
		}
		const targets = await dispatch(l, {
			writeMoneta: deps.writeMoneta,
			brainInboxDir: deps.brainInboxDir,
		});
		ledger.add(h);
		written.push(...targets);
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
	for (const f of readdirSync(queueDir).filter((n) => n.endsWith(".json"))) {
		const p = join(queueDir, f);
		try {
			await drainOnce(p, deps);
			// force: another drain may have already removed this entry.
			rmSync(p, { force: true });
			summary.drained++;
		} catch (err) {
			if (isEntryClaimedByConcurrentDrain(err, p)) {
				process.stderr.write(
					`drain: ${f} already handled by a concurrent drain — skipping\n`,
				);
				continue;
			}
			const reason = err instanceof Error ? err.message : String(err);
			if (err instanceof PermanentDrainError) {
				if (!moveToDead(p, deadDir, f)) {
					process.stderr.write(
						`drain: ${f} already handled by a concurrent drain — skipping\n`,
					);
					continue;
				}
				summary.dead++;
				process.stderr.write(
					`drain: ${f} failed: ${reason} (discarded to dead/)\n`,
				);
			} else {
				// transient (network / LLM / moneta) — leave for the next drain
				summary.retried++;
				process.stderr.write(
					`drain: ${f} failed: ${reason} (left for retry)\n`,
				);
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

async function main(): Promise<void> {
	const home = mnemosyneHome();
	const queueDir = join(home, "queue");
	const deadDir = join(home, "dead");
	if (!existsSync(queueDir)) return;
	// The SessionStart hook backgrounds a drain on every session start, so
	// concurrent drains are routine — serialize on a lock instead of racing.
	if (!acquireDrainLock(home)) {
		process.stderr.write("drain: another drain is active — exiting\n");
		return;
	}
	try {
		const { writeMoneta, replayOutbox, replayLegacyOutbox } = await import(
			"./monetaWriter.js"
		);
		const deps: DrainDeps = {
			writeMoneta,
			brainInboxDir: defaultInbox(),
			ledgerDir: join(home, "processed"),
		};
		const queue = await drainQueue(queueDir, deadDir, deps);
		// Retry any captures that previously failed and were spooled. Deletes a
		// spool file only on confirmed 2xx; a still-failing capture stays for
		// the next drain (moneta dedupes server-side, so re-posts are safe).
		const outbox = await replayOutbox();
		// Also migrate anything still spooled in the legacy mem0 outbox —
		// converted to moneta captures, same 2xx-or-keep contract. No-op once
		// the directory is empty or gone.
		const legacy = await replayLegacyOutbox();
		// One summary line per drain (stderr, same stream as the failure
		// breadcrumbs, so drain.log tells the whole story).
		process.stderr.write(
			`drain: queue drained=${queue.drained} dead=${queue.dead} retried=${queue.retried}; ` +
				`moneta-outbox replayed=${outbox.replayed} kept=${outbox.kept}; ` +
				`legacy-outbox replayed=${legacy.replayed} kept=${legacy.kept} skipped=${legacy.skipped}\n`,
		);
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

const command = process.argv[2];
if (command === "drain") void main();
else if (command === "hook") void hookMain();
else if (command === "install-hooks") void installMain();
else if (command === "agents") void agentsMain();
