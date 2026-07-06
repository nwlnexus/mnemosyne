import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Learning } from "./types.js";

export function hashLearning(l: Learning): string {
	const norm = l.text.replace(/\s+/g, " ").trim().toLowerCase();
	return createHash("sha256")
		.update(`${l.kind}\n${norm}`)
		.digest("hex")
		.slice(0, 32);
}

export class Ledger {
	constructor(private readonly dir: string) {
		mkdirSync(dir, { recursive: true });
	}
	has(hash: string): boolean {
		return existsSync(join(this.dir, hash));
	}
	add(hash: string): void {
		writeFileSync(join(this.dir, hash), "");
	}
}
