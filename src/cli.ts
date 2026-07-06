#!/usr/bin/env node
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { brainInboxDir as defaultInbox, mnemosyneHome } from "./config.js";
import { dispatch } from "./dispatch.js";
import { extract } from "./extract.js";
import { hashLearning, Ledger } from "./ledger.js";
import type { LLMDeps } from "./llm.js";
import type { Target } from "./policy.js";
import type { Provenance } from "./types.js";

export type DrainDeps = {
	llm?: LLMDeps;
	writeMem0: (json: string) => Promise<void>;
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
			writeMem0: deps.writeMem0,
			brainInboxDir: deps.brainInboxDir,
		});
		ledger.add(h);
		written.push(...targets);
	}
	return { written, skipped };
}

async function main(): Promise<void> {
	const home = mnemosyneHome();
	const queueDir = join(home, "queue");
	if (!existsSync(queueDir)) return;
	const { spawnMem0Add } = await import("./mem0Writer.js");
	const deps: DrainDeps = {
		writeMem0: spawnMem0Add,
		brainInboxDir: defaultInbox(),
		ledgerDir: join(home, "processed"),
	};
	for (const f of readdirSync(queueDir).filter((n) => n.endsWith(".json"))) {
		const p = join(queueDir, f);
		try {
			await drainOnce(p, deps);
			rmSync(p);
		} catch {
			// leave the queue entry for the next drain (fail-safe)
		}
	}
}

if (process.argv[2] === "drain") void main();
