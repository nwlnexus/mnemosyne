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
// /capture endpoint and is FAIL-OPEN: any failure spools
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
			// NEVER follow redirects: when the CF Access service token is
			// invalid/expired, the edge 302s to the Access login page, and a
			// followed redirect lands on that page's 200 — which read as success
			// and silently deleted outbox files. Manual mode surfaces the 302
			// itself, so res.ok is false and the capture stays spooled.
			redirect: "manual",
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

export type ReplaySummary = { replayed: number; kept: number };

// Replay spooled captures. Delete a file ONLY on a confirmed 2xx; leave it
// otherwise (idempotent + fail-safe — moneta dedupes server-side, so a
// re-post of an already-stored capture is harmless). Returns how many files
// were delivered-and-removed vs kept for the next drain.
export async function replayOutbox(): Promise<ReplaySummary> {
	const summary: ReplaySummary = { replayed: 0, kept: 0 };
	let files: string[];
	try {
		files = readdirSync(monetaOutboxDir()).filter((n) => n.endsWith(".json"));
	} catch {
		return summary; // no outbox yet → nothing to replay
	}
	for (const f of files) {
		const p = join(monetaOutboxDir(), f);
		let json: string;
		try {
			json = readFileSync(p, "utf8");
		} catch {
			continue;
		}
		if (await postCapture(json)) {
			rmSync(p);
			summary.replayed++;
		} else {
			summary.kept++;
		}
	}
	return summary;
}

// --- legacy mem0 outbox migration -----------------------------------------

function legacyOutboxDir(): string {
	const home =
		process.env.MNEMOSYNE_HOME ?? join(homedir(), ".claude", "mnemosyne");
	return join(home, "outbox");
}

// Entries spooled before the mem0 retirement are mem0-API-shaped
// ({ user_id, text, infer, app, metadata }). Convert to a moneta capture, or
// null when the entry has no usable text (malformed JSON, empty text) — those
// can never succeed and are counted as skipped rather than retried forever.
function convertLegacyPayload(raw: string): string | null {
	try {
		const o = JSON.parse(raw) as {
			text?: unknown;
			metadata?: Record<string, unknown>;
		};
		const text = typeof o.text === "string" && o.text.trim() ? o.text : null;
		if (!text) return null;
		const metadata =
			o.metadata && typeof o.metadata === "object" ? o.metadata : {};
		const kind = metadata.kind;
		const tags = ["mnemosyne", ...(typeof kind === "string" ? [kind] : [])];
		return JSON.stringify({
			content: text,
			tags,
			source: "mnemosyne",
			metadata,
		});
	} catch {
		return null;
	}
}

export type LegacyReplaySummary = ReplaySummary & { skipped: number };

// Drain the legacy mem0 outbox into moneta under the same
// confirmed-2xx-or-keep contract as replayOutbox. No-op when the directory
// does not exist — hosts that never dual-wrote (or finished migrating and
// deleted it) pay nothing.
export async function replayLegacyOutbox(): Promise<LegacyReplaySummary> {
	const summary: LegacyReplaySummary = { replayed: 0, kept: 0, skipped: 0 };
	let files: string[];
	try {
		files = readdirSync(legacyOutboxDir()).filter((n) => n.endsWith(".json"));
	} catch {
		return summary;
	}
	for (const f of files) {
		const p = join(legacyOutboxDir(), f);
		let raw: string;
		try {
			raw = readFileSync(p, "utf8");
		} catch {
			continue;
		}
		const capture = convertLegacyPayload(raw);
		if (capture === null) {
			summary.skipped++;
			continue;
		}
		if (await postCapture(capture)) {
			rmSync(p);
			summary.replayed++;
		} else {
			summary.kept++;
		}
	}
	return summary;
}

// ─── recall (read path) ──────────────────────────────────────────────────────

export type RecallResult = { content: string };

// GET /recall with insight=false (skips moneta's ~5s LLM prose synthesis —
// machine callers never show it). Same token/Access resolution and
// never-follow-redirects contract as the capture path. Fail-open: any
// problem returns null so a session start can never break on recall.
export async function recallMoneta(
	query: string,
	topK = 5,
): Promise<RecallResult[] | null> {
	const token = resolveToken();
	if (!token) return null;
	try {
		const u = new URL(`${monetaUrl()}/recall`);
		u.searchParams.set("q", query);
		u.searchParams.set("topK", String(topK));
		u.searchParams.set("insight", "false");
		const res = await fetch(u, {
			headers: {
				authorization: `Bearer ${token}`,
				...resolveAccessHeaders(),
			},
			redirect: "manual",
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { results?: unknown };
		if (!Array.isArray(data.results)) return null;
		return data.results.filter(
			(r): r is RecallResult =>
				!!r && typeof (r as RecallResult).content === "string",
		);
	} catch {
		return null;
	}
}
