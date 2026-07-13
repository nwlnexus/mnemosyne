import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// moneta is olympus's memory Worker. This writer POSTs learnings to its
// /capture endpoint and, like the mem0 path, is FAIL-OPEN: any failure spools
// the payload to an outbox and returns so a capture can never break the hook
// pipeline. The CLI `drain` path replays the outbox on its next run.

const DEFAULT_URL = "https://mem.nwlnexus.io";

function monetaUrl(): string {
	return process.env.MONETA_URL ?? DEFAULT_URL;
}

// Bearer token resolution (token itself is provisioned out-of-band by
// nix-darwin-hm — see README), in priority order:
//   1. MONETA_AUTH_TOKEN env var
//   2. file at MONETA_TOKEN_FILE (default ~/.config/moneta/token), trimmed
function resolveToken(): string | null {
	const fromEnv = process.env.MONETA_AUTH_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	const file =
		process.env.MONETA_TOKEN_FILE ??
		join(homedir(), ".config", "moneta", "token");
	try {
		return readFileSync(file, "utf8").trim() || null;
	} catch {
		return null;
	}
}

// Cloudflare Access Service Auth (required at the edge once moneta-access is
// live). nix-darwin-hm provisions CF_ACCESS_CLIENT_ID/SECRET from 1Password.
function resolveAccessHeaders(): Record<string, string> {
	const id = process.env.CF_ACCESS_CLIENT_ID?.trim();
	const secret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();
	if (!id || !secret) return {};
	return {
		"CF-Access-Client-Id": id,
		"CF-Access-Client-Secret": secret,
	};
}

export function monetaOutboxDir(): string {
	const home =
		process.env.MNEMOSYNE_HOME ?? join(homedir(), ".claude", "mnemosyne");
	return join(home, "moneta-outbox");
}

// Single POST used by BOTH writeMoneta and replayOutbox so a replay failure
// never re-spools content that is already on disk. Returns true only on 2xx;
// swallows every error (missing token, network, non-2xx) into `false`.
export async function postCapture(json: string): Promise<boolean> {
	const token = resolveToken();
	if (!token) return false;
	try {
		const res = await fetch(`${monetaUrl()}/capture`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				...resolveAccessHeaders(),
			},
			body: json,
		});
		return res.ok;
	} catch {
		return false;
	}
}

function spool(json: string): void {
	const dir = monetaOutboxDir();
	mkdirSync(dir, { recursive: true });
	// Content hash → filename: unique per distinct payload (mirrors the brain
	// inbox's slug-hash scheme) and idempotent — re-spooling identical content
	// overwrites rather than duplicating.
	const name = createHash("sha256").update(json).digest("hex").slice(0, 32);
	writeFileSync(join(dir, `${name}.json`), json);
}

// FAIL-OPEN writer: post the capture, spooling to the outbox on any failure.
export async function writeMoneta(json: string): Promise<void> {
	if (await postCapture(json)) return;
	spool(json);
}

// Replay spooled captures. Delete a file ONLY on a confirmed 2xx; leave it
// otherwise (idempotent + fail-safe — moneta dedupes server-side, so a
// re-post of an already-stored capture is harmless).
export async function replayOutbox(): Promise<void> {
	let files: string[];
	try {
		files = readdirSync(monetaOutboxDir()).filter((n) => n.endsWith(".json"));
	} catch {
		return; // no outbox yet → nothing to replay
	}
	for (const f of files) {
		const p = join(monetaOutboxDir(), f);
		let json: string;
		try {
			json = readFileSync(p, "utf8");
		} catch {
			continue;
		}
		if (await postCapture(json)) rmSync(p);
	}
}
