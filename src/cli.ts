#!/usr/bin/env node
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
		const { writeMoneta, replayOutbox } = await import("./monetaWriter.js");
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
		// One summary line per drain (stderr, same stream as the failure
		// breadcrumbs, so drain.log tells the whole story).
		process.stderr.write(
			`drain: queue drained=${queue.drained} dead=${queue.dead} retried=${queue.retried}; ` +
				`moneta-outbox replayed=${outbox.replayed} kept=${outbox.kept}\n`,
		);
	} finally {
		releaseDrainLock(home);
	}
}

if (process.argv[2] === "drain") void main();
